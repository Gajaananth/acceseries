alter table public.stock_movements
  add column if not exists product_name_snapshot text;

update public.stock_movements movement
set product_name_snapshot = product.name
from public.products product
where movement.product_id = product.id
  and movement.product_name_snapshot is null;

alter table public.stock_movements
  alter column product_id drop not null,
  drop constraint if exists stock_movements_product_id_fkey,
  add constraint stock_movements_product_id_fkey
    foreign key (product_id) references public.products(id) on delete set null;

alter table public.stock_override_audit
  add column if not exists product_name_snapshot text;

update public.stock_override_audit audit
set product_name_snapshot = product.name
from public.products product
where audit.product_id = product.id
  and audit.product_name_snapshot is null;

alter table public.stock_override_audit
  alter column product_id drop not null,
  drop constraint if exists stock_override_audit_product_id_fkey,
  add constraint stock_override_audit_product_id_fkey
    foreign key (product_id) references public.products(id) on delete set null;

create or replace function public.set_product_history_snapshot()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.product_id is not null then
    select product.name into new.product_name_snapshot
    from public.products product
    where product.id = new.product_id;
  end if;
  return new;
end;
$$;

drop trigger if exists stock_movements_product_name_snapshot on public.stock_movements;
create trigger stock_movements_product_name_snapshot
before insert or update of product_id on public.stock_movements
for each row execute function public.set_product_history_snapshot();

drop trigger if exists stock_override_product_name_snapshot on public.stock_override_audit;
create trigger stock_override_product_name_snapshot
before insert or update of product_id on public.stock_override_audit
for each row execute function public.set_product_history_snapshot();

create or replace function public.delete_product(p_product_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_product public.products%rowtype;
begin
  if auth.uid() is null or not public.has_permission('products:write') then
    raise exception 'PRODUCT_PERMISSION_REQUIRED' using errcode = '42501';
  end if;

  select * into v_product
  from public.products
  where id = p_product_id
  for update;

  if not found then
    raise exception 'PRODUCT_NOT_FOUND' using errcode = 'P0002';
  end if;

  insert into public.activity_logs (user_id, action, entity_type, entity_id, details)
  values (
    auth.uid(),
    'product.deleted',
    'product',
    v_product.id,
    jsonb_build_object('name', v_product.name, 'sku', v_product.sku)
  );

  delete from public.products where id = v_product.id;

  return jsonb_build_object(
    'id', v_product.id,
    'name', v_product.name,
    'image_path', v_product.image_path
  );
end;
$$;

revoke all on function public.delete_product(uuid) from public;
grant execute on function public.delete_product(uuid) to authenticated;
