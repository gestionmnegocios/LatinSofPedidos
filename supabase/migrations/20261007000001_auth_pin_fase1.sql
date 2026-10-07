-- ============================================================
-- Etapa 2 de seguridad — FASE 1 (compatible hacia atrás)
--
-- Agrega el login real (PIN con hash + sesión de Supabase Auth) y las
-- políticas para el rol "authenticated", SIN quitar todavía nada de lo que
-- usa la versión anterior de la app (rol anon + columna meseros.pin).
-- La fase 2 (otra migración) retira el acceso anon y la columna pin cuando
-- la nueva versión del front ya esté publicada.
-- ============================================================

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
-- authenticated necesita USAGE solo para poder evaluar las funciones
-- auxiliares que usan las políticas RLS; las tablas siguen sin permisos.
grant usage on schema private to authenticated;

-- ---------- Credenciales: PIN con hash bcrypt + control de intentos ----------
create table if not exists private.credenciales (
  mesero_id          text primary key references public.meseros(id) on delete cascade,
  pin_hash           text,
  intentos_fallidos  integer not null default 0,
  bloqueado_hasta    timestamptz,
  auth_user_id       uuid unique,
  actualizado_en     timestamptz not null default now()
);
revoke all on private.credenciales from public, anon, authenticated;

insert into private.credenciales (mesero_id, pin_hash)
select m.id, extensions.crypt(m.pin, extensions.gen_salt('bf', 10))
from public.meseros m
where m.pin is not null
on conflict (mesero_id) do nothing;

-- La columna pin deja de ser obligatoria: los meseros creados por la app
-- nueva solo tienen hash. (Se elimina del todo en la fase 2.)
alter table public.meseros alter column pin drop not null;

-- Mientras conviva la app anterior: si ella crea un mesero o restablece un
-- PIN escribiendo meseros.pin, el hash se mantiene al día.
create or replace function private.sincronizar_pin_legado()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.pin is not null and (tg_op = 'INSERT' or new.pin is distinct from old.pin) then
    insert into private.credenciales as c (mesero_id, pin_hash)
    values (new.id, extensions.crypt(new.pin, extensions.gen_salt('bf', 10)))
    on conflict (mesero_id) do update
      set pin_hash = excluded.pin_hash, intentos_fallidos = 0,
          bloqueado_hasta = null, actualizado_en = now();
  end if;
  return new;
end $$;
drop trigger if exists sincronizar_pin_legado on public.meseros;
create trigger sincronizar_pin_legado
  after insert or update of pin on public.meseros
  for each row execute function private.sincronizar_pin_legado();

-- ---------- Quién es el usuario de la sesión (para RLS) ----------
-- Se consulta la tabla en cada petición (no el JWT) para que desactivar a
-- un mesero o cambiarle el rol tenga efecto inmediato, sin esperar a que
-- expire su token.
create or replace function private.mi_mesero_id()
returns text language sql stable security definer set search_path = '' as $$
  select m.id from private.credenciales c
  join public.meseros m on m.id = c.mesero_id
  where c.auth_user_id = auth.uid() and m.estado = 'activo'
$$;
create or replace function private.mi_restaurante()
returns text language sql stable security definer set search_path = '' as $$
  select m.restaurante_id from private.credenciales c
  join public.meseros m on m.id = c.mesero_id
  where c.auth_user_id = auth.uid() and m.estado = 'activo'
$$;
create or replace function private.mi_rol()
returns text language sql stable security definer set search_path = '' as $$
  select m.rol from private.credenciales c
  join public.meseros m on m.id = c.mesero_id
  where c.auth_user_id = auth.uid() and m.estado = 'activo'
$$;
create or replace function private.pedido_es_mio(p_pedido_id text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.pedidos p
                where p.id = p_pedido_id and p.restaurante_id = private.mi_restaurante())
$$;
revoke all on function private.mi_mesero_id(), private.mi_restaurante(), private.mi_rol(),
  private.pedido_es_mio(text), private.sincronizar_pin_legado() from public, anon;
grant execute on function private.mi_mesero_id(), private.mi_restaurante(), private.mi_rol(),
  private.pedido_es_mio(text) to authenticated;

