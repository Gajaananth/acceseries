alter table public.application_settings
  add column if not exists early_settlement_discount_type text not null default 'fixed'
    check (early_settlement_discount_type in ('fixed', 'interest_percentage')),
  add column if not exists early_settlement_fixed_discount numeric(12,2) not null default 0
    check (early_settlement_fixed_discount >= 0),
  add column if not exists early_settlement_interest_discount_percent integer not null default 0
    check (early_settlement_interest_discount_percent between 0 and 100);

alter table public.agreements
  drop constraint if exists agreements_status_check;
alter table public.agreements
  add constraint agreements_status_check
  check (status in ('approved', 'pending_approval', 'settled', 'settled_early'));

insert into public.permissions (key, description) values
  ('discounts:read', 'View discount requests and approved discounts'),
  ('discounts:request', 'Request product, customer, and early-settlement discounts'),
  ('discounts:approve', 'Approve or reject discount requests')
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.key in ('discounts:read', 'discounts:request')
where r.name = 'staff'
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.key in ('discounts:read', 'discounts:request', 'discounts:approve')
where r.name = 'owner'
on conflict do nothing;

create table if not exists public.discount_requests (
  id uuid primary key default gen_random_uuid(),
  discount_type text not null check (discount_type in ('product', 'customer', 'early_settlement')),
  amount numeric(12,2) not null check (amount >= 0),
  reason text not null check (length(btrim(reason)) between 2 and 500),
  customer_id uuid references public.customers(id) on delete restrict,
  agreement_id uuid references public.agreements(id) on delete restrict,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'applied', 'settled_early')),
  requested_by uuid not null references auth.users(id) on delete restrict,
  approved_by uuid references auth.users(id) on delete restrict,
  decision_at timestamptz,
  decision_reason text,
  approved_at timestamptz,
  applied_at timestamptz,
  applied_to_sale_id uuid references public.sales(id) on delete restrict,
  applied_to_agreement_id uuid references public.agreements(id) on delete restrict,
  payment_id uuid references public.payments(id) on delete restrict,
  applied_idempotency_key text,
  applied_request_hash text,
  early_discount_type text check (early_discount_type in ('fixed', 'interest_percentage')),
  early_fixed_discount numeric(12,2),
  early_interest_discount_percent integer check (early_interest_discount_percent between 0 and 100),
  quoted_principal numeric(12,2),
  quoted_interest numeric(12,2),
  quoted_late_fees numeric(12,2),
  quoted_settlement_amount numeric(12,2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (discount_type = 'early_settlement' and agreement_id is not null and customer_id is null)
    or (discount_type in ('product', 'customer') and agreement_id is null)
  ),
  check (discount_type <> 'customer' or customer_id is not null)
);
alter table public.discount_requests
  add column if not exists decision_at timestamptz;

create index if not exists discount_requests_status_created_idx
  on public.discount_requests (status, created_at desc);
create index if not exists discount_requests_requester_idx
  on public.discount_requests (requested_by, created_at desc);
create index if not exists discount_requests_agreement_idx
  on public.discount_requests (agreement_id)
  where agreement_id is not null;

alter table public.discount_requests enable row level security;
drop policy if exists "Users can read permitted discount requests" on public.discount_requests;
create policy "Users can read permitted discount requests" on public.discount_requests
  for select to authenticated
  using (
    public.has_permission('discounts:read')
    and (
      public.is_owner()
      or requested_by = auth.uid()
      or (status = 'approved' and applied_at is null)
    )
  );

create table if not exists public.early_settlement_interest_discounts (
  id uuid primary key default gen_random_uuid(),
  discount_request_id uuid not null references public.discount_requests(id) on delete restrict,
  agreement_schedule_id uuid not null references public.agreement_schedule(id) on delete restrict,
  amount numeric(12,2) not null check (amount > 0),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (discount_request_id, agreement_schedule_id)
);

alter table public.early_settlement_interest_discounts enable row level security;

alter table public.late_fee_records
  add column if not exists fee_type text,
  add column if not exists fee_date date,
  add column if not exists reason text,
  add column if not exists waived_by uuid references auth.users(id) on delete restrict;

update public.late_fee_records
set fee_type = 'legacy',
    fee_date = assessed_at::date
where fee_type is null or fee_date is null;

alter table public.late_fee_records
  alter column fee_type set not null,
  alter column fee_date set not null,
  drop constraint if exists late_fee_records_fee_type_check,
  add constraint late_fee_records_fee_type_check
    check (fee_type in ('legacy', 'fixed', 'daily', 'waiver'));

create or replace function public.prevent_late_fee_record_mutation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'LATE_FEE_RECORDS_ARE_APPEND_ONLY' using errcode = '55000';
end;
$$;

drop trigger if exists late_fee_records_append_only on public.late_fee_records;
create trigger late_fee_records_append_only
before update or delete on public.late_fee_records
for each row execute function public.prevent_late_fee_record_mutation();

drop index if exists public.late_fee_records_schedule_key;
create unique index if not exists late_fee_records_schedule_fee_day_key
  on public.late_fee_records (agreement_schedule_id, fee_type, fee_date)
  where agreement_schedule_id is not null;
create unique index if not exists late_fee_records_installment_fee_day_key
  on public.late_fee_records (installment_id, fee_type, fee_date)
  where installment_id is not null;
create index if not exists late_fee_records_schedule_type_idx
  on public.late_fee_records (agreement_schedule_id, fee_type, fee_date)
  where agreement_schedule_id is not null;

create or replace function public.calculate_schedule_late_fee(
  p_due_date date,
  p_grace_period_days integer,
  p_fixed_late_fee numeric,
  p_daily_late_fee numeric,
  p_maximum_late_fee numeric,
  p_as_of date default current_date
)
returns numeric(12,2)
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_as_of <= p_due_date + p_grace_period_days then 0::numeric(12,2)
    else least(
      p_maximum_late_fee,
      p_fixed_late_fee + p_daily_late_fee *
        (p_as_of - (p_due_date + p_grace_period_days))
    )::numeric(12,2)
  end;
$$;

comment on function public.calculate_schedule_late_fee(date, integer, numeric, numeric, numeric, date) is
  'Due date is day zero; grace days are not charged; the first chargeable date is due_date + grace_days + 1 and p_as_of is inclusive.';

