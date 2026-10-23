-- ============================================================
-- Cambio de mesa: traslada el pedido abierto (rondas, cuenta y pagos,
-- que cuelgan del pedido) de una mesa ocupada a una mesa libre.
--
-- Se hace en una sola función para que sea atómico: bloquea las dos mesas,
-- verifica que el destino siga libre y mueve todo o nada. La pueden usar
-- meseros y caja del mismo restaurante.
-- ============================================================

-- Los meseros normalmente no pueden liberar ni reasignar una mesa ocupada
-- (private.restringir_mesero). cambiar_mesa marca la transacción para que
-- ese control deje pasar SOLO este traslado. La marca la pone únicamente
-- esta función (set_config no está expuesto por la API) y dura hasta el
-- fin de la transacción.
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
    if old.pedido_activo_id is not null and new.pedido_activo_id is distinct from old.pedido_activo_id
       and coalesce(current_setting('latinsoft.cambio_mesa', true), '') <> 'on' then
      raise exception 'Un mesero no puede liberar ni reasignar una mesa ocupada' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
revoke all on function private.restringir_mesero() from public, anon, authenticated;

create or replace function public.cambiar_mesa(p_mesa_origen text, p_mesa_destino text)
returns json language plpgsql security definer set search_path = '' as $$
declare
  v_rest text := private.mi_restaurante();
  v_origen public.mesas%rowtype;
  v_destino public.mesas%rowtype;
  v_pedido text;
begin
  if v_rest is null or private.mi_rol() not in ('mesero', 'admin') then
    raise exception 'Sin permiso para cambiar de mesa' using errcode = '42501';
  end if;
  if p_mesa_origen is null or p_mesa_destino is null or p_mesa_origen = p_mesa_destino then
    return json_build_object('ok', false, 'motivo', 'misma_mesa');
  end if;

  -- bloquea las dos mesas siempre en el mismo orden (evita bloqueos cruzados)
  perform 1 from public.mesas
    where id in (p_mesa_origen, p_mesa_destino) and restaurante_id = v_rest
    order by id for update;

  select * into v_origen from public.mesas where id = p_mesa_origen and restaurante_id = v_rest;
  select * into v_destino from public.mesas where id = p_mesa_destino and restaurante_id = v_rest;
  if v_origen.id is null or v_destino.id is null then
    return json_build_object('ok', false, 'motivo', 'mesa_no_existe');
  end if;
  if v_origen.pedido_activo_id is null then
    return json_build_object('ok', false, 'motivo', 'origen_sin_pedido');
  end if;
  if v_destino.pedido_activo_id is not null then
    return json_build_object('ok', false, 'motivo', 'destino_ocupado', 'mesa_destino', v_destino.numero);
  end if;

  update public.pedidos set mesa_id = v_destino.id
    where id = v_origen.pedido_activo_id and restaurante_id = v_rest and estado_cuenta <> 'pagado'
    returning id into v_pedido;
  if v_pedido is null then
    return json_build_object('ok', false, 'motivo', 'pedido_cerrado');
  end if;

  perform set_config('latinsoft.cambio_mesa', 'on', true);
  update public.mesas set pedido_activo_id = null where id = v_origen.id;
  update public.mesas set pedido_activo_id = v_pedido where id = v_destino.id;
  perform set_config('latinsoft.cambio_mesa', 'off', true);

  return json_build_object('ok', true, 'pedido_id', v_pedido,
    'mesa_origen', v_origen.numero, 'mesa_destino', v_destino.numero);
end $$;
revoke all on function public.cambiar_mesa(text, text) from public, anon;
grant execute on function public.cambiar_mesa(text, text) to authenticated;