-- ---------- Privilegios de tabla para authenticated (mínimos) ----------
revoke all on public.restaurantes, public.categorias, public.productos, public.meseros,
  public.mesas, public.pedidos, public.rondas, public.pagos from authenticated;

grant select on public.restaurantes, public.categorias, public.productos,
  public.mesas, public.pedidos, public.rondas, public.pagos to authenticated;
-- meseros: nunca la columna pin
grant select (id, restaurante_id, nombre, usuario, estado, ultimo_ingreso, rol) on public.meseros to authenticated;
grant update (estado) on public.meseros to authenticated;
grant insert on public.productos to authenticated;
grant update (precio, estado) on public.productos to authenticated;
grant update (pedido_activo_id) on public.mesas to authenticated;
grant insert on public.pedidos to authenticated;
grant update (estado_cuenta, cuenta_solicitada_en, pagado_en, servicio_aplicado, descuento) on public.pedidos to authenticated;
grant insert on public.rondas to authenticated;
grant update (estado, historial, motivo_anulacion) on public.rondas to authenticated;
grant insert, delete on public.pagos to authenticated;

-- ---------- Políticas RLS para authenticated ----------
create policy auth_leer on public.restaurantes for select to authenticated
  using (id = (select private.mi_restaurante()));

create policy auth_leer on public.categorias for select to authenticated
  using (restaurante_id = (select private.mi_restaurante()));

create policy auth_leer on public.productos for select to authenticated
  using (restaurante_id = (select private.mi_restaurante()));
create policy auth_admin_crear on public.productos for insert to authenticated
  with check (restaurante_id = (select private.mi_restaurante()) and (select private.mi_rol()) = 'admin');
create policy auth_admin_modificar on public.productos for update to authenticated
  using (restaurante_id = (select private.mi_restaurante()) and (select private.mi_rol()) = 'admin')
  with check (restaurante_id = (select private.mi_restaurante()));

create policy auth_leer on public.meseros for select to authenticated
  using (restaurante_id = (select private.mi_restaurante()));
create policy auth_admin_modificar on public.meseros for update to authenticated
  using (restaurante_id = (select private.mi_restaurante()) and (select private.mi_rol()) = 'admin'
         and id <> (select private.mi_mesero_id()))  -- nadie se desactiva a sí mismo
  with check (restaurante_id = (select private.mi_restaurante()));

create policy auth_leer on public.mesas for select to authenticated
  using (restaurante_id = (select private.mi_restaurante()));
create policy auth_modificar on public.mesas for update to authenticated
  using (restaurante_id = (select private.mi_restaurante()))
  with check (restaurante_id = (select private.mi_restaurante())
              and (pedido_activo_id is null or private.pedido_es_mio(pedido_activo_id)));

create policy auth_leer on public.pedidos for select to authenticated
  using (restaurante_id = (select private.mi_restaurante()));
create policy auth_crear on public.pedidos for insert to authenticated
  with check (
    restaurante_id = (select private.mi_restaurante())
    and exists (select 1 from public.mesas me where me.id = mesa_id and me.restaurante_id = (select private.mi_restaurante()))
    and ((select private.mi_rol()) = 'admin' or mesero_principal_id = (select private.mi_mesero_id()))
  );
create policy auth_modificar on public.pedidos for update to authenticated
  using (restaurante_id = (select private.mi_restaurante()))
  with check (restaurante_id = (select private.mi_restaurante()));

create policy auth_leer on public.rondas for select to authenticated
  using (private.pedido_es_mio(pedido_id));
create policy auth_crear on public.rondas for insert to authenticated
  with check (private.pedido_es_mio(pedido_id)
              and ((select private.mi_rol()) = 'admin' or mesero_id = (select private.mi_mesero_id())));
create policy auth_modificar on public.rondas for update to authenticated
  using (private.pedido_es_mio(pedido_id))
  with check (private.pedido_es_mio(pedido_id));

-- pagos: solo caja/administración
create policy auth_admin_leer on public.pagos for select to authenticated
  using ((select private.mi_rol()) = 'admin' and private.pedido_es_mio(pedido_id));
create policy auth_admin_crear on public.pagos for insert to authenticated
  with check ((select private.mi_rol()) = 'admin' and private.pedido_es_mio(pedido_id));
