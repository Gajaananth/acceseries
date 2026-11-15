alter table public.application_settings
  add column if not exists payment_allocation_order text[] not null
    default array['late_fee', 'interest', 'principal']::text[];

alter table public.application_settings
  drop constraint if exists application_settings_payment_allocation_order_check;
alter table public.application_settings
  add constraint application_settings_payment_allocation_order_check
  check (
    cardinality(payment_allocation_order) = 3
    and payment_allocation_order @> array['late_fee', 'interest', 'principal']::text[]
    and payment_allocation_order <@ array['late_fee', 'interest', 'principal']::text[]
  );

alter table public.agreements
  drop constraint if exists agreements_status_check;
alter table public.agreements
  add constraint agreements_status_check
  check (status in ('approved', 'pending_approval', 'settled'));

alter table public.agreement_schedule
  add column if not exists status text not null default 'pending'
    check (status in ('pending', 'partial', 'overdue', 'paid'));

alter table public.payments
  add column if not exists receipt_number text,
  add column if not exists reference text,
  add column if not exists collected_by uuid references auth.users(id) on delete set null;

update public.payments
set receipt_number = 'RCT-' || to_char(collected_at at time zone 'UTC', 'YYYYMMDD') || '-' ||
  upper(substr(replace(id::text, '-', ''), 1, 12))
where receipt_number is null;

alter table public.payments
  alter column receipt_number set default (
    'RCT-' || to_char(now() at time zone 'UTC', 'YYYYMMDD') || '-' ||
    upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))
  ),
  alter column receipt_number set not null;
create unique index if not exists payments_receipt_number_key on public.payments (receipt_number);
create index if not exists payments_collected_at_idx on public.payments (collected_at desc);
create index if not exists payments_agreement_collected_idx on public.payments (agreement_id, collected_at desc);

alter table public.payment_allocations
  alter column installment_id drop not null,
  add column if not exists allocation_type text,
  add column if not exists reverses_allocation_id uuid
    references public.payment_allocations(id) on delete restrict;

create temporary table payment_allocation_backfill on commit drop as
with ordered as (
  select
    pa.id,
    pa.payment_id,
    pa.agreement_schedule_id,
    pa.amount as original_amount,
    s.interest_amount,
    coalesce(
      sum(pa.amount) over (
        partition by pa.agreement_schedule_id
        order by p.collected_at, pa.created_at, pa.id
        rows between unbounded preceding and 1 preceding
      ),
      0
    ) as previously_allocated
  from public.payment_allocations pa
  join public.payments p on p.id = pa.payment_id
  join public.agreement_schedule s on s.id = pa.agreement_schedule_id
  where pa.agreement_schedule_id is not null
    and pa.allocation_type is null
    and pa.amount > 0
    and pa.reverses_allocation_id is null
)
select
  id,
  payment_id,
  agreement_schedule_id,
  least(original_amount, greatest(0, interest_amount - previously_allocated)) as interest_amount,
  greatest(
    0,
    original_amount - least(original_amount, greatest(0, interest_amount - previously_allocated))
  ) as principal_amount
from ordered;

update public.payment_allocations pa
set amount = case
      when backfill.interest_amount > 0 then backfill.interest_amount
      else backfill.principal_amount
    end,
    allocation_type = case
      when backfill.interest_amount > 0 then 'interest'
      else 'principal'
    end
from payment_allocation_backfill backfill
where pa.id = backfill.id;

insert into public.payment_allocations (
  payment_id, agreement_schedule_id, amount, allocation_type
)
select payment_id, agreement_schedule_id, principal_amount, 'principal'
from payment_allocation_backfill
where interest_amount > 0 and principal_amount > 0;

update public.payment_allocations
set allocation_type = 'principal'
where allocation_type is null;

alter table public.payment_allocations
  alter column allocation_type set default 'principal',
  alter column allocation_type set not null,
  drop constraint if exists payment_allocations_amount_check,
  add constraint payment_allocations_amount_check check (amount <> 0),
  drop constraint if exists payment_allocations_allocation_type_check,
  add constraint payment_allocations_allocation_type_check
    check (allocation_type in ('late_fee', 'interest', 'principal'));

