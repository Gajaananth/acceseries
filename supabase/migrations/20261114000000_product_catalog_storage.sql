create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create unique index if not exists categories_name_case_insensitive_uidx
  on public.categories (lower(name));

insert into public.categories (name)
select min(btrim(category))
from public.products
where nullif(btrim(category), '') is not null
group by lower(btrim(category))
on conflict do nothing;

insert into public.categories (name)
select 'Uncategorized'
where exists (
  select 1 from public.products where nullif(btrim(category), '') is null
)
on conflict do nothing;

alter table public.products
  add column if not exists sku text,
  add column if not exists barcode text,
  add column if not exists category_id uuid,
  add column if not exists brand text,
  add column if not exists description text,
  add column if not exists image_path text,
  add column if not exists cost_price numeric(12,2),
  add column if not exists supplier text;

update public.products
set sku = 'SKU-' || upper(substr(replace(id::text, '-', ''), 1, 12))
where sku is null;

update public.products p
set category_id = c.id
from public.categories c
where p.category_id is null
  and lower(c.name) = lower(coalesce(nullif(btrim(p.category), ''), 'Uncategorized'));

update public.products set cost_price = 0 where cost_price is null;

alter table public.products
  alter column sku set not null,
  alter column category_id set not null,
  alter column cost_price set default 0,
  alter column cost_price set not null;

alter table public.products
  drop constraint if exists products_status_check,
  drop constraint if exists products_price_check;
alter table public.products alter column status drop default;
update public.products set status = 'active';
alter table public.products alter column status set default 'active';

alter table public.products
  drop column if exists category;

alter table public.products
  add column selling_price numeric(12,2) generated always as (price) stored not null,
  add column quantity integer generated always as (stock_quantity) stored not null,
  add column min_stock integer generated always as (reorder_level) stored not null,
  add constraint products_sku_key unique (sku),
  add constraint products_sku_nonempty check (length(btrim(sku)) between 1 and 64),
  add constraint products_barcode_key unique (barcode),
  add constraint products_category_id_fkey foreign key (category_id) references public.categories(id) on delete restrict,
  add constraint products_status_check check (status in ('active', 'archived')),
  add constraint products_price_nonnegative check (price >= 0),
  add constraint products_cost_price_nonnegative check (cost_price >= 0),
  add constraint products_selling_price_nonnegative check (selling_price >= 0),
  add constraint products_quantity_nonnegative check (quantity >= 0),
  add constraint products_min_stock_nonnegative check (min_stock >= 0);

create unique index products_sku_case_insensitive_uidx
  on public.products (lower(sku));

create or replace function public.preserve_product_status_compatibility()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.status in ('healthy', 'low', 'critical') then
    if old.status = 'archived' then
      raise exception 'PRODUCT_ARCHIVED' using errcode = 'P0001';
    end if;
    new.status := old.status;
  end if;
  return new;
end;
$$;

create trigger products_preserve_status_compatibility
before update of status on public.products
for each row execute function public.preserve_product_status_compatibility();

create table if not exists public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete restrict,
  movement_type text not null check (movement_type in ('stock_in', 'adjust')),
  qty integer not null check (qty <> 0),
  reason text not null check (length(btrim(reason)) > 0),
  user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

insert into public.stock_movements (product_id, movement_type, qty, reason, user_id, created_at)
select id, 'stock_in', quantity, 'Opening stock from catalog migration', null, created_at
from public.products
where quantity > 0;

create index if not exists stock_movements_product_created_idx
  on public.stock_movements (product_id, created_at desc);

create or replace function public.record_product_stock_movement()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_delta integer := new.stock_quantity - old.stock_quantity;
  v_type text := nullif(current_setting('app.stock_movement_type', true), '');
  v_reason text := nullif(current_setting('app.stock_movement_reason', true), '');
begin
  if v_delta <> 0 then
    if v_type not in ('stock_in', 'adjust') or v_type is null then
      v_type := case when v_delta > 0 then 'stock_in' else 'adjust' end;
    end if;
    insert into public.stock_movements (product_id, movement_type, qty, reason, user_id)
    values (
      new.id,
      v_type,
      v_delta,
      coalesce(v_reason, 'Inventory updated by another workflow'),
      auth.uid()
    );
  end if;
  perform set_config('app.stock_movement_type', '', true);
  perform set_config('app.stock_movement_reason', '', true);
  return new;