create policy auth_admin_borrar on public.pagos for delete to authenticated
  using ((select private.mi_rol()) = 'admin' and private.pedido_es_mio(pedido_id));

-- ---------- Lo que un mesero (no admin) NO puede cambiar ----------
-- Las políticas son por fila; estas reglas limitan qué transiciones puede
-- hacer un mesero. Para anon/service_role (sin sesión de mesero) no aplican.
create or replace function private.restringir_mesero()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if private.mi_rol() is distinct from 'mesero' then
    return new;
  end if;
  if tg_table_name = 'pedidos' then
    if old.estado_cuenta = 'pagado'
       or new.estado_cuenta not in (old.estado_cuenta, 'cuenta_solicitada')
       or new.pagado_en is distinct from old.pagado_en
       or new.servicio_aplicado is distinct from old.servicio_aplicado
       or new.descuento is distinct from old.descuento then
      raise exception 'Un mesero solo puede pedir la cuenta' using errcode = '42501';
    end if;
  elsif tg_table_name = 'rondas' then
    if new.motivo_anulacion is distinct from old.motivo_anulacion
       or old.estado = 'anulado'
       or new.estado not in (old.estado, 'entregado') then
      raise exception 'Un mesero solo puede marcar rondas como entregadas' using errcode = '42501';
    end if;
  elsif tg_table_name = 'mesas' then
    if old.pedido_activo_id is not null and new.pedido_activo_id is distinct from old.pedido_activo_id then
      raise exception 'Un mesero no puede liberar ni reasignar una mesa ocupada' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
revoke all on function private.restringir_mesero() from public, anon, authenticated;

create trigger restringir_mesero before update on public.pedidos
  for each row execute function private.restringir_mesero();
create trigger restringir_mesero before update on public.rondas
  for each row execute function private.restringir_mesero();
create trigger restringir_mesero before update on public.mesas
  for each row execute function private.restringir_mesero();

-- ---------- RPC públicas ----------

-- Pantalla de login: solo nombre del restaurante y usuarios activos (sin PIN).
create or replace function public.opciones_login(p_restaurante_id text)
returns json language sql stable security definer set search_path = '' as $$
  select json_build_object(
    'restaurante', (select json_build_object('nombre', r.nombre) from public.restaurantes r where r.id = p_restaurante_id),
    'usuarios', coalesce((select json_agg(json_build_object('id', m.id, 'nombre', m.nombre, 'rol', m.rol) order by m.nombre)
                          from public.meseros m
                          where m.restaurante_id = p_restaurante_id and m.estado = 'activo'), '[]'::json)
  )
$$;
revoke all on function public.opciones_login(text) from public;
grant execute on function public.opciones_login(text) to anon, authenticated;

-- Verificación del PIN: SOLO la llama la Edge Function login-pin (service_role).
-- 5 intentos fallidos => bloqueo de 15 min, que se duplica con cada nueva
-- tanda de 5 fallos (tope 24 h). Un PIN correcto o un restablecimiento lo reinicia.
create or replace function public.verificar_pin_login(p_mesero_id text, p_pin text, p_rol text)
returns json language plpgsql security definer set search_path = '' as $$
declare
  v_m public.meseros%rowtype;
  v_c private.credenciales%rowtype;
  v_bloqueo interval;
