create extension if not exists "pgcrypto";

create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  phone text not null unique,
  status text not null default 'active' check (status in ('active','on_track','overdue')),
  current_balance numeric(12,2) not null default 0 check (current_balance >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.customers drop column if exists installment_plan;

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text not null,
  price numeric(12,2) not null check (price > 0),
  stock_quantity integer not null default 0,
  reorder_level integer not null default 10,
  status text not null default 'healthy' check (status in ('healthy','low','critical')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sales (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.customers(id) on delete set null,
  total_amount numeric(12,2) not null check (total_amount >= 0),
  payment_type text not null check (payment_type in ('cash','installment')),
  discount_amount numeric(12,2) not null default 0 check (discount_amount >= 0),
  status text not null default 'paid' check (status in ('paid','pending','processing')),
  created_at timestamptz not null default now()
);

create table if not exists public.installments (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid references public.sales(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete cascade,
  due_amount numeric(12,2) not null check (due_amount >= 0),
  due_date date not null,
  status text not null default 'pending' check (status in ('pending','collected','overdue')),
  late_fee numeric(12,2) not null default 0 check (late_fee >= 0),
  created_at timestamptz not null default now()
);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.customers(id) on delete cascade,
  installment_id uuid references public.installments(id) on delete set null,
  amount numeric(12,2) not null check (amount > 0),
  payment_method text not null default 'cash' check (payment_method in ('cash','bank_transfer','card')),
  collected_at timestamptz not null default now()
);

create table if not exists public.staff (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  role text not null,
  shift text not null,
  attendance_pct numeric(5,2) not null default 100,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.application_settings (
  id text primary key default 'default' check (id = 'default'),
  default_daily_interest numeric(12,2) not null default 0 check (default_daily_interest >= 0),
  default_weekly_interest numeric(12,2) not null default 0 check (default_weekly_interest >= 0),
  default_monthly_interest numeric(12,2) not null default 0 check (default_monthly_interest >= 0),
  default_grace_period_days integer not null default 0 check (default_grace_period_days >= 0),
  fixed_late_fee numeric(12,2) not null default 0 check (fixed_late_fee >= 0),
  daily_late_fee numeric(12,2) not null default 0 check (daily_late_fee >= 0),
  maximum_late_fee numeric(12,2) not null default 0 check (maximum_late_fee >= 0),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

insert into public.application_settings (id) values ('default') on conflict (id) do nothing;

create table if not exists public.agreements (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete restrict,
  subtotal numeric(12,2) not null check (subtotal >= 0),
  product_discount numeric(12,2) not null default 0 check (product_discount >= 0),
  customer_discount numeric(12,2) not null default 0 check (customer_discount >= 0),
  final_price numeric(12,2) not null check (final_price >= 0),
  down_payment numeric(12,2) not null check (down_payment >= 0),
  remaining_principal numeric(12,2) not null check (remaining_principal >= 0),
  fixed_interest numeric(12,2) not null check (fixed_interest >= 0),
  total_repayment numeric(12,2) not null check (total_repayment >= 0),
  frequency text not null check (frequency in ('daily','weekly','monthly')),
  installment_count integer not null check (installment_count >= 1),
  first_due_date date not null,
  grace_period_days integer not null check (grace_period_days >= 0),
  fixed_late_fee numeric(12,2) not null check (fixed_late_fee >= 0),
  daily_late_fee numeric(12,2) not null check (daily_late_fee >= 0),
  maximum_late_fee numeric(12,2) not null check (maximum_late_fee >= 0),
  status text not null check (status in ('approved','pending_approval')),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.agreement_items (
  id uuid primary key default gen_random_uuid(),
  agreement_id uuid not null references public.agreements(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  product_name text not null,
  unit_price numeric(12,2) not null check (unit_price >= 0),
  quantity integer not null check (quantity > 0),
  line_total numeric(12,2) not null check (line_total >= 0),
  created_at timestamptz not null default now()
);

create table if not exists public.agreement_schedule (
  id uuid primary key default gen_random_uuid(),
  agreement_id uuid not null references public.agreements(id) on delete cascade,
  installment_number integer not null check (installment_number >= 1),
  due_date date not null,
  amount numeric(12,2) not null check (amount >= 0),
  interest_amount numeric(12,2) not null check (interest_amount >= 0),
  created_at timestamptz not null default now(),
  unique (agreement_id, installment_number)
);

create index if not exists agreements_customer_created_idx on public.agreements (customer_id, created_at desc);
create index if not exists agreement_schedule_due_date_idx on public.agreement_schedule (due_date);

alter table public.customers enable row level security;
alter table public.products enable row level security;
alter table public.sales enable row level security;
alter table public.installments enable row level security;
alter table public.payments enable row level security;
alter table public.staff enable row level security;
alter table public.application_settings enable row level security;
alter table public.agreements enable row level security;
alter table public.agreement_items enable row level security;
alter table public.agreement_schedule enable row level security;

create policy "Authenticated users can read customers" on public.customers for select using (auth.role() = 'authenticated');
create policy "Authenticated users can update customers" on public.customers for update using (auth.role() = 'authenticated');
create policy "Authenticated users can insert customers" on public.customers for insert with check (auth.role() = 'authenticated');

create policy "Authenticated users can read products" on public.products for select using (auth.role() = 'authenticated');
create policy "Authenticated users can update products" on public.products for update using (auth.role() = 'authenticated');
create policy "Authenticated users can insert products" on public.products for insert with check (auth.role() = 'authenticated');

create policy "Authenticated users can read sales" on public.sales for select using (auth.role() = 'authenticated');
create policy "Authenticated users can insert sales" on public.sales for insert with check (auth.role() = 'authenticated');

create policy "Authenticated users can read installments" on public.installments for select using (auth.role() = 'authenticated');
create policy "Authenticated users can update installments" on public.installments for update using (auth.role() = 'authenticated');

create policy "Authenticated users can read payments" on public.payments for select using (auth.role() = 'authenticated');
create policy "Authenticated users can insert payments" on public.payments for insert with check (auth.role() = 'authenticated');

create policy "Authenticated users can read staff" on public.staff for select using (auth.role() = 'authenticated');
create policy "Authenticated users can insert staff" on public.staff for insert with check (auth.role() = 'authenticated');

drop policy if exists "Authenticated users can read application settings" on public.application_settings;
drop policy if exists "Owners can read application settings" on public.application_settings;
create policy "Owners can read application settings" on public.application_settings
  for select using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'owner');
drop policy if exists "Owners can insert application settings" on public.application_settings;
create policy "Owners can insert application settings" on public.application_settings
  for insert with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'owner');
drop policy if exists "Owners can update application settings" on public.application_settings;
create policy "Owners can update application settings" on public.application_settings
  for update using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'owner')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'owner');

drop policy if exists "Authenticated users can read agreements" on public.agreements;
create policy "Authenticated users can read agreements" on public.agreements
  for select using (auth.role() = 'authenticated');
drop policy if exists "Authenticated users can read agreement items" on public.agreement_items;
create policy "Authenticated users can read agreement items" on public.agreement_items
  for select using (auth.role() = 'authenticated');
drop policy if exists "Authenticated users can read agreement schedules" on public.agreement_schedule;
create policy "Authenticated users can read agreement schedules" on public.agreement_schedule
  for select using (auth.role() = 'authenticated');

create or replace function public.get_agreement_interest_defaults()
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'default_daily_interest', default_daily_interest::text,
    'default_weekly_interest', default_weekly_interest::text,
    'default_monthly_interest', default_monthly_interest::text
  )
  from public.application_settings
  where id = 'default' and auth.uid() is not null;
$$;

revoke all on function public.get_agreement_interest_defaults() from public;
grant execute on function public.get_agreement_interest_defaults() to authenticated;

create or replace function public.create_installment_agreement(
  p_agreement jsonb,
  p_items jsonb,
  p_schedule jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_agreement_id uuid := gen_random_uuid();
  v_item jsonb;
  v_schedule jsonb;
  v_customer_id uuid;
  v_product_id uuid;
  v_quantity integer;
  v_product_name text;
  v_product_price numeric(12,2);
  v_subtotal numeric(12,2) := 0;
  v_product_discount numeric(12,2);
  v_customer_discount numeric(12,2);
  v_final_price numeric(12,2);
  v_down_payment numeric(12,2);
  v_remaining_principal numeric(12,2);
  v_fixed_interest numeric(12,2);
  v_total_repayment numeric(12,2);
  v_schedule_total numeric(12,2) := 0;
  v_interest_total numeric(12,2) := 0;
  v_schedule_count integer := 0;
  v_installment_count integer;
  v_first_due_date date;
  v_frequency text;
  v_expected_amount numeric(12,2);
  v_expected_interest numeric(12,2);
  v_expected_due_date date;
  v_grace_period_days integer;
  v_fixed_late_fee numeric(12,2);
  v_daily_late_fee numeric(12,2);
  v_maximum_late_fee numeric(12,2);
  v_status text;
begin
  if auth.uid() is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;
  if coalesce(jsonb_typeof(p_items), '') <> 'array'
      or coalesce(jsonb_typeof(p_schedule), '') <> 'array' then
    raise exception 'INVALID_AGREEMENT_LINES' using errcode = '22023';
  end if;
  if jsonb_array_length(p_items) < 1 then
    raise exception 'INVALID_AGREEMENT_LINES' using errcode = '22023';
  end if;

  v_customer_id := (p_agreement ->> 'customer_id')::uuid;
  if not exists (select 1 from public.customers where id = v_customer_id) then
    raise exception 'CUSTOMER_NOT_FOUND' using errcode = '22023';
  end if;

  v_product_discount := (p_agreement ->> 'product_discount')::numeric(12,2);
  v_customer_discount := (p_agreement ->> 'customer_discount')::numeric(12,2);
  v_down_payment := (p_agreement ->> 'down_payment')::numeric(12,2);
  v_fixed_interest := (p_agreement ->> 'fixed_interest')::numeric(12,2);
  v_installment_count := (p_agreement ->> 'installment_count')::integer;
  v_first_due_date := (p_agreement ->> 'first_due_date')::date;
  v_frequency := p_agreement ->> 'frequency';
  if v_product_discount < 0 or v_customer_discount < 0 or v_down_payment < 0 or v_fixed_interest < 0 then
    raise exception 'INVALID_AGREEMENT_AMOUNTS' using errcode = '22023';
  end if;
  if v_installment_count < 1 or v_installment_count > 1200
      or v_frequency not in ('daily', 'weekly', 'monthly') then
    raise exception 'INVALID_PAYMENT_TERMS' using errcode = '22023';
  end if;

  for v_item in select value from jsonb_array_elements(p_items) as items(value) loop
    v_product_id := (v_item ->> 'product_id')::uuid;
    v_quantity := (v_item ->> 'quantity')::integer;
    if v_quantity < 1 then raise exception 'INVALID_ITEM_QUANTITY' using errcode = '22023'; end if;

    update public.products
      set stock_quantity = stock_quantity - v_quantity,
          status = case
            when stock_quantity - v_quantity = 0 then 'critical'
            when stock_quantity - v_quantity <= reorder_level then 'low'
            else 'healthy'
          end,
          updated_at = now()
      where id = v_product_id and stock_quantity >= v_quantity
      returning name, price into v_product_name, v_product_price;
    if not found then
      raise exception 'INSUFFICIENT_STOCK' using errcode = 'P0001';
    end if;

    if v_product_price <> (v_item ->> 'unit_price')::numeric(12,2)
        or v_product_name <> (v_item ->> 'product_name')
        or v_product_price * v_quantity <> (v_item ->> 'line_total')::numeric(12,2) then
      raise exception 'PRODUCT_PRICE_CHANGED' using errcode = 'P0001';
    end if;
    v_subtotal := v_subtotal + v_product_price * v_quantity;
  end loop;

  v_final_price := v_subtotal - v_product_discount - v_customer_discount;
  if v_final_price < 0 or v_down_payment > v_final_price
      or v_subtotal <> (p_agreement ->> 'subtotal')::numeric(12,2)
      or v_final_price <> (p_agreement ->> 'final_price')::numeric(12,2)
      or v_final_price - v_down_payment <> (p_agreement ->> 'remaining_principal')::numeric(12,2) then
    raise exception 'INVALID_AGREEMENT_TOTALS' using errcode = '22023';
  end if;
  v_remaining_principal := v_final_price - v_down_payment;
  v_total_repayment := v_remaining_principal + v_fixed_interest;
  if v_total_repayment <> (p_agreement ->> 'total_repayment')::numeric(12,2) then
    raise exception 'INVALID_REPAYMENT_TOTAL' using errcode = '22023';
  end if;

  for v_schedule in select value from jsonb_array_elements(p_schedule) as rows(value) loop
    v_schedule_count := v_schedule_count + 1;
    v_expected_amount := trunc(v_total_repayment / v_installment_count, 2);
    v_expected_interest := trunc(v_fixed_interest / v_installment_count, 2);
    if v_schedule_count = v_installment_count then
      v_expected_amount := v_expected_amount + v_total_repayment - (trunc(v_total_repayment / v_installment_count, 2) * v_installment_count);
      v_expected_interest := v_expected_interest + v_fixed_interest - (trunc(v_fixed_interest / v_installment_count, 2) * v_installment_count);
    end if;
    v_expected_due_date := case v_frequency
      when 'daily' then v_first_due_date + (v_schedule_count - 1)
      when 'weekly' then v_first_due_date + ((v_schedule_count - 1) * 7)
      else (v_first_due_date + ((v_schedule_count - 1) * interval '1 month'))::date
    end;
    if (v_schedule ->> 'installment_number')::integer <> v_schedule_count
        or (v_schedule ->> 'due_date')::date <> v_expected_due_date
        or (v_schedule ->> 'amount')::numeric(12,2) <> v_expected_amount
        or (v_schedule ->> 'interest_amount')::numeric(12,2) <> v_expected_interest then
      raise exception 'INVALID_AGREEMENT_SCHEDULE_ROW' using errcode = '22023';
    end if;
    v_schedule_total := v_schedule_total + (v_schedule ->> 'amount')::numeric(12,2);
    v_interest_total := v_interest_total + (v_schedule ->> 'interest_amount')::numeric(12,2);
  end loop;
  if (v_total_repayment > 0 and v_schedule_count <> v_installment_count)
      or (v_total_repayment = 0 and v_schedule_count <> 0)
      or v_schedule_total <> v_total_repayment
      or v_interest_total <> v_fixed_interest then
    raise exception 'INVALID_AGREEMENT_SCHEDULE' using errcode = '22023';
  end if;

  select default_grace_period_days, fixed_late_fee, daily_late_fee, maximum_late_fee
    into v_grace_period_days, v_fixed_late_fee, v_daily_late_fee, v_maximum_late_fee
    from public.application_settings where id = 'default';
  if not found then raise exception 'APPLICATION_SETTINGS_NOT_FOUND' using errcode = 'P0001'; end if;

  v_status := case
    when (auth.jwt() -> 'app_metadata' ->> 'role') = 'owner'
      or (v_product_discount = 0 and v_customer_discount = 0) then 'approved'
    else 'pending_approval'
  end;
  insert into public.agreements (
    id, customer_id, subtotal, product_discount, customer_discount, final_price,
    down_payment, remaining_principal, fixed_interest, total_repayment, frequency,
    installment_count, first_due_date, grace_period_days, fixed_late_fee,
    daily_late_fee, maximum_late_fee, status, created_by
  ) values (
    v_agreement_id, v_customer_id, v_subtotal, v_product_discount, v_customer_discount,
    v_final_price, v_down_payment, v_remaining_principal, v_fixed_interest, v_total_repayment,
    v_frequency, v_installment_count,
    v_first_due_date, v_grace_period_days, v_fixed_late_fee,
    v_daily_late_fee, v_maximum_late_fee, v_status, auth.uid()
  );

  for v_item in select value from jsonb_array_elements(p_items) as items(value) loop
    insert into public.agreement_items (
      agreement_id, product_id, product_name, unit_price, quantity, line_total
    ) values (
      v_agreement_id,
      (v_item ->> 'product_id')::uuid,
      v_item ->> 'product_name',
      (v_item ->> 'unit_price')::numeric(12,2),
      (v_item ->> 'quantity')::integer,
      (v_item ->> 'line_total')::numeric(12,2)
    );
  end loop;

  for v_schedule in select value from jsonb_array_elements(p_schedule) as rows(value) loop
    insert into public.agreement_schedule (
      agreement_id, installment_number, due_date, amount, interest_amount
    ) values (
      v_agreement_id,
      (v_schedule ->> 'installment_number')::integer,
      (v_schedule ->> 'due_date')::date,
      (v_schedule ->> 'amount')::numeric(12,2),
      (v_schedule ->> 'interest_amount')::numeric(12,2)
    );
  end loop;

  return v_agreement_id;
end;
$$;

revoke all on function public.create_installment_agreement(jsonb, jsonb, jsonb) from public;
grant execute on function public.create_installment_agreement(jsonb, jsonb, jsonb) to authenticated;
