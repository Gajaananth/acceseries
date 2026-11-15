create table if not exists public.roles (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (name in ('owner', 'staff')),
  created_at timestamptz not null default now()
);

create table if not exists public.permissions (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  description text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.role_permissions (
  role_id uuid not null references public.roles(id) on delete cascade,
  permission_id uuid not null references public.permissions(id) on delete cascade,
  primary key (role_id, permission_id)
);

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role_id uuid not null references public.roles(id) on delete restrict,
  full_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.roles (name) values ('owner'), ('staff') on conflict (name) do nothing;

insert into public.permissions (key, description) values
  ('customers:read', 'View customer records'),
  ('customers:write', 'Create and update customer records'),
  ('products:read', 'View product catalog'),
  ('products:write', 'Manage products and stock'),
  ('agreements:read', 'View installment agreements'),
  ('agreements:create', 'Create installment agreements'),
  ('sales:read', 'View sales'),
  ('sales:create', 'Create sales'),
  ('payments:read', 'View payments'),
  ('payments:write', 'Record and reverse payments'),
  ('staff:manage', 'Manage staff'),
  ('settings:manage', 'Manage application settings')
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.name = 'owner'
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.key in (
  'customers:read', 'customers:write', 'products:read',
  'agreements:read', 'agreements:create', 'sales:read',
  'sales:create', 'payments:read', 'payments:write'
)
where r.name = 'staff'
on conflict do nothing;

insert into public.profiles (user_id, role_id, full_name)
select u.id,
       r.id,
       nullif(btrim(u.raw_user_meta_data ->> 'full_name'), '')
from auth.users u
join public.roles r
  on r.name = case when u.raw_app_meta_data ->> 'role' = 'owner' then 'owner' else 'staff' end
on conflict (user_id) do nothing;

create or replace function public.is_owner()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.profiles p
    join public.roles r on r.id = p.role_id
    where p.user_id = auth.uid() and r.name = 'owner'
  );
$$;

create or replace function public.has_permission(p_permission text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.profiles p
    join public.role_permissions rp on rp.role_id = p.role_id
    join public.permissions perm on perm.id = rp.permission_id
    where p.user_id = auth.uid() and perm.key = p_permission
  );
$$;

create or replace function public.assign_default_staff_profile()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role_id uuid;
begin
  select id into v_role_id from public.roles where name = 'staff';
  insert into public.profiles (user_id, role_id, full_name)
  values (new.id, v_role_id, nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''))
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists auth_user_profile_created on auth.users;
create trigger auth_user_profile_created
after insert on auth.users
for each row execute function public.assign_default_staff_profile();

create table if not exists public.sale_items (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  product_name text not null,
  unit_price numeric(12,2) not null check (unit_price >= 0),
  quantity integer not null check (quantity > 0),
  line_total numeric(12,2) not null check (line_total >= 0),
  created_at timestamptz not null default now()
);

create table if not exists public.payment_allocations (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments(id) on delete restrict,
  installment_id uuid not null references public.installments(id) on delete restrict,
  amount numeric(12,2) not null check (amount > 0),
  created_at timestamptz not null default now(),
  unique (payment_id, installment_id)
);

