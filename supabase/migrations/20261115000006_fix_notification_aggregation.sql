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

  select coalesce(jsonb_agg(notifications.notification order by notifications.sort_date desc), '[]'::jsonb)
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
