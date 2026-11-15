alter table public.sales
  add column if not exists invoice_number text,
  add column if not exists payment_method text not null default 'cash'
    check (payment_method in ('cash', 'bank_transfer', 'card')),
  add column if not exists agreement_id uuid references public.agreements(id) on delete set null;

update public.sales
set invoice_number = 'INV-' || to_char(created_at at time zone 'UTC', 'YYYYMMDD') || '-' ||
  upper(replace(id::text, '-', ''))
where invoice_number is null;

alter table public.sales alter column invoice_number set not null;
create unique index if not exists sales_invoice_number_key on public.sales (invoice_number);
create index if not exists sales_created_at_idx on public.sales (created_at desc);
create index if not exists sales_customer_created_idx on public.sales (customer_id, created_at desc);

alter table public.agreements
  add column if not exists sale_id uuid references public.sales(id) on delete set null;
create unique index if not exists agreements_sale_id_key on public.agreements (sale_id) where sale_id is not null;

alter table public.payments
  add column if not exists sale_id uuid references public.sales(id) on delete restrict;
drop index if exists public.payments_sale_id_key;
create unique index payments_sale_id_key on public.payments (sale_id)
  where sale_id is not null and reversed_at is null;

drop function if exists public.create_sale(jsonb, jsonb, boolean, text, text);