create unique index if not exists payment_allocations_reversal_key
  on public.payment_allocations (reverses_allocation_id)
  where reverses_allocation_id is not null;
create index if not exists payment_allocations_schedule_type_idx
  on public.payment_allocations (agreement_schedule_id, allocation_type, payment_id);

alter table public.late_fee_records
  alter column installment_id drop not null,
  add column if not exists agreement_schedule_id uuid
    references public.agreement_schedule(id) on delete restrict;
create unique index if not exists late_fee_records_schedule_key
  on public.late_fee_records (agreement_schedule_id)
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
stable
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
    select s.id, s.amount, s.interest_amount, s.due_date,
      a.grace_period_days, a.fixed_late_fee, a.daily_late_fee, a.maximum_late_fee,
      coalesce(paid.late_fee_paid, 0) as late_fee_paid,
      coalesce(paid.interest_paid, 0) as interest_paid,
      coalesce(paid.principal_paid, 0) as principal_paid,
      coalesce(lfr.amount, 0) as assessed_late_fee
    from public.agreement_schedule s
    join public.agreements a on a.id = s.agreement_id
    left join lateral (
      select
        coalesce(sum(pa.amount) filter (where pa.allocation_type = 'late_fee'), 0) as late_fee_paid,
        coalesce(sum(pa.amount) filter (where pa.allocation_type = 'interest'), 0) as interest_paid,
        coalesce(sum(pa.amount) filter (where pa.allocation_type = 'principal'), 0) as principal_paid
      from public.payment_allocations pa
      join public.payments p on p.id = pa.payment_id and p.reversed_at is null
      where pa.agreement_schedule_id = s.id
    ) paid on true
    left join public.late_fee_records lfr on lfr.agreement_schedule_id = s.id
    where s.id = p_schedule_id
  ),
  dues as (
    select schedule.*,
      greatest(0, amount - interest_amount - principal_paid) as amount_principal_due,
      greatest(0, interest_amount - interest_paid) as amount_interest_due
    from schedule
  )
  select
    amount_principal_due,
    amount_interest_due,
    case
      when amount_principal_due + amount_interest_due > 0 then greatest(
        assessed_late_fee,
        public.calculate_schedule_late_fee(
          due_date, grace_period_days, fixed_late_fee, daily_late_fee,
          maximum_late_fee, p_as_of
        )
      )
      else assessed_late_fee
    end::numeric(12,2),
    late_fee_paid,
    principal_paid,
    interest_paid
  from dues;
$$;