create or replace function public.get_schedule_payment_state(
  p_schedule_id uuid,
  p_as_of date default current_date
)
returns table (
  principal_due numeric(12,2),
  interest_due numeric(12,2),
  late_fee_total numeric(12,2),
  late_fee_paid numeric(12,2),
  principal_paid numeric(12,2),
  interest_paid numeric(12,2)
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with schedule as (
    select
      s.id,
      s.amount,
      s.interest_amount,
      coalesce(paid.late_fee_paid, 0) as late_fee_paid,
      coalesce(paid.interest_paid, 0) as interest_paid,
      coalesce(paid.principal_paid, 0) as principal_paid,
      coalesce(fees.assessed_fees, 0) as assessed_fees,
      coalesce(fees.waived_fees, 0) as waived_fees,
      coalesce(discounts.interest_discount, 0) as interest_discount
    from public.agreement_schedule s
    left join lateral (
      select
        coalesce(sum(pa.amount) filter (where pa.allocation_type = 'late_fee'), 0) as late_fee_paid,
        coalesce(sum(pa.amount) filter (where pa.allocation_type = 'interest'), 0) as interest_paid,
        coalesce(sum(pa.amount) filter (where pa.allocation_type = 'principal'), 0) as principal_paid
      from public.payment_allocations pa
      join public.payments p on p.id = pa.payment_id and p.reversed_at is null
      where pa.agreement_schedule_id = s.id
    ) paid on true
    left join lateral (
      select
        coalesce(sum(lfr.amount) filter (where lfr.fee_type in ('legacy', 'fixed', 'daily')), 0) as assessed_fees,
        coalesce(sum(lfr.amount) filter (where lfr.fee_type = 'waiver'), 0) as waived_fees
      from public.late_fee_records lfr
        where lfr.agreement_schedule_id = s.id and lfr.fee_date <= p_as_of
    ) fees on true
    left join lateral (
      select coalesce(sum(discount.amount), 0) as interest_discount
      from public.early_settlement_interest_discounts discount
      where discount.agreement_schedule_id = s.id
    ) discounts on true
    where s.id = p_schedule_id
  )
  select
    greatest(0, schedule.amount - schedule.interest_amount - schedule.principal_paid)::numeric(12,2),
    greatest(0, schedule.interest_amount - schedule.interest_paid - schedule.interest_discount)::numeric(12,2),
    greatest(0, schedule.assessed_fees - schedule.waived_fees)::numeric(12,2),
    schedule.late_fee_paid::numeric(12,2),
    schedule.principal_paid::numeric(12,2),
    schedule.interest_paid::numeric(12,2)
  from schedule;
$$;

create or replace function public.assess_late_fees_for_agreement(
  p_agreement_id uuid,
  p_as_of date default current_date
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_schedule record;
  v_state record;
  v_start_date date;
  v_chargeable_days integer;
  v_fixed_exists boolean;
  v_legacy_date date;
  v_assessed numeric(12,2);
  v_waived numeric(12,2);
  v_next_fee numeric(12,2);
  v_fee_date date;
  v_inserted integer := 0;
  v_rows integer;
begin
  if coalesce(auth.role(), '') <> 'service_role'
      and (auth.uid() is null or not (
        public.has_permission('payments:write')
        or public.has_permission('discounts:approve')
        or public.has_permission('payments:read')
      )) then
    raise exception 'PAYMENT_PERMISSION_REQUIRED' using errcode = '42501';
  end if;

  perform 1 from public.agreements
  where id = p_agreement_id and status = 'approved'
  for update;
  if not found then return 0; end if;

  for v_schedule in
    select
      s.id,
      s.due_date,
      a.grace_period_days,
      a.fixed_late_fee,
      a.daily_late_fee,
      a.maximum_late_fee
    from public.agreement_schedule s
    join public.agreements a on a.id = s.agreement_id
    where s.agreement_id = p_agreement_id
    order by s.due_date, s.installment_number
    for update of s
  loop
    select * into v_state
    from public.get_schedule_payment_state(v_schedule.id, p_as_of);

    if v_state.principal_due + v_state.interest_due
        + greatest(0, v_state.late_fee_total - v_state.late_fee_paid) <= 0 then
      continue;
    end if;

    v_chargeable_days := greatest(
      0,
      p_as_of - v_schedule.due_date - v_schedule.grace_period_days
    );
    if v_chargeable_days = 0 then continue; end if;

    select
      coalesce(sum(lfr.amount) filter (where lfr.fee_type in ('legacy', 'fixed', 'daily')), 0),
      coalesce(sum(lfr.amount) filter (where lfr.fee_type = 'waiver'), 0),
      bool_or(lfr.fee_type in ('legacy', 'fixed')),
      max(lfr.fee_date) filter (where lfr.fee_type = 'legacy')
    into v_assessed, v_waived, v_fixed_exists, v_legacy_date
    from public.late_fee_records lfr
    where lfr.agreement_schedule_id = v_schedule.id;
    v_assessed := coalesce(v_assessed, 0);
    v_waived := coalesce(v_waived, 0);
    v_fixed_exists := coalesce(v_fixed_exists, false);

    v_start_date := v_schedule.due_date + v_schedule.grace_period_days + 1;
    if v_legacy_date is not null then
      v_start_date := greatest(v_start_date, v_legacy_date + 1);
    end if;

    if not v_fixed_exists and v_schedule.fixed_late_fee > 0
        and v_assessed < v_schedule.maximum_late_fee then
      v_next_fee := least(
        v_schedule.fixed_late_fee,
        greatest(0, v_schedule.maximum_late_fee - v_assessed)
      );
      if v_next_fee > 0 then
        insert into public.late_fee_records (
          agreement_schedule_id, installment_id, amount, fee_type, fee_date, assessed_at, created_by
        ) values (
          v_schedule.id, null, v_next_fee, 'fixed',
          v_schedule.due_date + v_schedule.grace_period_days + 1,
          now(), nullif(auth.uid()::text, '')::uuid
        )
        on conflict (agreement_schedule_id, fee_type, fee_date)
          where agreement_schedule_id is not null
        do nothing;
        get diagnostics v_rows = row_count;
        v_inserted := v_inserted + v_rows;
        if v_rows > 0 then v_assessed := v_assessed + v_next_fee; end if;
      end if;
    end if;

    if v_schedule.daily_late_fee <= 0 or v_schedule.maximum_late_fee <= v_assessed then
      continue;
    end if;
    for v_fee_date in
      select day_value::date
      from generate_series(v_start_date::timestamp, p_as_of::timestamp, interval '1 day')
        as dates(day_value)
    loop
      if exists (
        select 1 from public.late_fee_records lfr
        where lfr.agreement_schedule_id = v_schedule.id
          and lfr.fee_type = 'daily'
          and lfr.fee_date = v_fee_date
      ) then
        continue;
      end if;
      v_next_fee := least(
        v_schedule.daily_late_fee,
        greatest(0, v_schedule.maximum_late_fee - v_assessed)
      );
      if v_next_fee <= 0 then exit; end if;

      insert into public.late_fee_records (
        agreement_schedule_id, installment_id, amount, fee_type, fee_date, assessed_at, created_by
      ) values (
        v_schedule.id, null, v_next_fee, 'daily', v_fee_date, now(),
        nullif(auth.uid()::text, '')::uuid
      )
      on conflict (agreement_schedule_id, fee_type, fee_date)
        where agreement_schedule_id is not null
      do nothing;
      get diagnostics v_rows = row_count;
      v_inserted := v_inserted + v_rows;
      if v_rows > 0 then v_assessed := v_assessed + v_next_fee; end if;
    end loop;
  end loop;
  return v_inserted;
end;
$$;

create or replace function public.assess_all_late_fees(p_as_of date default current_date)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_agreement_id uuid;
  v_inserted integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;
  for v_agreement_id in
    select id from public.agreements where status = 'approved' order by id
  loop
    v_inserted := v_inserted + public.assess_late_fees_for_agreement(v_agreement_id, p_as_of);
  end loop;
  return v_inserted;
end;
$$;

create or replace function public.get_late_payments()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
begin
  if auth.uid() is null or not public.has_permission('payments:read') then
    raise exception 'PAYMENT_PERMISSION_REQUIRED' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'schedule_id', s.id,
      'agreement_id', a.id,
      'customer_id', customer.id,
      'customer_name', customer.full_name,
      'phone', customer.phone,
      'installment_number', s.installment_number,
      'due_date', s.due_date,
      'days_overdue', current_date - s.due_date,
      'principal_due', state.principal_due::text,
      'interest_due', state.interest_due::text,
      'late_fee_due', greatest(0, state.late_fee_total - state.late_fee_paid)::text
    )
    order by s.due_date, customer.full_name, s.installment_number
  ), '[]'::jsonb)
  into v_result
  from public.agreement_schedule s
  join public.agreements a on a.id = s.agreement_id and a.status = 'approved'
  join public.customers customer on customer.id = a.customer_id
  cross join lateral public.get_schedule_payment_state(s.id) state
  where s.due_date + a.grace_period_days < current_date
    and state.principal_due + state.interest_due
      + greatest(0, state.late_fee_total - state.late_fee_paid) > 0;
  return v_result;
