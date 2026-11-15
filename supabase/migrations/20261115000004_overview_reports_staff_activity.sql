insert into public.permissions (key, description) values
  ('receipts:print', 'Print and download payment receipts'),
  ('reports:sales', 'View sales reports'),
  ('reports:balances', 'View balance reports'),
  ('reports:late_fees', 'View late-fee collection reports'),
  ('reports:overdue', 'View overdue reports'),
  ('reports:collections', 'View collection reports'),
  ('reports:inventory', 'View inventory valuation reports'),
  ('reports:low_stock', 'View low-stock reports'),
  ('reports:staff', 'View staff performance reports'),
  ('reports:discounts', 'View discount approval reports'),
  ('reports:expenses', 'View expense reports'),
  ('reports:profit', 'View estimated profit reports')
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.name = 'owner'
on conflict do nothing;

create table if not exists public.user_permissions (
  user_id uuid not null references auth.users(id) on delete cascade,
  permission_id uuid not null references public.permissions(id) on delete cascade,
  granted boolean not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, permission_id)
);

alter table public.user_permissions enable row level security;
drop policy if exists "Users can read their permission overrides" on public.user_permissions;
create policy "Users can read their permission overrides" on public.user_permissions
  for select to authenticated
  using (user_id = auth.uid() or public.is_owner());
grant select on public.user_permissions to authenticated;

create or replace function public.has_permission(p_permission text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and (
    public.is_owner()
    or coalesce(
      (
        select user_permission.granted
        from public.user_permissions user_permission
        join public.permissions permission on permission.id = user_permission.permission_id
        where user_permission.user_id = auth.uid()
          and permission.key = p_permission
      ),
      exists (
        select 1
        from public.profiles profile
        join public.role_permissions role_permission on role_permission.role_id = profile.role_id
        join public.permissions permission on permission.id = role_permission.permission_id
        where profile.user_id = auth.uid()
          and permission.key = p_permission
      )
    )
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

  insert into public.user_permissions (user_id, permission_id, granted)
  select new.id, permission.id, false
  from public.permissions permission
  where permission.key = any (array[
    'customers:read', 'customers:write', 'products:read', 'products:write',
    'sales:read', 'sales:create', 'agreements:read', 'agreements:create',
    'payments:read', 'payments:write', 'receipts:print',
    'reports:sales', 'reports:balances', 'reports:late_fees', 'reports:overdue',
    'reports:collections', 'reports:inventory', 'reports:low_stock', 'reports:staff',
    'reports:discounts', 'reports:expenses', 'reports:profit'
  ])
  on conflict (user_id, permission_id) do nothing;
  return new;
end;
$$;

create or replace function public.get_managed_staff()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
begin
  if auth.uid() is null or not public.is_owner() then
    raise exception 'OWNER_PERMISSION_REQUIRED' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', profile.user_id,
      'email', account.email,
      'full_name', coalesce(nullif(btrim(profile.full_name), ''), account.email),
      'created_at', account.created_at,
      'permissions', coalesce(effective.permission_keys, array[]::text[])
    ) order by account.created_at desc
  ), '[]'::jsonb)
  into v_result
  from public.profiles profile
  join public.roles role on role.id = profile.role_id and role.name = 'staff'
  join auth.users account on account.id = profile.user_id
  left join lateral (
    select array_agg(permission.key order by permission.key) as permission_keys
    from public.permissions permission
    left join public.role_permissions role_permission
      on role_permission.permission_id = permission.id
      and role_permission.role_id = profile.role_id
    left join public.user_permissions user_permission
      on user_permission.permission_id = permission.id
      and user_permission.user_id = profile.user_id
    where permission.key = any (array[
      'customers:read', 'customers:write', 'products:read', 'products:write',
      'sales:read', 'sales:create', 'agreements:read', 'agreements:create',
      'payments:read', 'payments:write', 'receipts:print',
      'reports:sales', 'reports:balances', 'reports:late_fees', 'reports:overdue',
      'reports:collections', 'reports:inventory', 'reports:low_stock', 'reports:staff',
      'reports:discounts', 'reports:expenses', 'reports:profit'
    ])
      and coalesce(user_permission.granted, role_permission.permission_id is not null)
  ) effective on true;
  return v_result;
end;
$$;