create or replace function public.refresh_agreement_payment_status(p_agreement_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_has_outstanding boolean;
begin
  with balances as (
    select
      s.id,
      s.due_date,
      a.grace_period_days,
      state.principal_paid + state.interest_paid + state.late_fee_paid as paid_amount,
      state.principal_due + state.interest_due
        + greatest(0, state.late_fee_total - state.late_fee_paid) as outstanding_amount
    from public.agreement_schedule s
    join public.agreements a on a.id = s.agreement_id
    cross join lateral public.get_schedule_payment_state(s.id) state
    where s.agreement_id = p_agreement_id
  )
  update public.agreement_schedule s
  set status = case
    when balances.outstanding_amount <= 0 then 'paid'
    when s.due_date + balances.grace_period_days < current_date then 'overdue'
    when balances.paid_amount > 0 then 'partial'
    else 'pending'
  end
  from balances
  where s.id = balances.id;

  select exists (
    select 1
    from public.agreement_schedule s
    cross join lateral public.get_schedule_payment_state(s.id) state
    where s.agreement_id = p_agreement_id
      and (
        state.principal_due + state.interest_due
        + greatest(0, state.late_fee_total - state.late_fee_paid)
      ) > 0
  ) into v_has_outstanding;

  update public.agreements
  set status = case when v_has_outstanding then 'approved' else 'settled' end
  where id = p_agreement_id and status in ('approved', 'settled');
end;
$$;

create or replace function public.get_customer_collection(p_customer_id uuid)
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
  if not exists (select 1 from public.customers where id = p_customer_id) then
    raise exception 'CUSTOMER_NOT_FOUND' using errcode = 'P0002';
  end if;

  with lines as (
    select
      s.id,
      s.agreement_id,
      s.installment_number,
      s.due_date,
      a.grace_period_days,
      s.amount,
      s.interest_amount,
      state.late_fee_paid,
      state.interest_paid,
      state.principal_paid,
      state.principal_due,
      state.interest_due,
      state.late_fee_total
    from public.agreement_schedule s
    join public.agreements a on a.id = s.agreement_id
    cross join lateral public.get_schedule_payment_state(s.id) state
    where a.customer_id = p_customer_id and a.status in ('approved', 'settled')
  ),
  line_balances as (
    select
      lines.*,
      greatest(0, late_fee_total - late_fee_paid) as late_fee_due,
      principal_due + interest_due + greatest(0, late_fee_total - late_fee_paid) as outstanding_amount,
      principal_paid + interest_paid + late_fee_paid as paid_amount
    from lines
  ),
  agreement_balances as (
    select
      a.id,
      a.frequency,
      a.installment_count,
      a.status,
      coalesce(sale.invoice_number, 'AGR-' || upper(substr(replace(a.id::text, '-', ''), 1, 10))) as agreement_reference,
      coalesce(sum(lb.outstanding_amount), 0) as outstanding_balance,
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'id', lb.id,
            'installment_number', lb.installment_number,
            'due_date', lb.due_date,
            'amount', lb.amount::text,
            'interest_amount', lb.interest_amount::text,
            'late_fee_due', lb.late_fee_due::text,
            'interest_due', lb.interest_due::text,
            'principal_due', lb.principal_due::text,
            'outstanding_amount', lb.outstanding_amount::text,
            'paid_amount', lb.paid_amount::text,
            'status', case
              when lb.outstanding_amount <= 0 then 'paid'
              when lb.due_date + lb.grace_period_days < current_date then 'overdue'
              when lb.paid_amount > 0 then 'partial'
              else 'pending'
            end
          )
          order by lb.due_date, lb.installment_number
        ),
        '[]'::jsonb
      ) as installments
    from public.agreements a
    left join public.sales sale on sale.agreement_id = a.id
    left join line_balances lb on lb.agreement_id = a.id
    where a.customer_id = p_customer_id and a.status in ('approved', 'settled')
    group by a.id, a.frequency, a.installment_count, a.status, sale.invoice_number
  )
  select jsonb_build_object(
    'allocation_order',
    coalesce(
      (select payment_allocation_order from public.application_settings where id = 'default'),
      array['late_fee', 'interest', 'principal']::text[]
    ),
    'agreements',
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'agreement_id', id,
          'agreement_reference', agreement_reference,
          'frequency', frequency,
          'installment_count', installment_count,
          'status', status,
          'outstanding_balance', outstanding_balance::text,
          'installments', installments
        )
        order by agreement_reference
      ) filter (where outstanding_balance > 0),
      '[]'::jsonb
    )
  )
  into v_result
  from agreement_balances;
  return v_result;
end;
$$;