begin
  select * into v_m from public.meseros where id = p_mesero_id;
  if not found or v_m.estado <> 'activo' or v_m.rol is distinct from p_rol then
    return json_build_object('ok', false, 'motivo', 'usuario_invalido');
  end if;
  select * into v_c from private.credenciales where mesero_id = p_mesero_id for update;
  if not found or v_c.pin_hash is null then
    return json_build_object('ok', false, 'motivo', 'sin_pin');
  end if;
  if v_c.bloqueado_hasta is not null and v_c.bloqueado_hasta > now() then
    return json_build_object('ok', false, 'motivo', 'bloqueado', 'bloqueado_hasta', v_c.bloqueado_hasta);
  end if;
  if p_pin ~ '^[0-9]{4}$' and extensions.crypt(p_pin, v_c.pin_hash) = v_c.pin_hash then
    update private.credenciales set intentos_fallidos = 0, bloqueado_hasta = null where mesero_id = p_mesero_id;
    update public.meseros set ultimo_ingreso = now() where id = p_mesero_id;
    return json_build_object('ok', true, 'mesero_id', v_m.id, 'restaurante_id', v_m.restaurante_id,
                             'rol', v_m.rol, 'nombre', v_m.nombre, 'auth_user_id', v_c.auth_user_id);
  end if;
  v_c.intentos_fallidos := v_c.intentos_fallidos + 1;
  if v_c.intentos_fallidos % 5 = 0 then
    v_bloqueo := least(interval '15 minutes' * power(2, v_c.intentos_fallidos / 5 - 1), interval '24 hours');
    update private.credenciales set intentos_fallidos = v_c.intentos_fallidos, bloqueado_hasta = now() + v_bloqueo
      where mesero_id = p_mesero_id;
    return json_build_object('ok', false, 'motivo', 'bloqueado', 'bloqueado_hasta', now() + v_bloqueo);
  end if;
  update private.credenciales set intentos_fallidos = v_c.intentos_fallidos where mesero_id = p_mesero_id;
  return json_build_object('ok', false, 'motivo', 'pin_incorrecto', 'intentos_restantes', 5 - v_c.intentos_fallidos % 5);
end $$;
revoke all on function public.verificar_pin_login(text, text, text) from public, anon, authenticated;
grant execute on function public.verificar_pin_login(text, text, text) to service_role;

-- La Edge Function guarda aquí el usuario de Auth creado para el mesero.
create or replace function public.vincular_usuario_auth(p_mesero_id text, p_auth_user_id uuid)
returns void language sql security definer set search_path = '' as $$
  update private.credenciales set auth_user_id = p_auth_user_id where mesero_id = p_mesero_id
$$;
revoke all on function public.vincular_usuario_auth(text, uuid) from public, anon, authenticated;
grant execute on function public.vincular_usuario_auth(text, uuid) to service_role;

-- PIN aleatorio de 4 dígitos generado en el servidor.
create or replace function private.pin_aleatorio()
returns text language sql volatile set search_path = '' as $$
  select lpad(((('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint % 10000))::text, 4, '0')
$$;
revoke all on function private.pin_aleatorio() from public, anon, authenticated;

-- Caja/administración crea un mesero; devuelve el PIN una sola vez.
create or replace function public.admin_crear_mesero(p_nombre text, p_usuario text)
returns json language plpgsql security definer set search_path = '' as $$
declare
  v_rest text := private.mi_restaurante();
  v_id text := 'u-' || replace(gen_random_uuid()::text, '-', '');
  v_pin text := private.pin_aleatorio();
begin
  if private.mi_rol() is distinct from 'admin' then
    raise exception 'Solo administración puede crear meseros' using errcode = '42501';
  end if;
  if coalesce(trim(p_nombre), '') = '' or coalesce(p_usuario, '') !~ '^[a-z0-9._-]{2,30}$' then
    raise exception 'Nombre o usuario inválido' using errcode = '22023';
  end if;
  insert into public.meseros (id, restaurante_id, nombre, usuario, estado, rol)
  values (v_id, v_rest, trim(p_nombre), p_usuario, 'activo', 'mesero');
  insert into private.credenciales (mesero_id, pin_hash)
  values (v_id, extensions.crypt(v_pin, extensions.gen_salt('bf', 10)));
  return json_build_object('id', v_id, 'pin', v_pin);
end $$;

-- Caja/administración restablece el PIN de alguien de su restaurante
-- (también el propio). Quita el bloqueo y borra el PIN en texto plano heredado.
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
  update public.meseros set pin = null where id = p_mesero_id;
  insert into private.credenciales (mesero_id, pin_hash)
  values (p_mesero_id, extensions.crypt(v_pin, extensions.gen_salt('bf', 10)))
  on conflict (mesero_id) do update
    set pin_hash = excluded.pin_hash, intentos_fallidos = 0, bloqueado_hasta = null, actualizado_en = now();
  return json_build_object('id', p_mesero_id, 'pin', v_pin);
end $$;
revoke all on function public.admin_crear_mesero(text, text), public.admin_restablecer_pin(text) from public, anon;
grant execute on function public.admin_crear_mesero(text, text), public.admin_restablecer_pin(text) to authenticated;