end;
$$;

create or replace function public.waive_late_fee(
  p_schedule_id uuid,
  p_reason text,
  p_idempotency_key text,
  p_request_hash text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_saved_hash text;
  v_response jsonb;
  v_agreement_id uuid;
  v_state record;
  v_waiver_id uuid;
  v_amount numeric(12,2);
begin
  if auth.uid() is null or not public.is_owner() then
    raise exception 'OWNER_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  if length(btrim(p_reason)) < 2 or length(p_reason) > 500
      or length(p_idempotency_key) not between 1 and 200
      or length(p_request_hash) <> 64 then
    raise exception 'INVALID_LATE_FEE_WAIVER' using errcode = '22023';
  end if;

  insert into public.idempotency_records (user_id, operation, idempotency_key, request_hash)
  values (auth.uid(), 'waive_late_fee', p_idempotency_key, p_request_hash)
  on conflict do nothing;
  select request_hash, response into v_saved_hash, v_response
  from public.idempotency_records
  where user_id = auth.uid() and operation = 'waive_late_fee'
    and idempotency_key = p_idempotency_key
  for update;
  if v_saved_hash <> p_request_hash then
    raise exception 'IDEMPOTENCY_KEY_REUSED' using errcode = '22023';
  end if;
  if v_response is not null then return (v_response ->> 'id')::uuid; end if;

  select agreement_id into v_agreement_id
  from public.agreement_schedule
  where id = p_schedule_id;
  if not found then raise exception 'INSTALLMENT_NOT_FOUND' using errcode = 'P0002'; end if;
  perform 1 from public.agreements where id = v_agreement_id for update;
  perform 1 from public.agreement_schedule
  where id = p_schedule_id and agreement_id = v_agreement_id
  for update;
  if not found then raise exception 'INSTALLMENT_NOT_FOUND' using errcode = 'P0002'; end if;
  perform public.assess_late_fees_for_agreement(v_agreement_id, current_date);
  select * into v_state from public.get_schedule_payment_state(p_schedule_id);
  v_amount := greatest(0, v_state.late_fee_total - v_state.late_fee_paid);
  if v_amount <= 0 then raise exception 'NO_LATE_FEE_TO_WAIVE' using errcode = '22023'; end if;

  insert into public.late_fee_records (
    agreement_schedule_id, installment_id, amount, fee_type, fee_date,
    reason, waived_by, assessed_at, created_by
  ) values (
    p_schedule_id, null, v_amount, 'waiver', current_date,
    btrim(p_reason), auth.uid(), now(), auth.uid()
  )
  on conflict (agreement_schedule_id, fee_type, fee_date)
    where agreement_schedule_id is not null
  do nothing
  returning id into v_waiver_id;
  if v_waiver_id is null then
    raise exception 'LATE_FEE_ALREADY_WAIVED_TODAY' using errcode = '22023';
  end if;

  perform public.refresh_agreement_payment_status(v_agreement_id);
  insert into public.activity_logs (user_id, action, entity_type, entity_id, details)
  values (
    auth.uid(), 'late_fee.waived', 'agreement_schedule', p_schedule_id,
    jsonb_build_object('amount', v_amount, 'reason', btrim(p_reason), 'agreement_id', v_agreement_id)
  );
  update public.idempotency_records
  set response = jsonb_build_object('id', v_waiver_id)
  where user_id = auth.uid() and operation = 'waive_late_fee'
    and idempotency_key = p_idempotency_key;
  return v_waiver_id;
end;
$$;

create or replace function public.update_application_settings(p_settings jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_settings public.application_settings;
  v_early_type text;
  v_early_fixed numeric(12,2);
  v_early_percent integer;
begin
  if auth.uid() is null or not public.is_owner() then
    raise exception 'SETTINGS_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  v_early_type := p_settings ->> 'early_settlement_discount_type';
  v_early_fixed := (p_settings ->> 'early_settlement_fixed_discount')::numeric(12,2);
  v_early_percent := (p_settings ->> 'early_settlement_interest_discount_percent')::integer;
  if v_early_type not in ('fixed', 'interest_percentage')
      or v_early_fixed < 0
      or v_early_percent not between 0 and 100 then
    raise exception 'INVALID_EARLY_SETTLEMENT_SETTINGS' using errcode = '22023';
  end if;

  insert into public.application_settings (
    id, default_daily_interest, default_weekly_interest, default_monthly_interest,
    default_grace_period_days, fixed_late_fee, daily_late_fee, maximum_late_fee,
    early_settlement_discount_type, early_settlement_fixed_discount,
    early_settlement_interest_discount_percent, updated_by, updated_at
  ) values (
    'default',
    (p_settings ->> 'default_daily_interest')::numeric(12,2),
    (p_settings ->> 'default_weekly_interest')::numeric(12,2),
    (p_settings ->> 'default_monthly_interest')::numeric(12,2),
    (p_settings ->> 'default_grace_period_days')::integer,
    (p_settings ->> 'fixed_late_fee')::numeric(12,2),
    (p_settings ->> 'daily_late_fee')::numeric(12,2),
    (p_settings ->> 'maximum_late_fee')::numeric(12,2),
    v_early_type, v_early_fixed, v_early_percent, auth.uid(), now()
  )
  on conflict (id) do update set
    default_daily_interest = excluded.default_daily_interest,
    default_weekly_interest = excluded.default_weekly_interest,
    default_monthly_interest = excluded.default_monthly_interest,
    default_grace_period_days = excluded.default_grace_period_days,
    fixed_late_fee = excluded.fixed_late_fee,
    daily_late_fee = excluded.daily_late_fee,
    maximum_late_fee = excluded.maximum_late_fee,
    early_settlement_discount_type = excluded.early_settlement_discount_type,
    early_settlement_fixed_discount = excluded.early_settlement_fixed_discount,
    early_settlement_interest_discount_percent = excluded.early_settlement_interest_discount_percent,
    updated_by = auth.uid(),
    updated_at = now()
  returning * into v_settings;
  return to_jsonb(v_settings);
end;
$$;

create or replace function public.get_early_settlement_quote(p_agreement_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status text;
  v_discount_type text;
  v_fixed_discount numeric(12,2);
  v_interest_percent integer;
  v_principal numeric;
  v_interest numeric;
  v_late_fees numeric;
  v_discount numeric(12,2);
  v_settlement numeric;
begin
  if auth.uid() is null or not public.has_permission('payments:read') then
    raise exception 'PAYMENT_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  perform public.assess_late_fees_for_agreement(p_agreement_id, current_date);
  select status into v_status
  from public.agreements where id = p_agreement_id;
  if not found or v_status <> 'approved' then
    raise exception 'AGREEMENT_NOT_OPEN' using errcode = 'P0002';
  end if;

  select coalesce(sum(state.principal_due), 0),
         coalesce(sum(state.interest_due), 0),
         coalesce(sum(greatest(0, state.late_fee_total - state.late_fee_paid)), 0)
  into v_principal, v_interest, v_late_fees
  from public.agreement_schedule s
  cross join lateral public.get_schedule_payment_state(s.id) state
  where s.agreement_id = p_agreement_id;
  select early_settlement_discount_type, early_settlement_fixed_discount,
         early_settlement_interest_discount_percent
  into v_discount_type, v_fixed_discount, v_interest_percent
  from public.application_settings where id = 'default';
  v_discount := case v_discount_type
    when 'fixed' then least(v_interest, v_fixed_discount)
    else trunc(v_interest * v_interest_percent / 100, 2)
  end;
  v_settlement := v_principal + v_interest + v_late_fees - v_discount;
  if v_settlement <= 0 then
    raise exception 'AGREEMENT_HAS_NO_OUTSTANDING_BALANCE' using errcode = '22023';
  end if;
  if v_settlement > 9999999999.99 then
    raise exception 'SETTLEMENT_LIMIT_EXCEEDED' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'agreement_id', p_agreement_id,
    'outstanding_principal', v_principal::numeric(12,2)::text,
    'outstanding_interest', v_interest::numeric(12,2)::text,
    'late_fees', v_late_fees::numeric(12,2)::text,
    'discount_type', v_discount_type,
    'discount_amount', v_discount::text,
    'settlement_amount', v_settlement::numeric(12,2)::text
  );
end;
$$;

create or replace function public.create_discount_request(
  p_discount_type text,
  p_amount numeric(12,2),
  p_reason text,
  p_customer_id uuid,
  p_agreement_id uuid,
  p_idempotency_key text,
  p_request_hash text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_saved_hash text;
  v_response jsonb;
  v_amount numeric(12,2);
  v_quote jsonb;
  v_discount_type text;
  v_fixed_discount numeric(12,2);
  v_interest_percent integer;
  v_request_id uuid;
begin
  if auth.uid() is null or not public.has_permission('discounts:request') then
    raise exception 'DISCOUNT_REQUEST_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  if p_discount_type not in ('product', 'customer', 'early_settlement')
      or length(btrim(p_reason)) not between 2 and 500
      or length(p_idempotency_key) not between 1 and 200
      or length(p_request_hash) <> 64 then
    raise exception 'INVALID_DISCOUNT_REQUEST' using errcode = '22023';
  end if;

  if p_discount_type = 'early_settlement' then
    if p_agreement_id is null or p_customer_id is not null or p_amount is not null then
      raise exception 'INVALID_EARLY_SETTLEMENT_REQUEST' using errcode = '22023';
    end if;
    v_quote := public.get_early_settlement_quote(p_agreement_id);
    v_amount := (v_quote ->> 'discount_amount')::numeric(12,2);
    select early_settlement_discount_type, early_settlement_fixed_discount,
           early_settlement_interest_discount_percent
    into v_discount_type, v_fixed_discount, v_interest_percent
    from public.application_settings where id = 'default';
  else
    if p_agreement_id is not null or p_amount is null or p_amount <= 0
        or (p_discount_type = 'customer' and p_customer_id is null) then
      raise exception 'INVALID_DISCOUNT_REQUEST' using errcode = '22023';
    end if;
    v_amount := p_amount;
  end if;

  insert into public.idempotency_records (user_id, operation, idempotency_key, request_hash)
  values (auth.uid(), 'create_discount_request', p_idempotency_key, p_request_hash)
  on conflict do nothing;
  select request_hash, response into v_saved_hash, v_response
  from public.idempotency_records
  where user_id = auth.uid() and operation = 'create_discount_request'
    and idempotency_key = p_idempotency_key
  for update;
  if v_saved_hash <> p_request_hash then
    raise exception 'IDEMPOTENCY_KEY_REUSED' using errcode = '22023';
  end if;
  if v_response is not null then return (v_response ->> 'id')::uuid; end if;

  insert into public.discount_requests (
    discount_type, amount, reason, customer_id, agreement_id, requested_by,
    early_discount_type, early_fixed_discount, early_interest_discount_percent,
    quoted_principal, quoted_interest, quoted_late_fees, quoted_settlement_amount
  ) values (
    p_discount_type, v_amount, btrim(p_reason), p_customer_id, p_agreement_id, auth.uid(),
    v_discount_type, v_fixed_discount, v_interest_percent,
    nullif(v_quote ->> 'outstanding_principal', '')::numeric(12,2),
    nullif(v_quote ->> 'outstanding_interest', '')::numeric(12,2),
    nullif(v_quote ->> 'late_fees', '')::numeric(12,2),
    nullif(v_quote ->> 'settlement_amount', '')::numeric(12,2)
  ) returning id into v_request_id;
  update public.idempotency_records
  set response = jsonb_build_object('id', v_request_id)
  where user_id = auth.uid() and operation = 'create_discount_request'
    and idempotency_key = p_idempotency_key;
  return v_request_id;
end;
$$;

create or replace function public.get_discount_requests()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
begin
  if auth.uid() is null or not public.has_permission('discounts:read') then
    raise exception 'DISCOUNT_READ_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', request.id,
      'discount_type', request.discount_type,
      'amount', request.amount::text,
      'reason', request.reason,
      'customer_id', request.customer_id,
      'agreement_id', request.agreement_id,
      'status', request.status,
      'requester', coalesce(nullif(btrim(requester.full_name), ''), requester_user.email, 'Unknown'),
      'approver', coalesce(nullif(btrim(approver.full_name), ''), approver_user.email),
      'decision_at', request.decision_at,
      'decision_reason', request.decision_reason,
      'approved_at', request.approved_at,
      'applied_at', request.applied_at,
      'payment_id', request.payment_id,
      'quoted_principal', request.quoted_principal::text,
      'quoted_interest', request.quoted_interest::text,
      'quoted_late_fees', request.quoted_late_fees::text,
      'quoted_settlement_amount', request.quoted_settlement_amount::text,
      'created_at', request.created_at
    ) order by request.created_at desc
  ), '[]'::jsonb)
  into v_result
  from public.discount_requests request
  left join public.profiles requester on requester.user_id = request.requested_by
  left join auth.users requester_user on requester_user.id = request.requested_by
  left join public.profiles approver on approver.user_id = request.approved_by
  left join auth.users approver_user on approver_user.id = request.approved_by
  where public.is_owner()
     or request.requested_by = auth.uid()
     or (request.status = 'approved' and request.applied_at is null);
  return v_result;
