-- ============================================================
-- Etapa 2 de seguridad — FASE 2 (aplicar SOLO cuando la versión nueva del
-- front, con login por Edge Function, ya esté publicada en Vercel).
--
-- Rompe la versión anterior de la app a propósito:
--   * el rol anon (la clave pública del repo) deja de ver y tocar datos;
--   * desaparece la columna meseros.pin (texto plano).
-- ============================================================

-- 1) Fuera las políticas para anon de la etapa 1
drop policy if exists app_leer      on public.restaurantes;
drop policy if exists app_leer      on public.categorias;
drop policy if exists app_leer      on public.productos;
drop policy if exists app_crear     on public.productos;
drop policy if exists app_modificar on public.productos;
drop policy if exists app_leer      on public.meseros;
drop policy if exists app_crear     on public.meseros;
drop policy if exists app_modificar on public.meseros;
drop policy if exists app_leer      on public.mesas;
drop policy if exists app_modificar on public.mesas;
drop policy if exists app_leer      on public.pedidos;
drop policy if exists app_crear     on public.pedidos;
drop policy if exists app_modificar on public.pedidos;
drop policy if exists app_leer      on public.rondas;
drop policy if exists app_crear     on public.rondas;
drop policy if exists app_modificar on public.rondas;
drop policy if exists app_leer      on public.pagos;
drop policy if exists app_crear     on public.pagos;
drop policy if exists app_borrar    on public.pagos;

-- 2) Y fuera también los privilegios de tabla (defensa en profundidad:
--    aunque alguien agregue una política por error, anon no tiene GRANT).
revoke all on public.restaurantes, public.categorias, public.productos, public.meseros,
  public.mesas, public.pedidos, public.rondas, public.pagos from anon;
alter default privileges in schema public revoke all on tables from anon;

-- 3) Sin PIN en texto plano
drop trigger if exists sincronizar_pin_legado on public.meseros;
drop function if exists private.sincronizar_pin_legado();

create or replace function public.admin_restablecer_pin(p_mesero_id text)
returns json language plpgsql security definer set search_path = '' as $$
declare
  v_pin text := private.pin_aleatorio();
begin
  if private.mi_rol() is distinct from 'admin' then
    raise exception 'Solo administración puede restablecer PIN' using errcode = '42501';
  end if;
  if not exists (select 1 from public.meseros where id = p_mesero_id and restaurante_id = private.mi_restaurante()) then
    raise exception 'Mesero no encontrado' using errcode = '22023';
  end if;
  insert into private.credenciales (mesero_id, pin_hash)
  values (p_mesero_id, extensions.crypt(v_pin, extensions.gen_salt('bf', 10)))
  on conflict (mesero_id) do update
    set pin_hash = excluded.pin_hash, intentos_fallidos = 0, bloqueado_hasta = null, actualizado_en = now();
  return json_build_object('id', p_mesero_id, 'pin', v_pin);
end $$;

alter table public.meseros drop column pin;

-- Ahora que no hay columna sensible, authenticated puede leer meseros completo.
grant select on public.meseros to authenticated;