create table if not exists public.discounts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  amount numeric(12,2) not null check (amount >= 0),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.discount_approvals (
  id uuid primary key default gen_random_uuid(),
  agreement_id uuid not null references public.agreements(id) on delete cascade,
  requested_by uuid references auth.users(id) on delete set null,
  approved_by uuid references auth.users(id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.create_discount_approval_request()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'pending_approval'
      and (new.product_discount > 0 or new.customer_discount > 0) then
    insert into public.discount_approvals (agreement_id, requested_by, status)
    values (new.id, new.created_by, 'pending');
  end if;
  return new;
end;
$$;

drop trigger if exists agreements_discount_approval_request on public.agreements;
create trigger agreements_discount_approval_request
after insert on public.agreements
for each row execute function public.create_discount_approval_request();

create table if not exists public.late_fee_records (
  id uuid primary key default gen_random_uuid(),
  installment_id uuid not null references public.installments(id) on delete restrict,
  amount numeric(12,2) not null check (amount >= 0),
  assessed_at timestamptz not null default now(),
  reversed_at timestamptz,
  created_by uuid references auth.users(id) on delete set null
);

create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  description text not null,
  amount numeric(12,2) not null check (amount >= 0),
  category text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.activity_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.payment_methods (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

insert into public.payment_methods (key, name) values
  ('cash', 'Cash'), ('bank_transfer', 'Bank transfer'), ('card', 'Card')
on conflict (key) do nothing;

create table if not exists public.idempotency_records (
  user_id uuid not null references auth.users(id) on delete cascade,
  operation text not null,
  idempotency_key text not null,
  request_hash text not null,
  response jsonb,
  created_at timestamptz not null default now(),
  primary key (user_id, operation, idempotency_key)
);

create table if not exists public.customer_balance_snapshots (
  customer_id uuid primary key references public.customers(id) on delete restrict,
  balance numeric(12,2) not null check (balance >= 0),
  status text not null check (status in ('active', 'on_track', 'overdue')),
  as_of timestamptz not null default now()
);

insert into public.customer_balance_snapshots (customer_id, balance, status, as_of)
select id, coalesce(current_balance, 0), coalesce(status, 'active'), now()
from public.customers
on conflict (customer_id) do nothing;

alter table public.payments
  add column if not exists agreement_id uuid references public.agreements(id) on delete restrict,
  add column if not exists reversed_at timestamptz,
  add column if not exists reversed_by uuid references auth.users(id) on delete set null,
  add column if not exists reversal_reason text;
alter table public.payment_allocations
  alter column installment_id drop not null,
  add column if not exists agreement_schedule_id uuid references public.agreement_schedule(id) on delete restrict;
alter table public.payment_allocations
  drop constraint if exists payment_allocations_one_target_check,
  add constraint payment_allocations_one_target_check
    check ((installment_id is not null) <> (agreement_schedule_id is not null));

create table if not exists public.stock_override_audit (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id) on delete restrict,
  product_id uuid not null references public.products(id) on delete restrict,
  available_quantity integer not null check (available_quantity >= 0),
  sold_quantity integer not null check (sold_quantity > available_quantity),
  shortfall integer not null check (shortfall = sold_quantity - available_quantity),
  approved_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create or replace view public.installment_agreements
with (security_invoker = true)
as select * from public.agreements;

create or replace view public.installment_schedule
with (security_invoker = true)
as select * from public.agreement_schedule;

create or replace view public.inventory
with (security_invoker = true)
as select id as product_id, quantity, min_stock, updated_at from public.products;
grant select on public.installment_agreements, public.installment_schedule, public.inventory to authenticated;

alter table public.customers drop column if exists current_balance;
alter table public.customers drop column if exists status;

create or replace function public.update_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

do $triggers$
declare
  v_table text;
begin
  foreach v_table in array array['profiles', 'customers', 'products', 'application_settings', 'discount_approvals'] loop
    if exists (
      select 1
      from information_schema.columns
      where table_schema = 'public' and table_name = v_table and column_name = 'updated_at'
    ) then
      execute format('drop trigger if exists set_updated_at on public.%I', v_table);
      execute format(
        'create trigger set_updated_at before update on public.%I for each row execute function public.update_updated_at()',
        v_table
      );
    end if;
  end loop;
end $triggers$;

do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'profiles', 'roles', 'permissions', 'role_permissions',
    'customers', 'categories', 'products', 'stock_movements',
    'sales', 'sale_items', 'agreements', 'agreement_items',
    'agreement_schedule', 'installments', 'payments',
    'payment_allocations', 'discounts', 'discount_approvals',
    'late_fee_records', 'expenses', 'activity_logs',
    'application_settings', 'payment_methods', 'idempotency_records', 'staff',
    'stock_override_audit', 'customer_balance_snapshots'
  ] loop
    execute format('alter table public.%I enable row level security', v_table);
    execute format('drop policy if exists "Authenticated users can read %s" on public.%I', v_table, v_table);
    execute format('drop policy if exists "Authenticated users can insert %s" on public.%I', v_table, v_table);
    execute format('drop policy if exists "Authenticated users can update %s" on public.%I', v_table, v_table);
  end loop;
end $$;

do $$
declare
  v_policy record;
begin
  for v_policy in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename = any (array[
        'profiles', 'roles', 'permissions', 'role_permissions',
        'customers', 'categories', 'products', 'stock_movements',
        'sales', 'sale_items', 'agreements', 'agreement_items',
        'agreement_schedule', 'installments', 'payments',
        'payment_allocations', 'discounts', 'discount_approvals',
        'late_fee_records', 'expenses', 'activity_logs',
        'application_settings', 'payment_methods', 'idempotency_records', 'staff',
        'stock_override_audit', 'customer_balance_snapshots'
      ])
  loop
    execute format('drop policy %I on %I.%I', v_policy.policyname, v_policy.schemaname, v_policy.tablename);
  end loop;
end $$;

create policy "Profiles can be read by account owner or owner role" on public.profiles
  for select to authenticated using (user_id = auth.uid() or public.is_owner());
create policy "Authenticated users can read roles" on public.roles
  for select to authenticated using (auth.uid() is not null);
create policy "Authenticated users can read permissions" on public.permissions
  for select to authenticated using (auth.uid() is not null);
create policy "Authenticated users can read role permissions" on public.role_permissions
  for select to authenticated using (auth.uid() is not null);

create policy "Authenticated users can read customers" on public.customers
  for select to authenticated using (public.has_permission('customers:read') or public.has_permission('customers:write'));
create policy "Customer writers can create customers" on public.customers
  for insert to authenticated with check (public.has_permission('customers:write'));
create policy "Customer writers can update customers" on public.customers
  for update to authenticated using (public.has_permission('customers:write'))
  with check (public.has_permission('customers:write'));
create policy "Customer readers can read balance snapshots" on public.customer_balance_snapshots
  for select to authenticated using (
    public.has_permission('customers:read') or public.has_permission('customers:write')
  );

create policy "Authenticated users can read categories" on public.categories
  for select to authenticated using (public.has_permission('products:read') or public.has_permission('products:write'));
create policy "Product writers can create categories" on public.categories
  for insert to authenticated with check (public.has_permission('products:write'));
create policy "Authenticated users can read products" on public.products
  for select to authenticated using (
    public.has_permission('products:read') or public.has_permission('products:write')
  );
create policy "Authenticated users can read stock movements" on public.stock_movements
  for select to authenticated using (public.has_permission('products:read') or public.has_permission('products:write'));

create policy "Authenticated users can read sales" on public.sales
  for select to authenticated using (public.has_permission('sales:read'));
create policy "Authenticated users can read sale items" on public.sale_items
  for select to authenticated using (public.has_permission('sales:read'));
create policy "Authenticated users can read agreements" on public.agreements
  for select to authenticated using (public.has_permission('agreements:read'));
create policy "Authenticated users can read agreement items" on public.agreement_items
  for select to authenticated using (public.has_permission('agreements:read'));
create policy "Authenticated users can read agreement schedules" on public.agreement_schedule
  for select to authenticated using (public.has_permission('agreements:read'));
create policy "Authenticated users can read installments" on public.installments
  for select to authenticated using (public.has_permission('payments:read'));
create policy "Authenticated users can read payments" on public.payments
  for select to authenticated using (public.has_permission('payments:read'));
create policy "Authenticated users can read payment allocations" on public.payment_allocations
  for select to authenticated using (public.has_permission('payments:read'));
create policy "Owners can read application settings" on public.application_settings
  for select to authenticated using (public.is_owner());

create policy "Owners can manage staff" on public.staff
  for all to authenticated using (public.has_permission('staff:manage'))
  with check (public.has_permission('staff:manage'));
create policy "Owners can manage discounts" on public.discounts
  for all to authenticated using (public.is_owner()) with check (public.is_owner());
create policy "Owners can manage discount approvals" on public.discount_approvals
  for all to authenticated using (public.is_owner()) with check (public.is_owner());
create policy "Owners can manage expenses" on public.expenses
  for all to authenticated using (public.is_owner()) with check (public.is_owner());
create policy "Authenticated users can read activity logs" on public.activity_logs
  for select to authenticated using (auth.uid() is not null);
create policy "Owners can read stock override audit" on public.stock_override_audit
  for select to authenticated using (public.is_owner());
create policy "Authenticated users can read payment methods" on public.payment_methods
  for select to authenticated using (auth.uid() is not null);

drop policy if exists "Owners can read application settings" on public.application_settings;
create policy "Owners can read application settings" on public.application_settings
  for select to authenticated using (public.is_owner());

drop policy if exists "Product managers can insert categories" on public.categories;
create policy "Product managers can insert categories" on public.categories
  for insert to authenticated with check (public.has_permission('products:write'));

drop policy if exists "Product managers can upload product images" on storage.objects;
create policy "Product managers can upload product images" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'product-images' and public.has_permission('products:write')
  );
drop policy if exists "Product managers can update product images" on storage.objects;
create policy "Product managers can update product images" on storage.objects
  for update to authenticated using (
    bucket_id = 'product-images' and public.has_permission('products:write')
  ) with check (bucket_id = 'product-images' and public.has_permission('products:write'));
drop policy if exists "Product managers can delete product images" on storage.objects;
create policy "Product managers can delete product images" on storage.objects
  for delete to authenticated using (
    bucket_id = 'product-images' and public.has_permission('products:write')
  );

create or replace function public.update_application_settings(p_settings jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_settings public.application_settings;
begin
  if auth.uid() is null or not public.is_owner() then
    raise exception 'SETTINGS_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  insert into public.application_settings (
    id, default_daily_interest, default_weekly_interest, default_monthly_interest,
    default_grace_period_days, fixed_late_fee, daily_late_fee, maximum_late_fee, updated_by, updated_at
  ) values (
    'default',
    (p_settings ->> 'default_daily_interest')::numeric(12,2),
    (p_settings ->> 'default_weekly_interest')::numeric(12,2),
    (p_settings ->> 'default_monthly_interest')::numeric(12,2),
    (p_settings ->> 'default_grace_period_days')::integer,
    (p_settings ->> 'fixed_late_fee')::numeric(12,2),
    (p_settings ->> 'daily_late_fee')::numeric(12,2),
    (p_settings ->> 'maximum_late_fee')::numeric(12,2),
    auth.uid(), now()
  )
  on conflict (id) do update set
    default_daily_interest = excluded.default_daily_interest,
    default_weekly_interest = excluded.default_weekly_interest,
    default_monthly_interest = excluded.default_monthly_interest,
    default_grace_period_days = excluded.default_grace_period_days,
    fixed_late_fee = excluded.fixed_late_fee,
    daily_late_fee = excluded.daily_late_fee,
    maximum_late_fee = excluded.maximum_late_fee,
    updated_by = auth.uid(),
    updated_at = now()
  returning * into v_settings;
  return to_jsonb(v_settings);
end;
$$;

create or replace function public.create_installment_agreement_idempotent(
  p_idempotency_key text,
  p_request_hash text,
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
  v_request_hash text;
  v_response jsonb;
  v_agreement_id uuid;
begin
  if auth.uid() is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501'; end if;
  if length(p_idempotency_key) not between 1 and 200 or length(p_request_hash) <> 64 then
    raise exception 'INVALID_IDEMPOTENCY_KEY' using errcode = '22023';
  end if;

  insert into public.idempotency_records (user_id, operation, idempotency_key, request_hash)
  values (auth.uid(), 'create_installment_agreement', p_idempotency_key, p_request_hash)
  on conflict do nothing;

  select request_hash, response
    into v_request_hash, v_response
    from public.idempotency_records
    where user_id = auth.uid()
      and operation = 'create_installment_agreement'
      and idempotency_key = p_idempotency_key
    for update;
  if v_request_hash <> p_request_hash then
    raise exception 'IDEMPOTENCY_KEY_REUSED' using errcode = '22023';
  end if;
  if v_response is not null then return (v_response ->> 'id')::uuid; end if;

  v_agreement_id := public.create_installment_agreement(p_agreement, p_items, p_schedule);
  update public.idempotency_records
  set response = jsonb_build_object('id', v_agreement_id)
  where user_id = auth.uid()
    and operation = 'create_installment_agreement'
    and idempotency_key = p_idempotency_key;
  return v_agreement_id;
end;
$$;

create or replace function public.create_sale(
  p_sale jsonb,
  p_items jsonb,
  p_allow_negative_stock boolean,
  p_idempotency_key text,
  p_request_hash text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sale_id uuid;
  v_response jsonb;
  v_saved_hash text;
  v_item jsonb;
  v_product_id uuid;
  v_product_name text;
  v_price numeric(12,2);
  v_available integer;
  v_quantity integer;
  v_discount numeric(12,2);
  v_subtotal numeric(12,2) := 0;
  v_total numeric(12,2);
  v_payment_type text;
  v_customer_id uuid;
  v_shortfall integer;
begin
  if auth.uid() is null or not public.has_permission('sales:create') then
    raise exception 'SALES_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  if length(p_idempotency_key) not between 1 and 200 or length(p_request_hash) <> 64
      or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) < 1 then
    raise exception 'INVALID_SALE' using errcode = '22023';
  end if;
  insert into public.idempotency_records (user_id, operation, idempotency_key, request_hash)
  values (auth.uid(), 'create_sale', p_idempotency_key, p_request_hash)
  on conflict do nothing;
  select request_hash, response into v_saved_hash, v_response
  from public.idempotency_records
  where user_id = auth.uid() and operation = 'create_sale' and idempotency_key = p_idempotency_key
  for update;
  if v_saved_hash <> p_request_hash then raise exception 'IDEMPOTENCY_KEY_REUSED' using errcode = '22023'; end if;
  if v_response is not null then return (v_response ->> 'id')::uuid; end if;

  v_discount := (p_sale ->> 'discount_amount')::numeric(12,2);
  v_payment_type := p_sale ->> 'payment_type';
  v_customer_id := nullif(p_sale ->> 'customer_id', '')::uuid;
  if v_discount is null or v_discount < 0 or v_payment_type is null
      or v_payment_type not in ('cash', 'installment') then
    raise exception 'INVALID_SALE' using errcode = '22023';
  end if;
  if v_customer_id is not null and not exists (select 1 from public.customers where id = v_customer_id) then
    raise exception 'CUSTOMER_NOT_FOUND' using errcode = '22023';
  end if;

  for v_item in select value from jsonb_array_elements(p_items) as rows(value) loop
    v_product_id := (v_item ->> 'product_id')::uuid;
    v_quantity := (v_item ->> 'quantity')::integer;
    if v_quantity < 1 then raise exception 'INVALID_ITEM_QUANTITY' using errcode = '22023'; end if;
    select name, price, stock_quantity into v_product_name, v_price, v_available
    from public.products where id = v_product_id and status = 'active' for update;
    if not found then raise exception 'PRODUCT_NOT_FOUND' using errcode = 'P0002'; end if;
    v_subtotal := v_subtotal + v_price * v_quantity;
  end loop;
  if v_discount > v_subtotal then raise exception 'DISCOUNT_EXCEEDS_SUBTOTAL' using errcode = '22023'; end if;
  v_total := v_subtotal - v_discount;

  insert into public.sales (customer_id, total_amount, payment_type, discount_amount, status)
  values (v_customer_id, v_total, v_payment_type, v_discount, case when v_payment_type = 'cash' then 'paid' else 'pending' end)
  returning id into v_sale_id;

  for v_item in select value from jsonb_array_elements(p_items) as rows(value) loop
    v_product_id := (v_item ->> 'product_id')::uuid;
    v_quantity := (v_item ->> 'quantity')::integer;
    select name, price, stock_quantity into v_product_name, v_price, v_available
    from public.products where id = v_product_id and status = 'active' for update;
    if v_available < v_quantity then
      if p_allow_negative_stock is not true or not public.is_owner() then
        raise exception 'INSUFFICIENT_STOCK' using errcode = 'P0001';
      end if;
      v_shortfall := v_quantity - v_available;
    else
      v_shortfall := 0;
    end if;
    perform set_config('app.stock_movement_type', 'adjust', true);
    perform set_config('app.stock_movement_reason', 'Sale ' || v_sale_id::text, true);
    update public.products
    set stock_quantity = greatest(0, stock_quantity - v_quantity),
        status = case
          when greatest(0, stock_quantity - v_quantity) = 0 then 'critical'
          when greatest(0, stock_quantity - v_quantity) <= reorder_level then 'low'
          else 'healthy'
        end,
        updated_at = now()
    where id = v_product_id;
    insert into public.sale_items (sale_id, product_id, product_name, unit_price, quantity, line_total)
    values (v_sale_id, v_product_id, v_product_name, v_price, v_quantity, v_price * v_quantity);
    if v_shortfall > 0 then
      insert into public.stock_override_audit (sale_id, product_id, available_quantity, sold_quantity, shortfall, approved_by)
      values (v_sale_id, v_product_id, v_available, v_quantity, v_shortfall, auth.uid());
    end if;
  end loop;

  insert into public.activity_logs (user_id, action, entity_type, entity_id, details)
  values (auth.uid(), 'sale.created', 'sale', v_sale_id, jsonb_build_object('stock_override', p_allow_negative_stock));
  update public.idempotency_records
  set response = jsonb_build_object('id', v_sale_id)
  where user_id = auth.uid() and operation = 'create_sale' and idempotency_key = p_idempotency_key;
  return v_sale_id;
end;
$$;

create or replace function public.record_payment(
  p_agreement_id uuid,
  p_amount numeric(12,2),
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
  v_customer_id uuid;
  v_response jsonb;
  v_saved_hash text;
  v_schedule record;
  v_paid numeric(12,2);
  v_outstanding numeric(12,2);
  v_remaining numeric(12,2);
  v_allocation numeric(12,2);
begin
  if auth.uid() is null or not public.has_permission('payments:write') then
    raise exception 'PAYMENT_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  if p_amount <= 0 or length(p_idempotency_key) not between 1 and 200 or length(p_request_hash) <> 64
      or p_payment_method not in ('cash', 'bank_transfer', 'card') then
    raise exception 'INVALID_PAYMENT' using errcode = '22023';
  end if;
  insert into public.idempotency_records (user_id, operation, idempotency_key, request_hash)
  values (auth.uid(), 'record_payment', p_idempotency_key, p_request_hash)
  on conflict do nothing;
  select request_hash, response into v_saved_hash, v_response
  from public.idempotency_records
  where user_id = auth.uid() and operation = 'record_payment' and idempotency_key = p_idempotency_key
  for update;
  if v_saved_hash <> p_request_hash then raise exception 'IDEMPOTENCY_KEY_REUSED' using errcode = '22023'; end if;
  if v_response is not null then return (v_response ->> 'id')::uuid; end if;

  select customer_id into v_customer_id
  from public.agreements where id = p_agreement_id and status = 'approved' for update;
  if not found then raise exception 'AGREEMENT_NOT_PAYABLE' using errcode = 'P0002'; end if;
  select coalesce(sum(s.amount - coalesce(paid.amount, 0)), 0) into v_outstanding
  from public.agreement_schedule s
  left join lateral (
    select sum(pa.amount) as amount
    from public.payment_allocations pa
    join public.payments p on p.id = pa.payment_id and p.reversed_at is null
    where pa.agreement_schedule_id = s.id
  ) paid on true
  where s.agreement_id = p_agreement_id;
  if p_amount > v_outstanding then raise exception 'PAYMENT_EXCEEDS_BALANCE' using errcode = '22023'; end if;

  insert into public.payments (customer_id, agreement_id, amount, payment_method, collected_at)
  values (v_customer_id, p_agreement_id, p_amount, p_payment_method, now())
  returning id into v_payment_id;
  v_remaining := p_amount;
  for v_schedule in
    select s.id, s.amount
    from public.agreement_schedule s
    where s.agreement_id = p_agreement_id
    order by s.due_date, s.installment_number
    for update
  loop
    select coalesce(sum(pa.amount), 0) into v_paid
    from public.payment_allocations pa
    join public.payments p on p.id = pa.payment_id and p.reversed_at is null
    where pa.agreement_schedule_id = v_schedule.id;
    v_allocation := least(v_remaining, greatest(0, v_schedule.amount - v_paid));
    if v_allocation > 0 then
      insert into public.payment_allocations (payment_id, agreement_schedule_id, amount)
      values (v_payment_id, v_schedule.id, v_allocation);
      v_remaining := v_remaining - v_allocation;
    end if;
    exit when v_remaining = 0;
  end loop;
  if v_remaining <> 0 then raise exception 'PAYMENT_ALLOCATION_FAILED' using errcode = '22023'; end if;
  insert into public.activity_logs (user_id, action, entity_type, entity_id, details)
  values (auth.uid(), 'payment.recorded', 'payment', v_payment_id,
          jsonb_build_object('agreement_id', p_agreement_id, 'amount', p_amount));
  update public.idempotency_records
  set response = jsonb_build_object('id', v_payment_id)
  where user_id = auth.uid() and operation = 'record_payment' and idempotency_key = p_idempotency_key;
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
  v_installment_id uuid;
  v_installment_due numeric(12,2);
  v_installment_paid numeric(12,2);
begin
  if auth.uid() is null or not public.has_permission('payments:write') then
    raise exception 'PAYMENT_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  if length(btrim(p_reason)) < 2 or length(p_idempotency_key) not between 1 and 200 or length(p_request_hash) <> 64 then
    raise exception 'INVALID_PAYMENT_REVERSAL' using errcode = '22023';
  end if;
  insert into public.idempotency_records (user_id, operation, idempotency_key, request_hash)
  values (auth.uid(), 'reverse_payment', p_idempotency_key, p_request_hash)
  on conflict do nothing;
  select request_hash, response into v_saved_hash, v_response
  from public.idempotency_records
  where user_id = auth.uid() and operation = 'reverse_payment' and idempotency_key = p_idempotency_key
  for update;
  if v_saved_hash <> p_request_hash then raise exception 'IDEMPOTENCY_KEY_REUSED' using errcode = '22023'; end if;
  if v_response is not null then return (v_response ->> 'id')::uuid; end if;

  update public.payments
  set reversed_at = now(), reversed_by = auth.uid(), reversal_reason = btrim(p_reason)
  where id = p_payment_id and reversed_at is null
  returning agreement_id, installment_id into v_agreement_id, v_installment_id;
  if not found then raise exception 'PAYMENT_NOT_FOUND_OR_REVERSED' using errcode = 'P0002'; end if;
  if v_agreement_id is not null then
    update public.agreements set status = 'approved' where id = v_agreement_id and status = 'settled';
  end if;
  if v_installment_id is not null then
    select due_amount into v_installment_due from public.installments where id = v_installment_id;
    select coalesce(sum(amount), 0) into v_installment_paid
    from public.payments where installment_id = v_installment_id and reversed_at is null;
    update public.installments
    set status = case
      when v_installment_paid >= v_installment_due then 'collected'
      when due_date < current_date then 'overdue'
      else 'pending'
    end
    where id = v_installment_id;
  end if;
  insert into public.activity_logs (user_id, action, entity_type, entity_id, details)
  values (auth.uid(), 'payment.reversed', 'payment', p_payment_id, jsonb_build_object('reason', btrim(p_reason)));
  update public.idempotency_records
  set response = jsonb_build_object('id', p_payment_id)
  where user_id = auth.uid() and operation = 'reverse_payment' and idempotency_key = p_idempotency_key;
  return p_payment_id;
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
  if p_payment_method not in ('cash', 'bank_transfer', 'card')
      or length(p_idempotency_key) not between 1 and 180 or length(p_request_hash) <> 64 then
    raise exception 'INVALID_SETTLEMENT' using errcode = '22023';
  end if;
  insert into public.idempotency_records (user_id, operation, idempotency_key, request_hash)
  values (auth.uid(), 'settle_agreement', p_idempotency_key, p_request_hash)
  on conflict do nothing;
  select request_hash, response into v_saved_hash, v_response
  from public.idempotency_records
  where user_id = auth.uid() and operation = 'settle_agreement' and idempotency_key = p_idempotency_key
  for update;
  if v_saved_hash <> p_request_hash then raise exception 'IDEMPOTENCY_KEY_REUSED' using errcode = '22023'; end if;
  if v_response is not null then return nullif(v_response ->> 'id', '')::uuid; end if;

  select coalesce(sum(s.amount - coalesce(paid.amount, 0)), 0) into v_outstanding
  from public.agreement_schedule s
  left join lateral (
    select sum(pa.amount) as amount
    from public.payment_allocations pa
    join public.payments p on p.id = pa.payment_id and p.reversed_at is null
    where pa.agreement_schedule_id = s.id
  ) paid on true
  where s.agreement_id = p_agreement_id;
  select status into v_agreement_status
  from public.agreements where id = p_agreement_id for update;
  if not found or v_agreement_status <> 'approved' then
    raise exception 'AGREEMENT_NOT_PAYABLE' using errcode = 'P0002';
  end if;
  if v_outstanding > 0 then
    v_payment_id := public.record_payment(
      p_agreement_id,
      v_outstanding,
      p_payment_method,
      'settlement:' || p_idempotency_key,
      p_request_hash
    );
  end if;
  update public.agreements set status = 'settled' where id = p_agreement_id;
  insert into public.activity_logs (user_id, action, entity_type, entity_id, details)
  values (auth.uid(), 'agreement.settled', 'agreement', p_agreement_id,
          jsonb_build_object('payment_id', v_payment_id));
  update public.idempotency_records
  set response = jsonb_build_object('id', coalesce(v_payment_id::text, ''))
  where user_id = auth.uid() and operation = 'settle_agreement' and idempotency_key = p_idempotency_key;
  return v_payment_id;
end;
$$;

revoke all on function public.update_application_settings(jsonb) from public;
grant execute on function public.update_application_settings(jsonb) to authenticated;
revoke all on function public.create_installment_agreement_idempotent(text, text, jsonb, jsonb, jsonb) from public;
grant execute on function public.create_installment_agreement_idempotent(text, text, jsonb, jsonb, jsonb) to authenticated;
revoke all on function public.create_sale(jsonb, jsonb, boolean, text, text) from public;
grant execute on function public.create_sale(jsonb, jsonb, boolean, text, text) to authenticated;
revoke all on function public.record_payment(uuid, numeric, text, text, text) from public;
grant execute on function public.record_payment(uuid, numeric, text, text, text) to authenticated;
revoke all on function public.reverse_payment(uuid, text, text, text) from public;
grant execute on function public.reverse_payment(uuid, text, text, text) to authenticated;
revoke all on function public.settle_agreement(uuid, text, text, text) from public;
grant execute on function public.settle_agreement(uuid, text, text, text) to authenticated;

do $migration$
declare
  v_function regprocedure;
  v_definition text;
begin
  foreach v_function in array array[
    'public.create_product_with_opening_stock(jsonb,text)'::regprocedure,
    'public.update_product_catalog(uuid,jsonb,text,boolean)'::regprocedure,
    'public.archive_product(uuid)'::regprocedure,
    'public.adjust_product_stock(uuid,text,integer,text)'::regprocedure
  ] loop
    v_definition := pg_get_functiondef(v_function);
    v_definition := replace(
      v_definition,
      $match$    (auth.jwt() -> 'app_metadata' ->> 'role') = 'owner'
    or coalesce(auth.jwt() -> 'app_metadata' -> 'permissions', '[]'::jsonb) ? 'products:write'$match$,
      $replacement$    public.has_permission('products:write')$replacement$
    );
    if position('app_metadata' in v_definition) > 0 then
      raise exception 'Unable to replace legacy product permissions in function %', v_function;
    end if;
    execute v_definition;
  end loop;

  v_definition := pg_get_functiondef('public.create_installment_agreement(jsonb,jsonb,jsonb)'::regprocedure);
  v_definition := replace(v_definition,
    $match$when (auth.jwt() -> 'app_metadata' ->> 'role') = 'owner'$match$,
    $replacement$when public.is_owner()$replacement$
  );
  v_definition := replace(v_definition,
    $match$  if auth.uid() is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;$match$,
    $replacement$  if auth.uid() is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;
  if not public.has_permission('agreements:create') then
    raise exception 'AGREEMENT_PERMISSION_REQUIRED' using errcode = '42501';
  end if;$replacement$
  );
  if position('app_metadata' in v_definition) > 0 then
    raise exception 'Unable to replace legacy agreement permissions';
  end if;
  execute v_definition;
end $migration$;

revoke all on function public.is_owner() from public;
revoke all on function public.has_permission(text) from public;
grant execute on function public.is_owner() to authenticated;
grant execute on function public.has_permission(text) to authenticated;