end;
$$;

create or replace function public.get_available_discounts(
  p_discount_type text default null,
  p_customer_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
begin
  if auth.uid() is null or not public.has_permission('discounts:read') then
    raise exception 'DISCOUNT_READ_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  if p_discount_type is not null and p_discount_type not in ('product', 'customer') then
    raise exception 'INVALID_DISCOUNT_TYPE' using errcode = '22023';
  end if;
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', id,
      'discount_type', discount_type,
      'amount', amount::text,
      'reason', reason,
      'customer_id', customer_id
    ) order by created_at
  ), '[]'::jsonb)
  into v_result
  from public.discount_requests
  where status = 'approved'
    and applied_at is null
    and discount_type in ('product', 'customer')
    and (p_discount_type is null or discount_type = p_discount_type)
    and (customer_id is null or customer_id = p_customer_id);
  return v_result;
end;
$$;

create or replace function public.decide_discount_request(
  p_request_id uuid,
  p_decision text,
  p_reason text,
  p_idempotency_key text,
  p_request_hash text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_saved_hash text;
  v_response jsonb;
  v_status text;
  v_discount_type text;
begin
  if auth.uid() is null or not public.is_owner() then
    raise exception 'OWNER_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  if p_decision not in ('approved', 'rejected')
      or (p_decision = 'rejected' and length(btrim(p_reason)) < 2)
      or length(p_reason) > 500
      or length(p_idempotency_key) not between 1 and 200
      or length(p_request_hash) <> 64 then
    raise exception 'INVALID_DISCOUNT_DECISION' using errcode = '22023';
  end if;
  insert into public.idempotency_records (user_id, operation, idempotency_key, request_hash)
  values (auth.uid(), 'decide_discount_request', p_idempotency_key, p_request_hash)
  on conflict do nothing;
  select request_hash, response into v_saved_hash, v_response
  from public.idempotency_records
  where user_id = auth.uid() and operation = 'decide_discount_request'
    and idempotency_key = p_idempotency_key
  for update;
  if v_saved_hash <> p_request_hash then
    raise exception 'IDEMPOTENCY_KEY_REUSED' using errcode = '22023';
  end if;
  if v_response is not null then return (v_response ->> 'id')::uuid; end if;

  select status, discount_type into v_status, v_discount_type
  from public.discount_requests where id = p_request_id for update;
  if not found or v_status <> 'pending'
      or (v_discount_type = 'early_settlement' and p_decision <> 'rejected') then
    raise exception 'DISCOUNT_REQUEST_NOT_DECIDABLE' using errcode = 'P0002';
  end if;
  update public.discount_requests
  set status = p_decision,
      approved_by = auth.uid(),
      approved_at = case when p_decision = 'approved' then now() else null end,
      decision_at = now(),
      decision_reason = nullif(btrim(p_reason), ''),
      updated_at = now()
  where id = p_request_id;
  insert into public.activity_logs (user_id, action, entity_type, entity_id, details)
  values (auth.uid(), 'discount.' || p_decision, 'discount_request', p_request_id,
          jsonb_build_object('reason', nullif(btrim(p_reason), '')));
  update public.idempotency_records
  set response = jsonb_build_object('id', p_request_id)
  where user_id = auth.uid() and operation = 'decide_discount_request'
    and idempotency_key = p_idempotency_key;
  return p_request_id;
end;
$$;

create or replace function public.assert_discount_request(
  p_request_id uuid,
  p_discount_type text,
  p_customer_id uuid,
  p_amount numeric(12,2),
  p_idempotency_key text,
  p_request_hash text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.discount_requests;
begin
  if p_amount = 0 and p_request_id is null then return; end if;
  if p_amount <= 0 or p_request_id is null then
    raise exception 'APPROVED_DISCOUNT_REQUIRED' using errcode = '22023';
  end if;
  select * into v_request
  from public.discount_requests where id = p_request_id for update;
  if not found
      or v_request.discount_type <> p_discount_type
      or v_request.amount <> p_amount
      or (p_discount_type = 'customer' and v_request.customer_id is null)
      or (v_request.customer_id is not null and v_request.customer_id <> p_customer_id) then
    raise exception 'DISCOUNT_REQUEST_MISMATCH' using errcode = '22023';
  end if;
  if v_request.status = 'applied'
      and v_request.applied_idempotency_key = p_idempotency_key
      and v_request.applied_request_hash = p_request_hash then
    return;
  end if;
  if v_request.status <> 'approved' or v_request.applied_at is not null then
    raise exception 'DISCOUNT_ALREADY_USED_OR_NOT_APPROVED' using errcode = '22023';
  end if;
end;
$$;

create or replace function public.mark_discount_request_applied(
  p_request_id uuid,
  p_target_sale_id uuid,
  p_target_agreement_id uuid,
  p_idempotency_key text,
  p_request_hash text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.discount_requests;
begin
  if p_request_id is null then return; end if;
  select * into v_request
  from public.discount_requests where id = p_request_id for update;
  if v_request.status = 'applied'
      and v_request.applied_idempotency_key = p_idempotency_key
      and v_request.applied_request_hash = p_request_hash
      and v_request.applied_to_sale_id is not distinct from p_target_sale_id
      and v_request.applied_to_agreement_id is not distinct from p_target_agreement_id then
    return;
  end if;
  if v_request.status <> 'approved' or v_request.applied_at is not null then
    raise exception 'DISCOUNT_ALREADY_USED_OR_NOT_APPROVED' using errcode = '22023';
  end if;
  update public.discount_requests
  set status = 'applied',
      applied_at = now(),
      applied_to_sale_id = p_target_sale_id,
      applied_to_agreement_id = p_target_agreement_id,
      applied_idempotency_key = p_idempotency_key,
      applied_request_hash = p_request_hash,
      updated_at = now()
  where id = p_request_id and status = 'approved' and applied_at is null;
  if not found then raise exception 'DISCOUNT_ALREADY_USED_OR_NOT_APPROVED' using errcode = '22023'; end if;
end;
$$;

create or replace function public.create_sale_with_discount(
  p_sale jsonb,
  p_items jsonb,
  p_allow_negative_stock boolean,
  p_idempotency_key text,
  p_request_hash text,
  p_discount_type text,
  p_discount_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_response jsonb;
  v_customer_id uuid;
  v_discount numeric(12,2);
begin
  v_customer_id := nullif(p_sale ->> 'customer_id', '')::uuid;
  v_discount := (p_sale ->> 'discount_amount')::numeric(12,2);
  if p_discount_type is not null and p_discount_type not in ('product', 'customer') then
    raise exception 'INVALID_DISCOUNT_TYPE' using errcode = '22023';
  end if;
  perform public.assert_discount_request(
    p_discount_request_id, p_discount_type, v_customer_id, v_discount,
    p_idempotency_key, p_request_hash
  );

  v_response := public.create_sale(
    p_sale, p_items, p_allow_negative_stock, p_idempotency_key, p_request_hash
  );
  perform public.mark_discount_request_applied(
    p_discount_request_id,
    (v_response ->> 'sale_id')::uuid,
    null,
    p_idempotency_key,
    p_request_hash
  );
  return v_response;
end;
$$;

create or replace function public.create_installment_sale_with_discounts(
  p_sale jsonb,
  p_agreement jsonb,
  p_items jsonb,
  p_schedule jsonb,
  p_idempotency_key text,
  p_request_hash text,
  p_product_discount_request_id uuid,
  p_customer_discount_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_response jsonb;
  v_customer_id uuid := (p_agreement ->> 'customer_id')::uuid;
  v_product_discount numeric(12,2) := (p_agreement ->> 'product_discount')::numeric(12,2);
  v_customer_discount numeric(12,2) := (p_agreement ->> 'customer_discount')::numeric(12,2);
  v_agreement_id uuid;
  v_sale_id uuid;
begin
  perform public.assert_discount_request(
    p_product_discount_request_id, 'product', v_customer_id, v_product_discount,
    p_idempotency_key, p_request_hash
  );
  perform public.assert_discount_request(
    p_customer_discount_request_id, 'customer', v_customer_id, v_customer_discount,
    p_idempotency_key, p_request_hash
  );
  if p_product_discount_request_id is not null
      and p_product_discount_request_id = p_customer_discount_request_id then
    raise exception 'DISCOUNT_REQUEST_CANNOT_BE_REUSED' using errcode = '22023';
  end if;

  v_response := public.create_installment_sale(
    p_sale, p_agreement, p_items, p_schedule, p_idempotency_key, p_request_hash
  );
  v_agreement_id := (v_response ->> 'agreement_id')::uuid;
  v_sale_id := (v_response ->> 'sale_id')::uuid;
  update public.agreements set status = 'approved' where id = v_agreement_id and status = 'pending_approval';
  delete from public.discount_approvals where agreement_id = v_agreement_id and status = 'pending';
  perform public.mark_discount_request_applied(
    p_product_discount_request_id, v_sale_id, v_agreement_id, p_idempotency_key, p_request_hash
  );
  perform public.mark_discount_request_applied(
    p_customer_discount_request_id, v_sale_id, v_agreement_id, p_idempotency_key, p_request_hash
  );
  return v_response;
end;
$$;

create or replace function public.create_installment_agreement_with_discounts(
  p_idempotency_key text,
  p_request_hash text,
  p_agreement jsonb,
  p_items jsonb,
  p_schedule jsonb,
  p_product_discount_request_id uuid,
  p_customer_discount_request_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_customer_id uuid := (p_agreement ->> 'customer_id')::uuid;
  v_product_discount numeric(12,2) := (p_agreement ->> 'product_discount')::numeric(12,2);
  v_customer_discount numeric(12,2) := (p_agreement ->> 'customer_discount')::numeric(12,2);
  v_agreement_id uuid;
begin
  perform public.assert_discount_request(
    p_product_discount_request_id, 'product', v_customer_id, v_product_discount,
    p_idempotency_key, p_request_hash
  );
  perform public.assert_discount_request(
    p_customer_discount_request_id, 'customer', v_customer_id, v_customer_discount,
    p_idempotency_key, p_request_hash
  );
  if p_product_discount_request_id is not null
      and p_product_discount_request_id = p_customer_discount_request_id then
    raise exception 'DISCOUNT_REQUEST_CANNOT_BE_REUSED' using errcode = '22023';
  end if;

  v_agreement_id := public.create_installment_agreement_idempotent(
    p_idempotency_key, p_request_hash, p_agreement, p_items, p_schedule
  );
  update public.agreements set status = 'approved' where id = v_agreement_id and status = 'pending_approval';
  delete from public.discount_approvals where agreement_id = v_agreement_id and status = 'pending';
  perform public.mark_discount_request_applied(
    p_product_discount_request_id, null, v_agreement_id, p_idempotency_key, p_request_hash
  );
  perform public.mark_discount_request_applied(
    p_customer_discount_request_id, null, v_agreement_id, p_idempotency_key, p_request_hash
  );
  return v_agreement_id;
end;
$$;

drop function if exists public.record_payment(uuid, numeric, text, text, text);
create or replace function public.record_payment(
  p_agreement_id uuid,
  p_amount numeric(12,2),
  p_payment_method text,
  p_reference text,
  p_idempotency_key text,
  p_request_hash text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment_id uuid;
  v_customer_id uuid;
  v_agreement_status text;
  v_response jsonb;
  v_saved_hash text;
  v_schedule record;
  v_remaining numeric(12,2);
  v_outstanding numeric(12,2);
  v_fee_due numeric(12,2);
  v_interest_due numeric(12,2);
  v_principal_due numeric(12,2);
  v_component_due numeric(12,2);
  v_allocation numeric(12,2);
  v_allocation_type text;
  v_allocation_order text[];
begin
  if auth.uid() is null or not public.has_permission('payments:write') then
    raise exception 'PAYMENT_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  if p_amount <= 0
      or length(p_idempotency_key) not between 1 and 200
      or length(p_request_hash) <> 64
      or p_reference is not null and length(p_reference) > 120 then
    raise exception 'INVALID_PAYMENT' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.payment_methods where key = p_payment_method and active
  ) then
    raise exception 'INVALID_PAYMENT_METHOD' using errcode = '22023';
  end if;

  insert into public.idempotency_records (user_id, operation, idempotency_key, request_hash)
  values (auth.uid(), 'record_payment', p_idempotency_key, p_request_hash)
  on conflict do nothing;
  select request_hash, response into v_saved_hash, v_response
  from public.idempotency_records
  where user_id = auth.uid() and operation = 'record_payment'
    and idempotency_key = p_idempotency_key
  for update;
  if v_saved_hash <> p_request_hash then
    raise exception 'IDEMPOTENCY_KEY_REUSED' using errcode = '22023';
  end if;
  if v_response is not null then return (v_response ->> 'id')::uuid; end if;

  select customer_id, status into v_customer_id, v_agreement_status
  from public.agreements where id = p_agreement_id for update;
  if not found or v_agreement_status <> 'approved' then
    raise exception 'AGREEMENT_NOT_PAYABLE' using errcode = 'P0002';
  end if;

  perform public.assess_late_fees_for_agreement(p_agreement_id, current_date);
  perform s.id from public.agreement_schedule s
  where s.agreement_id = p_agreement_id
  order by s.due_date, s.installment_number for update;

  select payment_allocation_order into v_allocation_order
  from public.application_settings where id = 'default';
  v_allocation_order := coalesce(v_allocation_order, array['late_fee', 'interest', 'principal']::text[]);

  select coalesce(sum(
    state.principal_due + state.interest_due
      + greatest(0, state.late_fee_total - state.late_fee_paid)
  ), 0)
  into v_outstanding
  from public.agreement_schedule s
  cross join lateral public.get_schedule_payment_state(s.id) state
  where s.agreement_id = p_agreement_id;
  if p_amount > v_outstanding then
    raise exception 'PAYMENT_EXCEEDS_BALANCE' using errcode = '22023';
  end if;

  insert into public.payments (
    customer_id, agreement_id, amount, payment_method, reference, collected_at, collected_by
  ) values (
    v_customer_id, p_agreement_id, p_amount, p_payment_method,
    nullif(btrim(p_reference), ''), now(), auth.uid()
  ) returning id into v_payment_id;
  v_remaining := p_amount;

  for v_schedule in
    select s.id, state.late_fee_total, state.late_fee_paid,
      state.interest_due, state.principal_due
    from public.agreement_schedule s
    cross join lateral public.get_schedule_payment_state(s.id) state
    where s.agreement_id = p_agreement_id
    order by s.due_date, s.installment_number
  loop
    v_interest_due := v_schedule.interest_due;
    v_principal_due := v_schedule.principal_due;
    v_fee_due := greatest(0, v_schedule.late_fee_total - v_schedule.late_fee_paid);
    foreach v_allocation_type in array v_allocation_order loop
      v_component_due := case v_allocation_type
        when 'late_fee' then v_fee_due
        when 'interest' then v_interest_due
        when 'principal' then v_principal_due
        else 0
      end;
      v_allocation := least(v_remaining, v_component_due);
      if v_allocation > 0 then
        insert into public.payment_allocations (
          payment_id, agreement_schedule_id, amount, allocation_type
        ) values (v_payment_id, v_schedule.id, v_allocation, v_allocation_type);
        v_remaining := v_remaining - v_allocation;
        case v_allocation_type
          when 'late_fee' then v_fee_due := v_fee_due - v_allocation;
          when 'interest' then v_interest_due := v_interest_due - v_allocation;
          when 'principal' then v_principal_due := v_principal_due - v_allocation;
        end case;
      end if;
      exit when v_remaining = 0;
    end loop;
    exit when v_remaining = 0;
  end loop;
  if v_remaining <> 0 then raise exception 'PAYMENT_ALLOCATION_FAILED' using errcode = '22023'; end if;

  perform public.refresh_agreement_payment_status(p_agreement_id);
  insert into public.activity_logs (user_id, action, entity_type, entity_id, details)
  values (
    auth.uid(), 'payment.recorded', 'payment', v_payment_id,
    jsonb_build_object('agreement_id', p_agreement_id, 'amount', p_amount, 'reference', p_reference)
  );
  update public.idempotency_records
  set response = jsonb_build_object('id', v_payment_id)
  where user_id = auth.uid() and operation = 'record_payment'
    and idempotency_key = p_idempotency_key;
  return v_payment_id;
end;
$$;

create or replace function public.approve_early_settlement(
  p_request_id uuid,
  p_payment_method text,
  p_idempotency_key text,
  p_request_hash text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_saved_hash text;
  v_response jsonb;
  v_request public.discount_requests;
  v_agreement_status text;
  v_principal numeric;
  v_interest numeric;
  v_late_fees numeric;
  v_discount numeric(12,2);
  v_settlement numeric(12,2);
  v_remaining_discount numeric(12,2);
  v_schedule record;
  v_interest_discount numeric(12,2);
  v_payment_id uuid;
begin
  if auth.uid() is null or not public.is_owner() then
    raise exception 'OWNER_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  if length(p_idempotency_key) not between 1 and 180
      or length(p_request_hash) <> 64
      or not exists (select 1 from public.payment_methods where key = p_payment_method and active) then
    raise exception 'INVALID_EARLY_SETTLEMENT_APPROVAL' using errcode = '22023';
  end if;
  insert into public.idempotency_records (user_id, operation, idempotency_key, request_hash)
  values (auth.uid(), 'approve_early_settlement', p_idempotency_key, p_request_hash)
  on conflict do nothing;
  select request_hash, response into v_saved_hash, v_response
  from public.idempotency_records
  where user_id = auth.uid() and operation = 'approve_early_settlement'
    and idempotency_key = p_idempotency_key
  for update;
  if v_saved_hash <> p_request_hash then
    raise exception 'IDEMPOTENCY_KEY_REUSED' using errcode = '22023';
  end if;
  if v_response is not null then return (v_response ->> 'id')::uuid; end if;

  select * into v_request from public.discount_requests
  where id = p_request_id for update;
  if not found or v_request.discount_type <> 'early_settlement' or v_request.status <> 'pending' then
    raise exception 'EARLY_SETTLEMENT_REQUEST_NOT_PENDING' using errcode = 'P0002';
  end if;
  perform 1 from public.agreements where id = v_request.agreement_id for update;
  select status into v_agreement_status
  from public.agreements where id = v_request.agreement_id;
  if v_agreement_status <> 'approved' then
    raise exception 'AGREEMENT_NOT_OPEN' using errcode = 'P0002';
  end if;
  perform public.assess_late_fees_for_agreement(v_request.agreement_id, current_date);

  select coalesce(sum(state.principal_due), 0),
         coalesce(sum(state.interest_due), 0),
         coalesce(sum(greatest(0, state.late_fee_total - state.late_fee_paid)), 0)
  into v_principal, v_interest, v_late_fees
  from public.agreement_schedule s
  cross join lateral public.get_schedule_payment_state(s.id) state
  where s.agreement_id = v_request.agreement_id;
  v_discount := case v_request.early_discount_type
    when 'fixed' then least(v_interest, v_request.early_fixed_discount)
    else trunc(v_interest * v_request.early_interest_discount_percent / 100, 2)
  end;
  v_settlement := v_principal + v_interest + v_late_fees - v_discount;
  if v_principal <> v_request.quoted_principal
      or v_interest <> v_request.quoted_interest
      or v_late_fees <> v_request.quoted_late_fees
      or v_settlement <> v_request.quoted_settlement_amount
      or v_discount <> v_request.amount then
    raise exception 'SETTLEMENT_QUOTE_CHANGED' using errcode = '22023';
  end if;

  v_remaining_discount := v_discount;
  for v_schedule in
    select s.id, state.interest_due
    from public.agreement_schedule s
    cross join lateral public.get_schedule_payment_state(s.id) state
    where s.agreement_id = v_request.agreement_id
    order by s.due_date, s.installment_number
    for update of s
  loop
    exit when v_remaining_discount = 0;
    v_interest_discount := least(v_remaining_discount, v_schedule.interest_due);
    if v_interest_discount > 0 then
      insert into public.early_settlement_interest_discounts (
        discount_request_id, agreement_schedule_id, amount, created_by
      ) values (p_request_id, v_schedule.id, v_interest_discount, auth.uid());
      v_remaining_discount := v_remaining_discount - v_interest_discount;
    end if;
  end loop;
  if v_remaining_discount <> 0 then
    raise exception 'SETTLEMENT_DISCOUNT_ALLOCATION_FAILED' using errcode = '22023';
  end if;

  v_payment_id := public.record_payment(
    v_request.agreement_id,
    v_settlement,
    p_payment_method,
    'Early settlement',
    'early-settlement:' || p_idempotency_key,
    p_request_hash
  );
  update public.agreements set status = 'settled_early' where id = v_request.agreement_id;
  update public.discount_requests
  set status = 'settled_early',
      approved_by = auth.uid(),
      approved_at = now(),
      decision_at = now(),
      applied_at = now(),
      payment_id = v_payment_id,
      applied_idempotency_key = p_idempotency_key,
      applied_request_hash = p_request_hash,
      updated_at = now()
  where id = p_request_id;
  insert into public.activity_logs (user_id, action, entity_type, entity_id, details)
  values (
    auth.uid(), 'agreement.settled_early', 'agreement', v_request.agreement_id,
    jsonb_build_object('payment_id', v_payment_id, 'discount_request_id', p_request_id,
                       'discount', v_discount, 'settlement_amount', v_settlement)
  );
  update public.idempotency_records
  set response = jsonb_build_object('id', v_payment_id)
  where user_id = auth.uid() and operation = 'approve_early_settlement'
    and idempotency_key = p_idempotency_key;
  return v_payment_id;
end;
$$;

revoke all on function public.create_sale(jsonb, jsonb, boolean, text, text) from public, authenticated;
revoke all on function public.create_installment_sale(jsonb, jsonb, jsonb, jsonb, text, text) from public, authenticated;
revoke all on function public.create_installment_agreement(jsonb, jsonb, jsonb) from public, authenticated;
revoke all on function public.create_installment_agreement_idempotent(text, text, jsonb, jsonb, jsonb) from public, authenticated;
revoke all on function public.assert_discount_request(uuid, text, uuid, numeric, text, text) from public, authenticated;
revoke all on function public.mark_discount_request_applied(uuid, uuid, uuid, text, text) from public, authenticated;
revoke all on function public.get_schedule_payment_state(uuid, date) from public;
revoke all on function public.assess_late_fees_for_agreement(uuid, date) from public, authenticated;
revoke all on function public.assess_all_late_fees(date) from public, authenticated;
revoke all on function public.get_late_payments() from public;
revoke all on function public.waive_late_fee(uuid, text, text, text) from public;
revoke all on function public.get_early_settlement_quote(uuid) from public;
revoke all on function public.create_discount_request(text, numeric, text, uuid, uuid, text, text) from public;
revoke all on function public.get_discount_requests() from public;
revoke all on function public.get_available_discounts(text, uuid) from public;
revoke all on function public.decide_discount_request(uuid, text, text, text, text) from public;
revoke all on function public.create_sale_with_discount(jsonb, jsonb, boolean, text, text, text, uuid) from public;
revoke all on function public.create_installment_sale_with_discounts(jsonb, jsonb, jsonb, jsonb, text, text, uuid, uuid) from public;
revoke all on function public.create_installment_agreement_with_discounts(text, text, jsonb, jsonb, jsonb, uuid, uuid) from public;
revoke all on function public.approve_early_settlement(uuid, text, text, text) from public;

grant execute on function public.assess_all_late_fees(date) to service_role;
grant execute on function public.get_late_payments() to authenticated;
grant execute on function public.waive_late_fee(uuid, text, text, text) to authenticated;
grant execute on function public.get_early_settlement_quote(uuid) to authenticated;
grant execute on function public.create_discount_request(text, numeric, text, uuid, uuid, text, text) to authenticated;
grant execute on function public.get_discount_requests() to authenticated;
grant execute on function public.get_available_discounts(text, uuid) to authenticated;
grant execute on function public.decide_discount_request(uuid, text, text, text, text) to authenticated;
grant execute on function public.create_sale_with_discount(jsonb, jsonb, boolean, text, text, text, uuid) to authenticated;
grant execute on function public.create_installment_sale_with_discounts(jsonb, jsonb, jsonb, jsonb, text, text, uuid, uuid) to authenticated;
grant execute on function public.create_installment_agreement_with_discounts(text, text, jsonb, jsonb, jsonb, uuid, uuid) to authenticated;
grant execute on function public.approve_early_settlement(uuid, text, text, text) to authenticated;
grant execute on function public.record_payment(uuid, numeric, text, text, text, text) to authenticated;