create or replace function public.set_staff_permission_overrides(
  p_user_id uuid,
  p_permission_keys text[],
  p_actor_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_allowed_permissions constant text[] := array[
    'customers:read', 'customers:write', 'products:read', 'products:write',
    'sales:read', 'sales:create', 'agreements:read', 'agreements:create',
    'payments:read', 'payments:write', 'receipts:print',
    'reports:sales', 'reports:balances', 'reports:late_fees', 'reports:overdue',
    'reports:collections', 'reports:inventory', 'reports:low_stock', 'reports:staff',
    'reports:discounts', 'reports:expenses', 'reports:profit'
  ];
  v_permission_key text;
  v_permission_id uuid;
begin
  if p_actor_user_id is null or not exists (
    select 1
    from public.profiles actor
    join public.roles role on role.id = actor.role_id
    where actor.user_id = p_actor_user_id and role.name = 'owner'
  ) then
    raise exception 'OWNER_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  if p_permission_keys is null
      or cardinality(p_permission_keys) <> cardinality(array(select distinct unnest(p_permission_keys)))
      or not (p_permission_keys <@ v_allowed_permissions) then
    raise exception 'INVALID_STAFF_PERMISSIONS' using errcode = '22023';
  end if;
  if not exists (
    select 1
    from public.profiles staff
    join public.roles role on role.id = staff.role_id
    where staff.user_id = p_user_id and role.name = 'staff'
  ) then
    raise exception 'STAFF_ACCOUNT_NOT_FOUND' using errcode = 'P0002';
  end if;

  foreach v_permission_key in array v_allowed_permissions loop
    select id into v_permission_id from public.permissions where key = v_permission_key;
    insert into public.user_permissions (user_id, permission_id, granted, updated_at)
    values (p_user_id, v_permission_id, v_permission_key = any (p_permission_keys), now())
    on conflict (user_id, permission_id) do update
      set granted = excluded.granted, updated_at = excluded.updated_at;
  end loop;

  insert into public.activity_logs (user_id, action, entity_type, entity_id, details)
  values (
    p_actor_user_id, 'staff.permissions_updated', 'profile', p_user_id,
    jsonb_build_object('permissions', p_permission_keys)
  );
end;
$$;

alter table public.sale_items
  add column if not exists cost_price_snapshot numeric(12,2);

update public.sale_items item
set cost_price_snapshot = product.cost_price
from public.products product
where item.product_id = product.id
  and item.cost_price_snapshot is null;

create or replace function public.snapshot_sale_item_cost()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.cost_price_snapshot is null and new.product_id is not null then
    select cost_price into new.cost_price_snapshot
    from public.products where id = new.product_id;
  end if;
  return new;
end;
$$;

drop trigger if exists sale_items_snapshot_cost on public.sale_items;
create trigger sale_items_snapshot_cost
before insert on public.sale_items
for each row execute function public.snapshot_sale_item_cost();

create or replace function public.log_stock_override_activity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.activity_logs (user_id, action, entity_type, entity_id, details)
  values (
    new.approved_by, 'stock.override', 'sale', new.sale_id,
    jsonb_build_object(
      'product_id', new.product_id,
      'available_quantity', new.available_quantity,
      'sold_quantity', new.sold_quantity,
      'shortfall', new.shortfall
    )
  );
  return new;
end;
$$;

drop trigger if exists stock_override_activity_logged on public.stock_override_audit;
create trigger stock_override_activity_logged
after insert on public.stock_override_audit
for each row execute function public.log_stock_override_activity();

create or replace function public.log_settings_activity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if to_jsonb(new) - array['updated_at', 'updated_by']
      is distinct from to_jsonb(old) - array['updated_at', 'updated_by'] then
    insert into public.activity_logs (user_id, action, entity_type, entity_id, details)
    values (
      coalesce(new.updated_by, auth.uid()), 'settings.changed', 'application_settings',
      null, jsonb_build_object('settings', to_jsonb(new) - array['id', 'updated_at', 'updated_by'])
    );
  end if;
  return new;
end;
$$;

drop trigger if exists application_settings_activity_logged on public.application_settings;
create trigger application_settings_activity_logged
after update on public.application_settings
for each row execute function public.log_settings_activity();

drop policy if exists "Authenticated users can read activity logs" on public.activity_logs;
drop policy if exists "Owners can read activity logs" on public.activity_logs;
create policy "Owners can read activity logs" on public.activity_logs
  for select to authenticated using (public.is_owner());

create or replace function public.get_activity_logs(
  p_from date,
  p_to date,
  p_actor_id uuid default null,
  p_action text default null,
  p_limit integer default 100
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
  if auth.uid() is null or not public.is_owner() then
    raise exception 'OWNER_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_from > p_to
      or p_limit < 1 or p_limit > 500
      or p_action is not null and length(p_action) > 100 then
    raise exception 'INVALID_ACTIVITY_FILTER' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(to_jsonb(filtered) order by filtered.created_at desc), '[]'::jsonb)
  into v_result
  from (
    select
      activity.id,
      activity.action,
      activity.entity_type,
      activity.entity_id,
      activity.details,
      activity.created_at,
      activity.user_id,
      coalesce(nullif(btrim(profile.full_name), ''), account.email, 'Unknown') as actor
    from public.activity_logs activity
    left join public.profiles profile on profile.user_id = activity.user_id
    left join auth.users account on account.id = activity.user_id
    where activity.created_at >= p_from::timestamptz
      and activity.created_at < (p_to + 1)::timestamptz
      and (p_actor_id is null or activity.user_id = p_actor_id)
      and (p_action is null or activity.action = p_action)
    order by activity.created_at desc
    limit p_limit
  ) filtered;
  return v_result;
end;
$$;

create or replace function public.get_notifications()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_items jsonb;
  v_due_today integer := 0;
  v_overdue integer := 0;
  v_low_stock integer := 0;
begin
  if auth.uid() is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;

  if public.has_permission('payments:read') then
    select count(*) into v_due_today
    from public.agreement_schedule schedule
    join public.agreements agreement on agreement.id = schedule.agreement_id and agreement.status = 'approved'
    cross join lateral public.get_schedule_payment_state(schedule.id) state
    where schedule.due_date = current_date
      and state.principal_due + state.interest_due
        + greatest(0, state.late_fee_total - state.late_fee_paid) > 0;

    select count(*) into v_overdue
    from public.agreement_schedule schedule
    join public.agreements agreement on agreement.id = schedule.agreement_id and agreement.status = 'approved'
    cross join lateral public.get_schedule_payment_state(schedule.id) state
    where schedule.due_date + agreement.grace_period_days < current_date
      and state.principal_due + state.interest_due
        + greatest(0, state.late_fee_total - state.late_fee_paid) > 0;
  end if;

  if public.has_permission('products:read') or public.has_permission('products:write') then
    select count(*) into v_low_stock
    from public.products product
    where product.status = 'active' and product.quantity <= product.min_stock;
  end if;

  select coalesce(jsonb_agg(notification order by notification.sort_date desc), '[]'::jsonb)
  into v_items
  from (
    (
      select
        jsonb_build_object(
          'id', schedule.id,
          'type', 'due_today',
          'title', 'Installment due today',
          'description', customer.full_name || ' · installment ' || schedule.installment_number,
          'href', '/collections',
          'created_at', schedule.due_date
        ) as notification,
        schedule.due_date::timestamptz as sort_date
      from public.agreement_schedule schedule
      join public.agreements agreement on agreement.id = schedule.agreement_id and agreement.status = 'approved'
      join public.customers customer on customer.id = agreement.customer_id
      cross join lateral public.get_schedule_payment_state(schedule.id) state
      where public.has_permission('payments:read')
        and schedule.due_date = current_date
        and state.principal_due + state.interest_due
          + greatest(0, state.late_fee_total - state.late_fee_paid) > 0
      order by schedule.due_date, customer.full_name
      limit 10
    )
    union all
    (
      select
        jsonb_build_object(
          'id', schedule.id,
          'type', 'overdue',
          'title', 'Overdue installment',
          'description', customer.full_name || ' · ' || (current_date - schedule.due_date)::text || ' days overdue',
          'href', '/late-payments',
          'created_at', schedule.due_date
        ) as notification,
        schedule.due_date::timestamptz as sort_date
      from public.agreement_schedule schedule
      join public.agreements agreement on agreement.id = schedule.agreement_id and agreement.status = 'approved'
      join public.customers customer on customer.id = agreement.customer_id
      cross join lateral public.get_schedule_payment_state(schedule.id) state
      where public.has_permission('payments:read')
        and schedule.due_date + agreement.grace_period_days < current_date
        and state.principal_due + state.interest_due
          + greatest(0, state.late_fee_total - state.late_fee_paid) > 0
      order by schedule.due_date, customer.full_name
      limit 10
    )
    union all
    (
      select
        jsonb_build_object(
          'id', product.id,
          'type', 'low_stock',
          'title', case when product.quantity = 0 then 'Product out of stock' else 'Low stock' end,
          'description', product.name || ' · ' || product.quantity::text || ' remaining',
          'href', '/products',
          'created_at', product.updated_at
        ) as notification,
        product.updated_at as sort_date
      from public.products product
      where (public.has_permission('products:read') or public.has_permission('products:write'))
        and product.status = 'active'
        and product.quantity <= product.min_stock
      order by product.quantity, product.name
      limit 10
    )
  ) notifications
  limit 30;

  return jsonb_build_object(
    'items', coalesce(v_items, '[]'::jsonb),
    'due_today_count', v_due_today,
    'overdue_count', v_overdue,
    'low_stock_count', v_low_stock
  );
end;
$$;

create or replace function public.get_dashboard_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
  v_metrics jsonb;
  v_charts jsonb;
  v_lists jsonb;
begin
  if auth.uid() is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'customer_count', case when public.has_permission('customers:read')
      then (select count(*) from public.customers) else 0 end,
    'product_count', case when public.has_permission('products:read') or public.has_permission('products:write')
      then (select count(*) from public.products where status = 'active') else 0 end,
    'inventory_value_cents', case when public.has_permission('products:read') or public.has_permission('products:write')
      then coalesce((
        select round(sum(product.cost_price * product.quantity) * 100)::bigint
        from public.products product where product.status = 'active'
      ), 0) else 0 end,
    'low_stock_count', case when public.has_permission('products:read') or public.has_permission('products:write')
      then (select count(*) from public.products where status = 'active' and quantity <= min_stock)
      else 0 end,
    'today_sales_cents', case when public.has_permission('sales:read')
      then coalesce((
        select round(sum(sale.total_amount) * 100)::bigint from public.sales sale
        where sale.created_at >= current_date::timestamptz
          and sale.created_at < (current_date + 1)::timestamptz
      ), 0) else 0 end,
    'monthly_sales_cents', case when public.has_permission('sales:read')
      then coalesce((
        select round(sum(sale.total_amount) * 100)::bigint from public.sales sale
        where sale.created_at >= date_trunc('month', current_date)::timestamptz
          and sale.created_at < (date_trunc('month', current_date) + interval '1 month')
      ), 0) else 0 end,
    'today_collections_cents', case when public.has_permission('payments:read')
      then coalesce((
        select round(sum(payment.amount) * 100)::bigint from public.payments payment
        where payment.reversed_at is null
          and payment.collected_at >= current_date::timestamptz
          and payment.collected_at < (current_date + 1)::timestamptz
      ), 0) else 0 end,
    'monthly_collections_cents', case when public.has_permission('payments:read')
      then coalesce((
        select round(sum(payment.amount) * 100)::bigint from public.payments payment
        where payment.reversed_at is null
          and payment.collected_at >= date_trunc('month', current_date)::timestamptz
          and payment.collected_at < (date_trunc('month', current_date) + interval '1 month')
      ), 0) else 0 end,
    'outstanding_principal_cents', case when public.has_permission('payments:read')
      then coalesce((
        select round(sum(state.principal_due) * 100)::bigint
        from public.agreement_schedule schedule
        join public.agreements agreement on agreement.id = schedule.agreement_id and agreement.status = 'approved'
        cross join lateral public.get_schedule_payment_state(schedule.id) state
      ), 0) else 0 end,
    'outstanding_interest_cents', case when public.has_permission('payments:read')
      then coalesce((
        select round(sum(state.interest_due) * 100)::bigint
        from public.agreement_schedule schedule
        join public.agreements agreement on agreement.id = schedule.agreement_id and agreement.status = 'approved'
        cross join lateral public.get_schedule_payment_state(schedule.id) state
      ), 0) else 0 end,
    'overdue_count', case when public.has_permission('payments:read')
      then (
        select count(*) from public.agreement_schedule schedule
        join public.agreements agreement on agreement.id = schedule.agreement_id and agreement.status = 'approved'
        cross join lateral public.get_schedule_payment_state(schedule.id) state
        where schedule.due_date + agreement.grace_period_days < current_date
          and state.principal_due + state.interest_due
            + greatest(0, state.late_fee_total - state.late_fee_paid) > 0
      ) else 0 end
  ) into v_metrics;

  select jsonb_build_object(
    'daily_sales', case when public.has_permission('sales:read') then coalesce((
      select jsonb_agg(jsonb_build_object('date', day.date_value, 'sales_cents', day.sales_cents)
                       order by day.date_value)
      from (
        select calendar.date_value::date as date_value,
          coalesce(round(sum(sale.total_amount) * 100)::bigint, 0) as sales_cents
        from generate_series(current_date - 13, current_date, interval '1 day') calendar(date_value)
        left join public.sales sale
          on sale.created_at >= calendar.date_value
          and sale.created_at < calendar.date_value + interval '1 day'
        group by calendar.date_value
      ) day
    ), '[]'::jsonb) else '[]'::jsonb end,
    'monthly_revenue', case when public.has_permission('sales:read') then coalesce((
      select jsonb_agg(jsonb_build_object('month', month.month_label, 'revenue_cents', month.revenue_cents)
                       order by month.month_start)
      from (
        select calendar.month_start,
          to_char(calendar.month_start, 'YYYY-MM') as month_label,
          coalesce(round(sum(sale.total_amount) * 100)::bigint, 0) as revenue_cents
        from generate_series(date_trunc('month', current_date) - interval '11 months',
                             date_trunc('month', current_date), interval '1 month') calendar(month_start)
        left join public.sales sale
          on sale.created_at >= calendar.month_start
          and sale.created_at < calendar.month_start + interval '1 month'
        group by calendar.month_start
      ) month
    ), '[]'::jsonb) else '[]'::jsonb end,
    'sales_mix', case when public.has_permission('sales:read') then coalesce((
      select jsonb_agg(jsonb_build_object(
        'payment_type', sales.payment_type,
        'amount_cents', sales.amount_cents,
        'count', sales.sale_count
      ) order by sales.payment_type)
      from (
        select payment_type, round(sum(total_amount) * 100)::bigint as amount_cents,
          count(*)::integer as sale_count
        from public.sales
        where created_at >= date_trunc('month', current_date)
        group by payment_type
      ) sales
    ), '[]'::jsonb) else '[]'::jsonb end,
    'collections_by_day', case when public.has_permission('payments:read') then coalesce((
      select jsonb_agg(jsonb_build_object('period', collections.period, 'amount_cents', collections.amount_cents)
                       order by collections.period)
      from (
        select calendar.date_value::date as period,
          coalesce(round(sum(payment.amount) * 100)::bigint, 0) as amount_cents
        from generate_series(current_date - 13, current_date, interval '1 day') calendar(date_value)
        left join public.payments payment
          on payment.reversed_at is null
          and payment.collected_at >= calendar.date_value
          and payment.collected_at < calendar.date_value + interval '1 day'
        group by calendar.date_value
      ) collections
    ), '[]'::jsonb) else '[]'::jsonb end,
    'collections_by_week', case when public.has_permission('payments:read') then coalesce((
      select jsonb_agg(jsonb_build_object('period', collections.period, 'amount_cents', collections.amount_cents)
                       order by collections.period)
      from (
        select calendar.week_start::date as period,
          coalesce(round(sum(payment.amount) * 100)::bigint, 0) as amount_cents
        from generate_series(date_trunc('week', current_date) - interval '11 weeks',
                             date_trunc('week', current_date), interval '1 week') calendar(week_start)
        left join public.payments payment
          on payment.reversed_at is null
          and payment.collected_at >= calendar.week_start
          and payment.collected_at < calendar.week_start + interval '1 week'
        group by calendar.week_start
      ) collections
    ), '[]'::jsonb) else '[]'::jsonb end,
    'collections_by_month', case when public.has_permission('payments:read') then coalesce((
      select jsonb_agg(jsonb_build_object('period', collections.period, 'amount_cents', collections.amount_cents)
                       order by collections.period)
      from (
        select calendar.month_start::date as period,
          coalesce(round(sum(payment.amount) * 100)::bigint, 0) as amount_cents
        from generate_series(date_trunc('month', current_date) - interval '11 months',
                             date_trunc('month', current_date), interval '1 month') calendar(month_start)
        left join public.payments payment
          on payment.reversed_at is null
          and payment.collected_at >= calendar.month_start
          and payment.collected_at < calendar.month_start + interval '1 month'
        group by calendar.month_start
      ) collections
    ), '[]'::jsonb) else '[]'::jsonb end,
    'product_sales', case when public.has_permission('sales:read') then coalesce((
      select jsonb_agg(jsonb_build_object(
        'product_name', product_sales.product_name,
        'quantity', product_sales.quantity,
        'sales_cents', product_sales.sales_cents
      ) order by product_sales.sales_cents desc)
      from (
        select item.product_name, sum(item.quantity)::integer as quantity,
          round(sum(item.line_total) * 100)::bigint as sales_cents
        from public.sale_items item
        join public.sales sale on sale.id = item.sale_id
        where sale.created_at >= date_trunc('month', current_date)
        group by item.product_name
        order by sum(item.line_total) desc
        limit 8
      ) product_sales
    ), '[]'::jsonb) else '[]'::jsonb end,
    'inventory_by_category', case when public.has_permission('products:read') or public.has_permission('products:write') then coalesce((
      select jsonb_agg(jsonb_build_object(
        'category', inventory.category,
        'value_cents', inventory.value_cents
      ) order by inventory.value_cents desc)
      from (
        select category.name as category,
          round(sum(product.cost_price * product.quantity) * 100)::bigint as value_cents
        from public.products product
        join public.categories category on category.id = product.category_id
        where product.status = 'active'
        group by category.name
      ) inventory
    ), '[]'::jsonb) else '[]'::jsonb end
  ) into v_charts;

  select jsonb_build_object(
    'recent_sales', case when public.has_permission('sales:read') then coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', recent.id, 'invoice_number', recent.invoice_number,
        'customer_name', recent.customer_name, 'payment_type', recent.payment_type,
        'total_cents', recent.total_cents, 'created_at', recent.created_at
      ) order by recent.created_at desc)
      from (
        select sale.id, sale.invoice_number, customer.full_name as customer_name,
          sale.payment_type, round(sale.total_amount * 100)::bigint as total_cents, sale.created_at
        from public.sales sale
        left join public.customers customer on customer.id = sale.customer_id
        order by sale.created_at desc
        limit 8
      ) recent
    ), '[]'::jsonb) else '[]'::jsonb end,
    'recent_payments', case when public.has_permission('payments:read') then coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', recent.id, 'receipt_number', recent.receipt_number,
        'customer_name', recent.customer_name, 'amount_cents', recent.amount_cents,
        'payment_method', recent.payment_method, 'collector', recent.collector,
        'collected_at', recent.collected_at
      ) order by recent.collected_at desc)
      from (
        select payment.id, payment.receipt_number,
          customer.full_name as customer_name,
          round(payment.amount * 100)::bigint as amount_cents,
          payment.payment_method,
          coalesce(nullif(btrim(profile.full_name), ''), account.email, 'Unknown') as collector,
          payment.collected_at
        from public.payments payment
        left join public.customers customer on customer.id = payment.customer_id
        left join public.profiles profile on profile.user_id = payment.collected_by
        left join auth.users account on account.id = payment.collected_by
        where payment.reversed_at is null
        order by payment.collected_at desc
        limit 8
      ) recent
    ), '[]'::jsonb) else '[]'::jsonb end,
    'upcoming_dues', case when public.has_permission('payments:read') then coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', due.id, 'customer_name', due.customer_name,
        'installment_number', due.installment_number, 'due_date', due.due_date,
        'amount_cents', due.amount_cents
      ) order by due.due_date, due.customer_name)
      from (
        select schedule.id, customer.full_name as customer_name,
          schedule.installment_number, schedule.due_date,
          round((state.principal_due + state.interest_due
            + greatest(0, state.late_fee_total - state.late_fee_paid)) * 100)::bigint as amount_cents
        from public.agreement_schedule schedule
        join public.agreements agreement on agreement.id = schedule.agreement_id and agreement.status = 'approved'
        join public.customers customer on customer.id = agreement.customer_id
        cross join lateral public.get_schedule_payment_state(schedule.id) state
        where schedule.due_date between current_date and current_date + 7
          and state.principal_due + state.interest_due
            + greatest(0, state.late_fee_total - state.late_fee_paid) > 0
        order by schedule.due_date, customer.full_name
        limit 8
      ) due
    ), '[]'::jsonb) else '[]'::jsonb end,
    'overdue_customers', case when public.has_permission('payments:read') then coalesce((
      select jsonb_agg(jsonb_build_object(
        'customer_id', overdue.customer_id, 'customer_name', overdue.customer_name,
        'phone', overdue.phone, 'installment_count', overdue.installment_count,
        'amount_cents', overdue.amount_cents, 'oldest_due_date', overdue.oldest_due_date
      ) order by overdue.oldest_due_date, overdue.customer_name)
      from (
        select customer.id as customer_id, customer.full_name as customer_name, customer.phone,
          count(schedule.id)::integer as installment_count,
          round(sum(state.principal_due + state.interest_due
            + greatest(0, state.late_fee_total - state.late_fee_paid)) * 100)::bigint as amount_cents,
          min(schedule.due_date) as oldest_due_date
        from public.agreement_schedule schedule
        join public.agreements agreement on agreement.id = schedule.agreement_id and agreement.status = 'approved'
        join public.customers customer on customer.id = agreement.customer_id
        cross join lateral public.get_schedule_payment_state(schedule.id) state
        where schedule.due_date + agreement.grace_period_days < current_date
          and state.principal_due + state.interest_due
            + greatest(0, state.late_fee_total - state.late_fee_paid) > 0
        group by customer.id, customer.full_name, customer.phone
        order by min(schedule.due_date), customer.full_name
        limit 8
      ) overdue
    ), '[]'::jsonb) else '[]'::jsonb end,
    'low_stock', case when public.has_permission('products:read') or public.has_permission('products:write') then coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', low.id, 'name', low.name, 'quantity', low.quantity, 'min_stock', low.min_stock
      ) order by low.quantity, low.name)
      from (
        select product.id, product.name, product.quantity, product.min_stock
        from public.products product
        where product.status = 'active' and product.quantity <= product.min_stock
        order by product.quantity, product.name
        limit 8
      ) low
    ), '[]'::jsonb) else '[]'::jsonb end,
    'staff_activity', case when public.is_owner() then coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', recent.id, 'actor', recent.actor, 'action', recent.action,
        'entity_type', recent.entity_type, 'created_at', recent.created_at
      ) order by recent.created_at desc)
      from (
        select activity.id, activity.action, activity.entity_type, activity.created_at,
          coalesce(nullif(btrim(profile.full_name), ''), account.email, 'Unknown') as actor
        from public.activity_logs activity
        left join public.profiles profile on profile.user_id = activity.user_id
        left join auth.users account on account.id = activity.user_id
        order by activity.created_at desc
        limit 8
      ) recent
    ), '[]'::jsonb) else '[]'::jsonb end
  ) into v_lists;

  v_result := jsonb_build_object('metrics', v_metrics, 'charts', v_charts, 'lists', v_lists);
  return v_result;