end;
$$;

create trigger products_record_stock_movement
after update of stock_quantity on public.products
for each row execute function public.record_product_stock_movement();

alter table public.categories enable row level security;
alter table public.stock_movements enable row level security;

drop policy if exists "Authenticated users can read categories" on public.categories;
create policy "Authenticated users can read categories" on public.categories
  for select using (auth.role() = 'authenticated');
drop policy if exists "Product managers can insert categories" on public.categories;
create policy "Product managers can insert categories" on public.categories
  for insert with check (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'owner'
    or coalesce(auth.jwt() -> 'app_metadata' -> 'permissions', '[]'::jsonb) ? 'products:write'
  );

drop policy if exists "Authenticated users can read products" on public.products;
create policy "Authenticated users can read products" on public.products
  for select using (auth.role() = 'authenticated');
drop policy if exists "Authenticated users can update products" on public.products;
drop policy if exists "Authenticated users can insert products" on public.products;

drop policy if exists "Authenticated users can read stock movements" on public.stock_movements;
create policy "Authenticated users can read stock movements" on public.stock_movements
  for select using (auth.role() = 'authenticated');

insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', false)
on conflict (id) do update set public = false;

drop policy if exists "Authenticated users can read product images" on storage.objects;
create policy "Authenticated users can read product images" on storage.objects
  for select using (bucket_id = 'product-images' and auth.role() = 'authenticated');
drop policy if exists "Product managers can upload product images" on storage.objects;
create policy "Product managers can upload product images" on storage.objects
  for insert with check (
    bucket_id = 'product-images'
    and (
      (auth.jwt() -> 'app_metadata' ->> 'role') = 'owner'
      or coalesce(auth.jwt() -> 'app_metadata' -> 'permissions', '[]'::jsonb) ? 'products:write'
    )
  );
drop policy if exists "Product managers can update product images" on storage.objects;
create policy "Product managers can update product images" on storage.objects
  for update using (
    bucket_id = 'product-images'
    and (
      (auth.jwt() -> 'app_metadata' ->> 'role') = 'owner'
      or coalesce(auth.jwt() -> 'app_metadata' -> 'permissions', '[]'::jsonb) ? 'products:write'
    )
  )
  with check (
    bucket_id = 'product-images'
    and (
      (auth.jwt() -> 'app_metadata' ->> 'role') = 'owner'
      or coalesce(auth.jwt() -> 'app_metadata' -> 'permissions', '[]'::jsonb) ? 'products:write'
    )
  );
drop policy if exists "Product managers can delete product images" on storage.objects;
create policy "Product managers can delete product images" on storage.objects
  for delete using (
    bucket_id = 'product-images'
    and (
      (auth.jwt() -> 'app_metadata' ->> 'role') = 'owner'
      or coalesce(auth.jwt() -> 'app_metadata' -> 'permissions', '[]'::jsonb) ? 'products:write'
    )
  );