create or replace function public.get_payment_summary()
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
  select jsonb_build_object(
    'collected_this_month_cents',
    coalesce(((sum(amount) filter (
      where collected_at >= date_trunc('month', now())
    )) * 100)::numeric(24,0), 0)::text,
    'payments_this_month',
    count(*) filter (where collected_at >= date_trunc('month', now())),
    'overdue_installments',
    (
      select count(*)::integer
      from public.agreement_schedule s
      join public.agreements a on a.id = s.agreement_id and a.status = 'approved'
      cross join lateral public.get_schedule_payment_state(s.id) state
      where s.due_date + a.grace_period_days < current_date
        and state.principal_due + state.interest_due
          + greatest(0, state.late_fee_total - state.late_fee_paid) > 0
    )
  )
  into v_result
  from public.payments
  where reversed_at is null and agreement_id is not null and sale_id is null;
  return v_result;
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
  v_fee_total numeric(12,2);
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
    select 1 from public.payment_methods
    where key = p_payment_method and active
  ) then
    raise exception 'INVALID_PAYMENT_METHOD' using errcode = '22023';
  end if;

  insert into public.idempotency_records (user_id, operation, idempotency_key, request_hash)
  values (auth.uid(), 'record_payment', p_idempotency_key, p_request_hash)
  on conflict do nothing;
  select request_hash, response into v_saved_hash, v_response
  from public.idempotency_records
  where user_id = auth.uid() and operation = 'record_payment' and idempotency_key = p_idempotency_key
  for update;
  if v_saved_hash <> p_request_hash then
    raise exception 'IDEMPOTENCY_KEY_REUSED' using errcode = '22023';
  end if;
  if v_response is not null then return (v_response ->> 'id')::uuid; end if;

  select customer_id, status into v_customer_id, v_agreement_status
  from public.agreements
  where id = p_agreement_id
  for update;
  if not found or v_agreement_status <> 'approved' then
    raise exception 'AGREEMENT_NOT_PAYABLE' using errcode = 'P0002';
  end if;

  perform s.id
  from public.agreement_schedule s
  where s.agreement_id = p_agreement_id
  order by s.due_date, s.installment_number
  for update;

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
  )
  returning id into v_payment_id;
  v_remaining := p_amount;

  for v_schedule in
    select s.id, state.late_fee_total, state.late_fee_paid,
      state.interest_due, state.principal_due
    from public.agreement_schedule s
    cross join lateral public.get_schedule_payment_state(s.id) state
    where s.agreement_id = p_agreement_id
    order by s.due_date, s.installment_number
  loop
    v_principal_due := v_schedule.principal_due;
    v_interest_due := v_schedule.interest_due;
    v_fee_total := v_schedule.late_fee_total;
    if v_fee_total > 0 then
      insert into public.late_fee_records (agreement_schedule_id, amount, assessed_at, created_by)
      values (v_schedule.id, v_fee_total, now(), auth.uid())
      on conflict (agreement_schedule_id) where agreement_schedule_id is not null
      do update set amount = greatest(public.late_fee_records.amount, excluded.amount),
                    assessed_at = excluded.assessed_at,
                    created_by = excluded.created_by;
    end if;
    v_fee_due := greatest(0, v_fee_total - v_schedule.late_fee_paid);

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
  if v_remaining <> 0 then
    raise exception 'PAYMENT_ALLOCATION_FAILED' using errcode = '22023';
  end if;

  perform public.refresh_agreement_payment_status(p_agreement_id);
  insert into public.activity_logs (user_id, action, entity_type, entity_id, details)
  values (
    auth.uid(), 'payment.recorded', 'payment', v_payment_id,
    jsonb_build_object('agreement_id', p_agreement_id, 'amount', p_amount, 'reference', p_reference)
  );
  update public.idempotency_records
  set response = jsonb_build_object('id', v_payment_id)
  where user_id = auth.uid() and operation = 'record_payment' and idempotency_key = p_idempotency_key;
  return v_payment_id;
end;
$$;