end;
$$;

create or replace function public.get_report(
  p_report_type text,
  p_from date,
  p_to date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_columns jsonb;
  v_rows jsonb;
  v_permission text;
begin
  if auth.uid() is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;
  if p_report_type not in (
    'sales', 'balances', 'late_fees', 'overdue', 'collections',
    'inventory', 'low_stock', 'staff', 'discounts', 'expenses', 'profit'
  ) or p_from is null or p_to is null or p_from > p_to then
    raise exception 'INVALID_REPORT_FILTER' using errcode = '22023';
  end if;
  v_permission := 'reports:' || p_report_type;
  if not public.has_permission(v_permission) then
    raise exception 'REPORT_PERMISSION_REQUIRED' using errcode = '42501';
  end if;

  case p_report_type
    when 'sales' then
      v_columns := '[{"key":"period","label":"Date","format":"date"},{"key":"cash_sales","label":"Cash sales","format":"money"},{"key":"installment_sales","label":"Installment sales","format":"money"},{"key":"total_sales","label":"Sales revenue","format":"money"},{"key":"sale_count","label":"Sales count","format":"number"}]'::jsonb;
      select coalesce(jsonb_agg(to_jsonb(result) order by result.period), '[]'::jsonb) into v_rows
      from (
        select sale.created_at::date as period,
          coalesce(sum(sale.total_amount) filter (where sale.payment_type = 'cash'), 0)::text as cash_sales,
          coalesce(sum(sale.total_amount) filter (where sale.payment_type = 'installment'), 0)::text as installment_sales,
          coalesce(sum(sale.total_amount), 0)::text as total_sales,
          count(*)::integer as sale_count
        from public.sales sale
        where sale.created_at >= p_from::timestamptz and sale.created_at < (p_to + 1)::timestamptz
        group by sale.created_at::date
      ) result;
    when 'balances' then
      v_columns := '[{"key":"customer","label":"Customer","format":"text"},{"key":"phone","label":"Phone","format":"text"},{"key":"outstanding_principal","label":"Outstanding principal","format":"money"},{"key":"outstanding_interest","label":"Outstanding interest","format":"money"},{"key":"late_fees","label":"Unpaid late fees","format":"money"},{"key":"total_outstanding","label":"Total outstanding","format":"money"}]'::jsonb;
      select coalesce(jsonb_agg(to_jsonb(result) order by result.customer), '[]'::jsonb) into v_rows
      from (
        select customer.full_name as customer, customer.phone,
          coalesce(sum(state.principal_due), 0)::text as outstanding_principal,
          coalesce(sum(state.interest_due), 0)::text as outstanding_interest,
          coalesce(sum(greatest(0, state.late_fee_total - state.late_fee_paid)), 0)::text as late_fees,
          coalesce(sum(state.principal_due + state.interest_due
            + greatest(0, state.late_fee_total - state.late_fee_paid)), 0)::text as total_outstanding
        from public.agreement_schedule schedule
        join public.agreements agreement on agreement.id = schedule.agreement_id and agreement.status = 'approved'
        join public.customers customer on customer.id = agreement.customer_id
        cross join lateral public.get_schedule_payment_state(schedule.id) state
        where agreement.created_at >= p_from::timestamptz
          and agreement.created_at < (p_to + 1)::timestamptz
        group by customer.id, customer.full_name, customer.phone
        having sum(state.principal_due + state.interest_due
          + greatest(0, state.late_fee_total - state.late_fee_paid)) > 0
      ) result;
    when 'late_fees' then
      v_columns := '[{"key":"period","label":"Collection date","format":"date"},{"key":"late_fee_collected","label":"Late fees collected","format":"money"},{"key":"payment_count","label":"Payments","format":"number"}]'::jsonb;
      select coalesce(jsonb_agg(to_jsonb(result) order by result.period), '[]'::jsonb) into v_rows
      from (
        select payment.collected_at::date as period,
          coalesce(sum(allocation.amount), 0)::text as late_fee_collected,
          count(distinct payment.id)::integer as payment_count
        from public.payment_allocations allocation
        join public.payments payment on payment.id = allocation.payment_id and payment.reversed_at is null
        where allocation.allocation_type = 'late_fee'
          and payment.collected_at >= p_from::timestamptz
          and payment.collected_at < (p_to + 1)::timestamptz
        group by payment.collected_at::date
      ) result;
    when 'overdue' then
      v_columns := '[{"key":"customer","label":"Customer","format":"text"},{"key":"phone","label":"Phone","format":"text"},{"key":"installment_number","label":"Installment","format":"number"},{"key":"due_date","label":"Due date","format":"date"},{"key":"days_overdue","label":"Days overdue","format":"number"},{"key":"principal_due","label":"Principal due","format":"money"},{"key":"interest_due","label":"Interest due","format":"money"},{"key":"late_fee_due","label":"Late fee due","format":"money"}]'::jsonb;
      select coalesce(jsonb_agg(to_jsonb(result) order by result.due_date, result.customer), '[]'::jsonb) into v_rows
      from (
        select customer.full_name as customer, customer.phone,
          schedule.installment_number, schedule.due_date,
          current_date - schedule.due_date as days_overdue,
          state.principal_due::text as principal_due,
          state.interest_due::text as interest_due,
          greatest(0, state.late_fee_total - state.late_fee_paid)::text as late_fee_due
        from public.agreement_schedule schedule
        join public.agreements agreement on agreement.id = schedule.agreement_id and agreement.status = 'approved'
        join public.customers customer on customer.id = agreement.customer_id
        cross join lateral public.get_schedule_payment_state(schedule.id) state
        where schedule.due_date between p_from and p_to
          and schedule.due_date + agreement.grace_period_days < current_date
          and state.principal_due + state.interest_due
            + greatest(0, state.late_fee_total - state.late_fee_paid) > 0
      ) result;
    when 'collections' then
      v_columns := '[{"key":"period","label":"Collection date","format":"date"},{"key":"payment_method","label":"Payment method","format":"text"},{"key":"amount","label":"Collected","format":"money"},{"key":"payment_count","label":"Payments","format":"number"}]'::jsonb;
      select coalesce(jsonb_agg(to_jsonb(result) order by result.period, result.payment_method), '[]'::jsonb) into v_rows
      from (
        select payment.collected_at::date as period, payment.payment_method,
          sum(payment.amount)::text as amount, count(*)::integer as payment_count
        from public.payments payment
        where payment.reversed_at is null
          and payment.collected_at >= p_from::timestamptz
          and payment.collected_at < (p_to + 1)::timestamptz
        group by payment.collected_at::date, payment.payment_method
      ) result;
    when 'inventory' then
      v_columns := '[{"key":"category","label":"Category","format":"text"},{"key":"product_count","label":"Products","format":"number"},{"key":"units","label":"Units","format":"number"},{"key":"inventory_value","label":"Inventory cost value","format":"money"}]'::jsonb;
      select coalesce(jsonb_agg(to_jsonb(result) order by result.category), '[]'::jsonb) into v_rows
      from (
        select category.name as category, count(*)::integer as product_count,
          sum(product.quantity)::bigint as units,
          sum(product.cost_price * product.quantity)::text as inventory_value
        from public.products product
        join public.categories category on category.id = product.category_id
        where product.status = 'active'
        group by category.name
      ) result;
    when 'low_stock' then
      v_columns := '[{"key":"name","label":"Product","format":"text"},{"key":"sku","label":"SKU","format":"text"},{"key":"quantity","label":"On hand","format":"number"},{"key":"min_stock","label":"Minimum stock","format":"number"},{"key":"status","label":"Stock status","format":"text"}]'::jsonb;
      select coalesce(jsonb_agg(to_jsonb(result) order by result.quantity, result.name), '[]'::jsonb) into v_rows
      from (
        select product.name, product.sku, product.quantity, product.min_stock,
          case when product.quantity = 0 then 'out of stock' else 'low' end as status
        from public.products product
        where product.status = 'active' and product.quantity <= product.min_stock
      ) result;
    when 'staff' then
      v_columns := '[{"key":"staff","label":"Staff member","format":"text"},{"key":"sales_count","label":"Sales","format":"number"},{"key":"sales_revenue","label":"Sales revenue","format":"money"},{"key":"payment_count","label":"Payments recorded","format":"number"},{"key":"collections","label":"Collections recorded","format":"money"},{"key":"reversals","label":"Reversals","format":"number"}]'::jsonb;
      select coalesce(jsonb_agg(to_jsonb(result) order by result.staff), '[]'::jsonb) into v_rows
      from (
        select coalesce(nullif(btrim(profile.full_name), ''), account.email, 'Unknown') as staff,
          count(*) filter (where activity.action = 'sale.created')::integer as sales_count,
          coalesce(sum(sale.total_amount) filter (where activity.action = 'sale.created'), 0)::text as sales_revenue,
          count(*) filter (where activity.action = 'payment.recorded')::integer as payment_count,
          coalesce(sum((activity.details ->> 'amount')::numeric)
            filter (where activity.action = 'payment.recorded'), 0)::text as collections,
          count(*) filter (where activity.action = 'payment.reversed')::integer as reversals
        from public.activity_logs activity
        left join public.profiles profile on profile.user_id = activity.user_id
        left join auth.users account on account.id = activity.user_id
        left join public.sales sale on sale.id = activity.entity_id and activity.action = 'sale.created'
        where activity.created_at >= p_from::timestamptz
          and activity.created_at < (p_to + 1)::timestamptz
          and activity.action in ('sale.created', 'payment.recorded', 'payment.reversed')
          and activity.user_id is not null
        group by activity.user_id, profile.full_name, account.email
      ) result;
    when 'discounts' then
      v_columns := '[{"key":"discount_type","label":"Type","format":"text"},{"key":"status","label":"Decision","format":"text"},{"key":"amount","label":"Amount","format":"money"},{"key":"reason","label":"Reason","format":"text"},{"key":"requester","label":"Requested by","format":"text"},{"key":"approver","label":"Decided by","format":"text"},{"key":"decision_at","label":"Decision date","format":"date"}]'::jsonb;
      select coalesce(jsonb_agg(to_jsonb(result) order by result.decision_at desc), '[]'::jsonb) into v_rows
      from (
        select request.discount_type, request.status, request.amount::text as amount,
          request.reason,
          coalesce(nullif(btrim(requester.full_name), ''), requester_user.email, 'Unknown') as requester,
          coalesce(nullif(btrim(approver.full_name), ''), approver_user.email, '') as approver,
          request.decision_at
        from public.discount_requests request
        left join public.profiles requester on requester.user_id = request.requested_by
        left join auth.users requester_user on requester_user.id = request.requested_by
        left join public.profiles approver on approver.user_id = request.approved_by
        left join auth.users approver_user on approver_user.id = request.approved_by
        where request.decision_at >= p_from::timestamptz
          and request.decision_at < (p_to + 1)::timestamptz
      ) result;
    when 'expenses' then
      v_columns := '[{"key":"period","label":"Date","format":"date"},{"key":"category","label":"Category","format":"text"},{"key":"description","label":"Description","format":"text"},{"key":"amount","label":"Amount","format":"money"}]'::jsonb;
      select coalesce(jsonb_agg(to_jsonb(result) order by result.period desc, result.category), '[]'::jsonb) into v_rows
      from (
        select expense.created_at::date as period, expense.category,
          expense.description, expense.amount::text as amount
        from public.expenses expense
        where expense.created_at >= p_from::timestamptz
          and expense.created_at < (p_to + 1)::timestamptz
      ) result;
    when 'profit' then
      v_columns := '[{"key":"sales_revenue","label":"Sales revenue (excludes future interest)","format":"money"},{"key":"cost_of_goods","label":"Cost of goods sold","format":"money"},{"key":"expenses","label":"Expenses","format":"money"},{"key":"estimated_profit","label":"Estimated profit","format":"money"},{"key":"sales_missing_cost","label":"Items missing cost snapshot","format":"number"}]'::jsonb;
      select jsonb_build_array(jsonb_build_object(
        'sales_revenue', totals.sales_revenue::text,
        'cost_of_goods', totals.cost_of_goods::text,
        'expenses', totals.expenses::text,
        'estimated_profit', case when totals.sales_missing_cost = 0
          then (totals.sales_revenue - totals.cost_of_goods - totals.expenses)::text
          else null end,
        'sales_missing_cost', totals.sales_missing_cost
      )) into v_rows
      from (
        select
          (select coalesce(sum(sale.total_amount), 0)
           from public.sales sale
           where sale.created_at >= p_from::timestamptz
             and sale.created_at < (p_to + 1)::timestamptz) as sales_revenue,
          (select coalesce(sum(item.cost_price_snapshot * item.quantity), 0)
           from public.sale_items item
           join public.sales sale on sale.id = item.sale_id
           where sale.created_at >= p_from::timestamptz
             and sale.created_at < (p_to + 1)::timestamptz) as cost_of_goods,
          (select coalesce(sum(expense.amount), 0) from public.expenses expense
           where expense.created_at >= p_from::timestamptz
             and expense.created_at < (p_to + 1)::timestamptz) as expenses,
          (select count(*)::integer
           from public.sale_items item
           join public.sales sale on sale.id = item.sale_id
           where sale.created_at >= p_from::timestamptz
             and sale.created_at < (p_to + 1)::timestamptz
             and item.cost_price_snapshot is null) as sales_missing_cost
      ) totals;
  end case;

  return jsonb_build_object(
    'report_type', p_report_type,
    'from', p_from,
    'to', p_to,
    'columns', v_columns,
    'rows', coalesce(v_rows, '[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_managed_staff() from public;
revoke all on function public.set_staff_permission_overrides(uuid, text[], uuid) from public, authenticated;
revoke all on function public.get_activity_logs(date, date, uuid, text, integer) from public;
revoke all on function public.get_notifications() from public;
revoke all on function public.get_dashboard_overview() from public;
revoke all on function public.get_report(text, date, date) from public;

grant execute on function public.get_managed_staff() to authenticated;
grant execute on function public.set_staff_permission_overrides(uuid, text[], uuid) to service_role;
grant execute on function public.get_activity_logs(date, date, uuid, text, integer) to authenticated;
grant execute on function public.get_notifications() to authenticated;
grant execute on function public.get_dashboard_overview() to authenticated;
grant execute on function public.get_report(text, date, date) to authenticated;