create or replace function public.create_product_with_opening_stock(
  p_product jsonb,
  p_image_path text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_product_id uuid;
  v_quantity integer := (p_product ->> 'quantity')::integer;
begin
  if auth.uid() is null or not (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'owner'
    or coalesce(auth.jwt() -> 'app_metadata' -> 'permissions', '[]'::jsonb) ? 'products:write'
  ) then
    raise exception 'PRODUCT_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  if v_quantity < 0 then raise exception 'INVALID_PRODUCT_QUANTITY' using errcode = '22023'; end if;

  insert into public.products (
    name, sku, barcode, category_id, brand, description, image_path,
    cost_price, price, stock_quantity, reorder_level, supplier, status
  ) values (
    p_product ->> 'name',
    p_product ->> 'sku',
    nullif(p_product ->> 'barcode', ''),
    (p_product ->> 'category_id')::uuid,
    nullif(p_product ->> 'brand', ''),
    nullif(p_product ->> 'description', ''),
    p_image_path,
    (p_product ->> 'cost_price')::numeric(12,2),
    (p_product ->> 'selling_price')::numeric(12,2),
    v_quantity,
    (p_product ->> 'min_stock')::integer,
    nullif(p_product ->> 'supplier', ''),
    p_product ->> 'status'
  )
  returning id into v_product_id;

  if v_quantity > 0 then
    insert into public.stock_movements (product_id, movement_type, qty, reason, user_id)
    values (v_product_id, 'stock_in', v_quantity, 'Opening stock', auth.uid());
  end if;

  return v_product_id;
end;
$$;

create or replace function public.update_product_catalog(
  p_product_id uuid,
  p_product jsonb,
  p_image_path text,
  p_set_image boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or not (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'owner'
    or coalesce(auth.jwt() -> 'app_metadata' -> 'permissions', '[]'::jsonb) ? 'products:write'
  ) then
    raise exception 'PRODUCT_PERMISSION_REQUIRED' using errcode = '42501';
  end if;

  update public.products
  set name = p_product ->> 'name',
      sku = p_product ->> 'sku',
      barcode = nullif(p_product ->> 'barcode', ''),
      category_id = (p_product ->> 'category_id')::uuid,
      brand = nullif(p_product ->> 'brand', ''),
      description = nullif(p_product ->> 'description', ''),
      image_path = case when p_set_image then p_image_path else image_path end,
      cost_price = (p_product ->> 'cost_price')::numeric(12,2),
      price = (p_product ->> 'selling_price')::numeric(12,2),
      reorder_level = (p_product ->> 'min_stock')::integer,
      supplier = nullif(p_product ->> 'supplier', ''),
      status = p_product ->> 'status',
      updated_at = now()
  where id = p_product_id;
  if not found then raise exception 'PRODUCT_NOT_FOUND' using errcode = 'P0002'; end if;
end;
$$;

create or replace function public.archive_product(p_product_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or not (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'owner'
    or coalesce(auth.jwt() -> 'app_metadata' -> 'permissions', '[]'::jsonb) ? 'products:write'
  ) then
    raise exception 'PRODUCT_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  update public.products set status = 'archived', updated_at = now() where id = p_product_id;
  if not found then raise exception 'PRODUCT_NOT_FOUND' using errcode = 'P0002'; end if;
end;
$$;

create or replace function public.adjust_product_stock(
  p_product_id uuid,
  p_movement_type text,
  p_qty integer,
  p_reason text
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_quantity integer;
begin
  if auth.uid() is null or not (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'owner'
    or coalesce(auth.jwt() -> 'app_metadata' -> 'permissions', '[]'::jsonb) ? 'products:write'
  ) then
    raise exception 'PRODUCT_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  if p_movement_type not in ('stock_in', 'adjust') or p_qty = 0
      or (p_movement_type = 'stock_in' and p_qty < 0)
      or nullif(btrim(p_reason), '') is null then
    raise exception 'INVALID_STOCK_MOVEMENT' using errcode = '22023';
  end if;

  perform set_config('app.stock_movement_type', p_movement_type, true);
  perform set_config('app.stock_movement_reason', btrim(p_reason), true);

  update public.products
  set stock_quantity = (stock_quantity::bigint + p_qty::bigint)::integer, updated_at = now()
  where id = p_product_id
    and status = 'active'
    and stock_quantity::bigint + p_qty::bigint between 0 and 2147483647
  returning quantity into v_quantity;
  if not found then
    if exists (select 1 from public.products where id = p_product_id and status <> 'active') then
      raise exception 'PRODUCT_ARCHIVED' using errcode = 'P0001';
    end if;
    if exists (
      select 1 from public.products
      where id = p_product_id and stock_quantity::bigint + p_qty::bigint > 2147483647
    ) then
      raise exception 'STOCK_QUANTITY_LIMIT' using errcode = 'P0001';
    end if;
    raise exception 'PRODUCT_NOT_FOUND_OR_INSUFFICIENT_STOCK' using errcode = 'P0001';
  end if;

  return v_quantity;
end;
$$;

revoke all on function public.create_product_with_opening_stock(jsonb, text) from public;
revoke all on function public.update_product_catalog(uuid, jsonb, text, boolean) from public;
revoke all on function public.archive_product(uuid) from public;
revoke all on function public.adjust_product_stock(uuid, text, integer, text) from public;
grant execute on function public.create_product_with_opening_stock(jsonb, text) to authenticated;
grant execute on function public.update_product_catalog(uuid, jsonb, text, boolean) to authenticated;
grant execute on function public.archive_product(uuid) to authenticated;
grant execute on function public.adjust_product_stock(uuid, text, integer, text) to authenticated;