create or replace function public.settle_agreement(
  p_agreement_id uuid,
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
  v_payment_id uuid;
  v_outstanding numeric(12,2);
  v_response jsonb;
  v_saved_hash text;
  v_agreement_status text;
begin
  if auth.uid() is null or not public.has_permission('payments:write') then
    raise exception 'PAYMENT_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  if length(p_idempotency_key) not between 1 and 180
      or length(p_request_hash) <> 64
      or not exists (select 1 from public.payment_methods where key = p_payment_method and active) then
    raise exception 'INVALID_SETTLEMENT' using errcode = '22023';
  end if;
  insert into public.idempotency_records (user_id, operation, idempotency_key, request_hash)
  values (auth.uid(), 'settle_agreement', p_idempotency_key, p_request_hash)
  on conflict do nothing;
  select request_hash, response into v_saved_hash, v_response
  from public.idempotency_records
  where user_id = auth.uid() and operation = 'settle_agreement' and idempotency_key = p_idempotency_key
  for update;
  if v_saved_hash <> p_request_hash then
    raise exception 'IDEMPOTENCY_KEY_REUSED' using errcode = '22023';
  end if;
  if v_response is not null then return nullif(v_response ->> 'id', '')::uuid; end if;

  select status into v_agreement_status
  from public.agreements where id = p_agreement_id for update;
  if not found or v_agreement_status not in ('approved', 'settled') then
    raise exception 'AGREEMENT_NOT_PAYABLE' using errcode = 'P0002';
  end if;
  perform s.id
  from public.agreement_schedule s
  where s.agreement_id = p_agreement_id
  order by s.due_date, s.installment_number
  for update;

  select coalesce(sum(
    state.principal_due + state.interest_due
      + greatest(0, state.late_fee_total - state.late_fee_paid)
  ), 0)
  into v_outstanding
  from public.agreement_schedule s
  cross join lateral public.get_schedule_payment_state(s.id) state
  where s.agreement_id = p_agreement_id;
  if v_outstanding > 0 then
    v_payment_id := public.record_payment(
      p_agreement_id,
      v_outstanding,
      p_payment_method,
      null,
      'settlement:' || p_idempotency_key,
      p_request_hash
    );
  else
    perform public.refresh_agreement_payment_status(p_agreement_id);
  end if;
  insert into public.activity_logs (user_id, action, entity_type, entity_id, details)
  values (auth.uid(), 'agreement.settled', 'agreement', p_agreement_id,
          jsonb_build_object('payment_id', v_payment_id));
  update public.idempotency_records
  set response = jsonb_build_object('id', coalesce(v_payment_id::text, ''))
  where user_id = auth.uid() and operation = 'settle_agreement' and idempotency_key = p_idempotency_key;
  return v_payment_id;
end;
$$;

create or replace function public.reverse_payment(
  p_payment_id uuid,
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
  v_response jsonb;
  v_saved_hash text;
  v_agreement_id uuid;
  v_allocation record;
begin
  if auth.uid() is null or not public.is_owner() then
    raise exception 'OWNER_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  if length(btrim(p_reason)) < 2
      or length(p_reason) > 500
      or length(p_idempotency_key) not between 1 and 200
      or length(p_request_hash) <> 64 then
    raise exception 'INVALID_PAYMENT_REVERSAL' using errcode = '22023';
  end if;
  insert into public.idempotency_records (user_id, operation, idempotency_key, request_hash)
  values (auth.uid(), 'reverse_payment', p_idempotency_key, p_request_hash)
  on conflict do nothing;
  select request_hash, response into v_saved_hash, v_response
  from public.idempotency_records
  where user_id = auth.uid() and operation = 'reverse_payment' and idempotency_key = p_idempotency_key
  for update;
  if v_saved_hash <> p_request_hash then
    raise exception 'IDEMPOTENCY_KEY_REUSED' using errcode = '22023';
  end if;
  if v_response is not null then return (v_response ->> 'id')::uuid; end if;

  select agreement_id into v_agreement_id
  from public.payments
  where id = p_payment_id and reversed_at is null and sale_id is null
  for update;
  if not found or v_agreement_id is null then
    raise exception 'PAYMENT_NOT_FOUND_OR_NOT_REVERSIBLE' using errcode = 'P0002';
  end if;
  perform 1 from public.agreements where id = v_agreement_id for update;

  for v_allocation in
    select id, agreement_schedule_id, amount, allocation_type
    from public.payment_allocations
    where payment_id = p_payment_id and reverses_allocation_id is null and amount > 0
    order by created_at, id
  loop
    insert into public.payment_allocations (
      payment_id, agreement_schedule_id, installment_id, amount,
      allocation_type, reverses_allocation_id
    ) values (
      p_payment_id, v_allocation.agreement_schedule_id, null, -v_allocation.amount,
      v_allocation.allocation_type, v_allocation.id
    );
  end loop;

  update public.payments
  set reversed_at = now(), reversed_by = auth.uid(), reversal_reason = btrim(p_reason)
  where id = p_payment_id;
  perform public.refresh_agreement_payment_status(v_agreement_id);
  insert into public.activity_logs (user_id, action, entity_type, entity_id, details)
  values (
    auth.uid(), 'payment.reversed', 'payment', p_payment_id,
    jsonb_build_object('reason', btrim(p_reason), 'agreement_id', v_agreement_id)
  );
  update public.idempotency_records
  set response = jsonb_build_object('id', p_payment_id)
  where user_id = auth.uid() and operation = 'reverse_payment' and idempotency_key = p_idempotency_key;
  return p_payment_id;
end;
$$;

create or replace function public.get_payment_receipt(p_payment_id uuid)
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

  select jsonb_build_object(
    'id', p.id,
    'receipt_number', p.receipt_number,
    'amount', p.amount::text,
    'payment_method', coalesce(pm.name, p.payment_method),
    'reference', p.reference,
    'collected_at', p.collected_at,
    'collected_by', coalesce(nullif(btrim(profile.full_name), ''), user_account.email, 'Unknown'),
    'customer', case
      when customer.id is null then null
      else jsonb_build_object('full_name', customer.full_name, 'phone', customer.phone)
    end,
    'agreement_reference', case
      when agreement.id is null then null
      else coalesce(sale.invoice_number, 'AGR-' || upper(substr(replace(agreement.id::text, '-', ''), 1, 10)))
    end,
    'allocations', jsonb_build_object(
      'late_fee', coalesce(allocation_totals.late_fee, 0)::text,
      'interest', coalesce(allocation_totals.interest, 0)::text,
      'principal', coalesce(allocation_totals.principal, 0)::text
    ),
    'remaining_balance', coalesce(balance.outstanding_amount, 0)::text,
    'reversed_at', p.reversed_at,
    'reversal_reason', p.reversal_reason
  )
  into v_result
  from public.payments p
  left join public.customers customer on customer.id = p.customer_id
  left join public.agreements agreement on agreement.id = p.agreement_id
  left join public.sales sale on sale.agreement_id = agreement.id
  left join public.profiles profile on profile.user_id = p.collected_by
  left join auth.users user_account on user_account.id = p.collected_by
  left join public.payment_methods pm on pm.key = p.payment_method
  left join lateral (
    select
      sum(pa.amount) filter (where pa.allocation_type = 'late_fee') as late_fee,
      sum(pa.amount) filter (where pa.allocation_type = 'interest') as interest,
      sum(pa.amount) filter (where pa.allocation_type = 'principal') as principal
    from public.payment_allocations pa
    where pa.payment_id = p.id and pa.reverses_allocation_id is null and pa.amount > 0
  ) allocation_totals on true
  left join lateral (
    select sum(
      state.principal_due + state.interest_due
        + greatest(0, state.late_fee_total - state.late_fee_paid)
    ) as outstanding_amount
    from public.agreement_schedule s
    cross join lateral public.get_schedule_payment_state(s.id) state
    where s.agreement_id = p.agreement_id
  ) balance on true
  where p.id = p_payment_id and p.agreement_id is not null and p.sale_id is null;

  if v_result is null then raise exception 'PAYMENT_NOT_FOUND' using errcode = 'P0002'; end if;
  return v_result;
end;
$$;

revoke all on function public.calculate_schedule_late_fee(date, integer, numeric, numeric, numeric, date) from public;
grant execute on function public.calculate_schedule_late_fee(date, integer, numeric, numeric, numeric, date) to authenticated;
revoke all on function public.get_schedule_payment_state(uuid, date) from public;
revoke all on function public.refresh_agreement_payment_status(uuid) from public;
revoke all on function public.get_customer_collection(uuid) from public;
grant execute on function public.get_customer_collection(uuid) to authenticated;
revoke all on function public.get_payment_summary() from public;
grant execute on function public.get_payment_summary() to authenticated;
revoke all on function public.get_payment_receipt(uuid) from public;
grant execute on function public.get_payment_receipt(uuid) to authenticated;
revoke all on function public.record_payment(uuid, numeric, text, text, text, text) from public;
grant execute on function public.record_payment(uuid, numeric, text, text, text, text) to authenticated;
revoke all on function public.settle_agreement(uuid, text, text, text) from public;
grant execute on function public.settle_agreement(uuid, text, text, text) to authenticated;
revoke all on function public.reverse_payment(uuid, text, text, text) from public;
grant execute on function public.reverse_payment(uuid, text, text, text) to authenticated;