create or replace function public.create_sale(
  p_sale jsonb,
  p_items jsonb,
  p_allow_negative_stock boolean,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
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
  v_payment_method text;
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
  if v_response is not null then return v_response; end if;

  v_discount := (p_sale ->> 'discount_amount')::numeric(12,2);
  v_payment_type := p_sale ->> 'payment_type';
  v_payment_method := p_sale ->> 'payment_method';
  v_customer_id := nullif(p_sale ->> 'customer_id', '')::uuid;
  if v_discount is null or v_discount < 0 or v_payment_type <> 'cash'
      or v_payment_method is null or v_payment_method not in ('cash', 'bank_transfer', 'card') then
    raise exception 'INVALID_SALE' using errcode = '22023';
  end if;
  if v_customer_id is not null and not exists (select 1 from public.customers where id = v_customer_id) then
    raise exception 'CUSTOMER_NOT_FOUND' using errcode = '22023';
  end if;

  perform p.id
  from public.products p
  join (
    select distinct (value ->> 'product_id')::uuid as product_id
    from jsonb_array_elements(p_items) as rows(value)
  ) requested on requested.product_id = p.id
  order by p.id
  for update of p;

  for v_item in select value from jsonb_array_elements(p_items) as rows(value) loop
    v_product_id := (v_item ->> 'product_id')::uuid;
    v_quantity := (v_item ->> 'quantity')::integer;
    if v_quantity < 1 then raise exception 'INVALID_ITEM_QUANTITY' using errcode = '22023'; end if;
    select name, price into v_product_name, v_price
    from public.products where id = v_product_id and status = 'active';
    if not found then raise exception 'PRODUCT_NOT_FOUND' using errcode = 'P0002'; end if;
    v_subtotal := v_subtotal + v_price * v_quantity;
  end loop;
  if v_discount > v_subtotal then raise exception 'DISCOUNT_EXCEEDS_SUBTOTAL' using errcode = '22023'; end if;
  v_total := v_subtotal - v_discount;

  for v_product_id, v_quantity in
    select (value ->> 'product_id')::uuid, sum((value ->> 'quantity')::bigint)::integer
    from jsonb_array_elements(p_items) as rows(value)
    group by (value ->> 'product_id')::uuid
    order by (value ->> 'product_id')::uuid
  loop
    select stock_quantity into v_available from public.products where id = v_product_id;
    if v_available < v_quantity and (p_allow_negative_stock is not true or not public.is_owner()) then
      select name into v_product_name from public.products where id = v_product_id;
      raise exception 'INSUFFICIENT_STOCK:%. Available: %; requested: %',
        v_product_name, v_available, v_quantity using errcode = 'P0001';
    end if;
  end loop;

  v_sale_id := gen_random_uuid();
  insert into public.sales (
    id, invoice_number, customer_id, total_amount, payment_type, payment_method,
    discount_amount, status
  ) values (
    v_sale_id,
    'INV-' || to_char(now() at time zone 'UTC', 'YYYYMMDD') || '-' ||
      upper(replace(v_sale_id::text, '-', '')),
    v_customer_id, v_total, 'cash', v_payment_method, v_discount, 'paid'
  );

  for v_item in select value from jsonb_array_elements(p_items) as rows(value) loop
    v_product_id := (v_item ->> 'product_id')::uuid;
    v_quantity := (v_item ->> 'quantity')::integer;
    select name, price, stock_quantity into v_product_name, v_price, v_available
    from public.products where id = v_product_id and status = 'active';
    v_shortfall := greatest(0, v_quantity - v_available);

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

  if v_total > 0 then
    insert into public.payments (sale_id, customer_id, amount, payment_method, collected_at)
    values (v_sale_id, v_customer_id, v_total, v_payment_method, now());
  end if;
  insert into public.activity_logs (user_id, action, entity_type, entity_id, details)
  values (auth.uid(), 'sale.created', 'sale', v_sale_id, jsonb_build_object('payment_type', 'cash'));
  v_response := jsonb_build_object('sale_id', v_sale_id, 'agreement_id', null);
  update public.idempotency_records
  set response = v_response
  where user_id = auth.uid() and operation = 'create_sale' and idempotency_key = p_idempotency_key;
  return v_response;
end;
$$;

create or replace function public.create_installment_sale(
  p_sale jsonb,
  p_agreement jsonb,
  p_items jsonb,
  p_schedule jsonb,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sale_id uuid := gen_random_uuid();
  v_agreement_id uuid;
  v_response jsonb;
  v_saved_hash text;
  v_payment_method text;
  v_customer_id uuid;
  v_discount numeric(12,2);
  v_total numeric(12,2);
  v_down_payment numeric(12,2);
  v_item jsonb;
begin
  if auth.uid() is null or not public.has_permission('sales:create')
      or not public.has_permission('agreements:create') then
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
  if v_response is not null then return v_response; end if;

  v_customer_id := (p_agreement ->> 'customer_id')::uuid;
  v_payment_method := p_sale ->> 'payment_method';
  v_discount := (p_agreement ->> 'product_discount')::numeric(12,2) +
    (p_agreement ->> 'customer_discount')::numeric(12,2);
  v_total := (p_agreement ->> 'final_price')::numeric(12,2);
  v_down_payment := (p_agreement ->> 'down_payment')::numeric(12,2);
  if v_payment_method not in ('cash', 'bank_transfer', 'card') then
    raise exception 'INVALID_PAYMENT_METHOD' using errcode = '22023';
  end if;

  v_agreement_id := public.create_installment_agreement(p_agreement, p_items, p_schedule);
  insert into public.sales (
    id, invoice_number, customer_id, total_amount, payment_type, payment_method,
    discount_amount, status, agreement_id
  ) values (
    v_sale_id,
    'INV-' || to_char(now() at time zone 'UTC', 'YYYYMMDD') || '-' ||
      upper(replace(v_sale_id::text, '-', '')),
    v_customer_id, v_total, 'installment', v_payment_method, v_discount, 'pending', v_agreement_id
  );
  update public.agreements set sale_id = v_sale_id where id = v_agreement_id;
  for v_item in select value from jsonb_array_elements(p_items) as rows(value) loop
    insert into public.sale_items (sale_id, product_id, product_name, unit_price, quantity, line_total)
    values (
      v_sale_id, (v_item ->> 'product_id')::uuid, v_item ->> 'product_name',
      (v_item ->> 'unit_price')::numeric(12,2), (v_item ->> 'quantity')::integer,
      (v_item ->> 'line_total')::numeric(12,2)
    );
  end loop;
  if v_down_payment > 0 then
    insert into public.payments (
      sale_id, customer_id, agreement_id, amount, payment_method, collected_at
    ) values (
      v_sale_id, v_customer_id, v_agreement_id, v_down_payment, v_payment_method, now()
    );
  end if;
  insert into public.activity_logs (user_id, action, entity_type, entity_id, details)
  values (auth.uid(), 'sale.created', 'sale', v_sale_id,
          jsonb_build_object('payment_type', 'installment', 'agreement_id', v_agreement_id));
  v_response := jsonb_build_object('sale_id', v_sale_id, 'agreement_id', v_agreement_id);
  update public.idempotency_records
  set response = v_response
  where user_id = auth.uid() and operation = 'create_sale' and idempotency_key = p_idempotency_key;
  return v_response;
end;
$$;

create or replace function public.get_sales_summary(p_from timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
begin
  if auth.uid() is null or not public.has_permission('sales:read') then
    raise exception 'SALES_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'cash_sales_this_week_cents',
    coalesce(((sum(total_amount) filter (
      where payment_type = 'cash' and created_at >= p_from
    )) * 100)::numeric(24,0), 0)::text,
    'average_order_value_cents',
    coalesce(round(avg(total_amount) * 100)::numeric(24,0), 0)::text,
    'sales_count',
    count(*)::integer
  )
  into v_result
  from public.sales;
  return v_result;
end;
$$;

revoke all on function public.create_sale(jsonb, jsonb, boolean, text, text) from public;
grant execute on function public.create_sale(jsonb, jsonb, boolean, text, text) to authenticated;
revoke all on function public.create_installment_sale(jsonb, jsonb, jsonb, jsonb, text, text) from public;
grant execute on function public.create_installment_sale(jsonb, jsonb, jsonb, jsonb, text, text) to authenticated;
revoke all on function public.get_sales_summary(timestamptz) from public;
grant execute on function public.get_sales_summary(timestamptz) to authenticated;
