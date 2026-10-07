-- Pruebas de la FASE 1 simulando roles. Se ejecuta DESPUÉS del SQL de la
-- migración, en la MISMA transacción, y termina con RAISE EXCEPTION para que
-- todo (migración + datos de prueba) se revierta. El mensaje del error trae
-- el resumen: "RESULTADO: n OK, m FALLAS ...".
do $$
declare
  r text[] := '{}';
  ok int := 0; fallas int := 0;
  v json; n int; t text;
  uid_pablo uuid := '00000000-0000-0000-0000-00000000a001';
  uid_caja  uuid := '00000000-0000-0000-0000-00000000a002';
  uid_otro  uuid := '00000000-0000-0000-0000-00000000a003';
  v_pedido text;
begin
  -- ---------- datos de prueba (otro restaurante) ----------
  insert into public.restaurantes (id, nombre) values ('rest-test', 'Restaurante de prueba');
  insert into public.meseros (id, restaurante_id, nombre, usuario, pin, estado, rol)
    values ('u-test-otro', 'rest-test', 'Otro Restaurante', 'otro-test', '5555', 'activo', 'admin');
  update private.credenciales set auth_user_id = uid_pablo where mesero_id = 'u-pablo';
  update private.credenciales set auth_user_id = uid_caja  where mesero_id = 'u-caja';
  update private.credenciales set auth_user_id = uid_otro  where mesero_id = 'u-test-otro';

  -- trigger de compatibilidad creó el hash del mesero insertado con pin
  select count(*) into n from private.credenciales where mesero_id='u-test-otro' and extensions.crypt('5555', pin_hash)=pin_hash;
  if n=1 then ok:=ok+1; else fallas:=fallas+1; r:=r||'trigger legado no generó hash'; end if;
  -- todos los meseros existentes tienen hash
  select count(*) into n from public.meseros m left join private.credenciales c on c.mesero_id=m.id where c.pin_hash is null;
  if n=0 then ok:=ok+1; else fallas:=fallas+1; r:=r||('meseros sin hash: '||n); end if;

  -- ---------- verificar_pin_login + bloqueo ----------
  v := public.verificar_pin_login('u-test-otro', '5555', 'mesero');
  if v->>'motivo'='usuario_invalido' then ok:=ok+1; else fallas:=fallas+1; r:=r||('rol equivocado: '||v); end if;
  v := public.verificar_pin_login('u-test-otro', '5555', 'admin');
  if (v->>'ok')::bool then ok:=ok+1; else fallas:=fallas+1; r:=r||('pin correcto: '||v); end if;
  for i in 1..4 loop
    v := public.verificar_pin_login('u-test-otro', '0000', 'admin');
  end loop;
  if v->>'motivo'='pin_incorrecto' and (v->>'intentos_restantes')::int=1 then ok:=ok+1; else fallas:=fallas+1; r:=r||('4o intento: '||v); end if;
  v := public.verificar_pin_login('u-test-otro', '0000', 'admin');
  if v->>'motivo'='bloqueado' then ok:=ok+1; else fallas:=fallas+1; r:=r||('5o intento: '||v); end if;
  v := public.verificar_pin_login('u-test-otro', '5555', 'admin');
  if v->>'motivo'='bloqueado' then ok:=ok+1; else fallas:=fallas+1; r:=r||('correcto durante bloqueo: '||v); end if;
  update private.credenciales set bloqueado_hasta = now() - interval '1 second' where mesero_id='u-test-otro';
  v := public.verificar_pin_login('u-test-otro', '5555', 'admin');
  if (v->>'ok')::bool then ok:=ok+1; else fallas:=fallas+1; r:=r||('tras vencer bloqueo: '||v); end if;
  select intentos_fallidos into n from private.credenciales where mesero_id='u-test-otro';
  if n=0 then ok:=ok+1; else fallas:=fallas+1; r:=r||'contador no se reinició'; end if;

  -- ---------- anon ----------
  execute 'set local role anon';
  v := public.opciones_login('rest-fogon');
  if json_array_length(v->'usuarios')=4 and v::text not like '%pin%' then ok:=ok+1; else fallas:=fallas+1; r:=r||('opciones_login: '||v); end if;
  begin
    v := public.verificar_pin_login('u-pablo','1234','mesero');
    fallas:=fallas+1; r:=r||'anon pudo llamar verificar_pin_login';
  exception when insufficient_privilege then ok:=ok+1; end;
  begin
    perform count(*) from private.credenciales;
    fallas:=fallas+1; r:=r||'anon leyó private.credenciales';
  exception when insufficient_privilege then ok:=ok+1; end;
  begin
    v := public.admin_restablecer_pin('u-pablo');
    fallas:=fallas+1; r:=r||'anon restableció pin';
  exception when insufficient_privilege then ok:=ok+1; end;
  execute 'reset role';

  -- ---------- mesero (pablo) ----------
  perform set_config('request.jwt.claims', json_build_object('sub', uid_pablo, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from public.meseros;
  if n=4 then ok:=ok+1; else fallas:=fallas+1; r:=r||('mesero ve meseros: '||n); end if;
  begin
    select max(pin) into t from public.meseros;
    fallas:=fallas+1; r:=r||'mesero pudo leer la columna pin';
  exception when insufficient_privilege then ok:=ok+1; end;
  select count(*) into n from public.restaurantes;
  if n=1 then ok:=ok+1; else fallas:=fallas+1; r:=r||('mesero ve restaurantes: '||n); end if;
  select count(*) into n from public.pagos;
  if n=0 then ok:=ok+1; else fallas:=fallas+1; r:=r||('mesero ve pagos: '||n); end if;
  select count(*) into n from public.productos;
  if n=12 then ok:=ok+1; else fallas:=fallas+1; r:=r||('mesero ve productos: '||n); end if;
  -- flujo normal del mesero: crear pedido, ocupar mesa, ronda, pedir cuenta
  insert into public.pedidos (restaurante_id, mesa_id, mesero_principal_id)
    values ('rest-fogon', (select id from public.mesas where pedido_activo_id is null order by numero limit 1), 'u-pablo')
    returning id into v_pedido;
  update public.mesas set pedido_activo_id = v_pedido
    where id = (select mesa_id from public.pedidos where id = v_pedido);
  get diagnostics n = row_count;
  if n=1 then ok:=ok+1; else fallas:=fallas+1; r:=r||'mesero no pudo ocupar mesa'; end if;
  insert into public.rondas (id, pedido_id, numero, mesero_id, items) values (v_pedido||'-R1', v_pedido, 1, 'u-pablo', '[]');
  update public.pedidos set estado_cuenta='cuenta_solicitada', cuenta_solicitada_en=now() where id=v_pedido;
  get diagnostics n = row_count;
  if n=1 then ok:=ok+1; else fallas:=fallas+1; r:=r||'mesero no pudo pedir cuenta'; end if;
  update public.rondas set estado='entregado' where id=v_pedido||'-R1';
  get diagnostics n = row_count;
  if n=1 then ok:=ok+1; else fallas:=fallas+1; r:=r||'mesero no pudo marcar entregado'; end if;
  -- lo que NO puede hacer
  begin
    update public.pedidos set descuento=99999 where id=v_pedido;
    fallas:=fallas+1; r:=r||'mesero aplicó descuento';
  exception when insufficient_privilege then ok:=ok+1; end;
  begin
    update public.pedidos set estado_cuenta='pagado' where id=v_pedido;
    fallas:=fallas+1; r:=r||'mesero marcó pagado';
  exception when insufficient_privilege then ok:=ok+1; end;
  begin
    update public.mesas set pedido_activo_id=null where pedido_activo_id=v_pedido;
    fallas:=fallas+1; r:=r||'mesero liberó mesa';
  exception when insufficient_privilege then ok:=ok+1; end;
  begin
    insert into public.pedidos (restaurante_id, mesa_id, mesero_principal_id)
      values ('rest-fogon', (select id from public.mesas order by numero limit 1), 'u-laura');
    fallas:=fallas+1; r:=r||'mesero creó pedido a nombre de otro';
  exception when insufficient_privilege then ok:=ok+1; end;
  begin
    insert into public.productos (id, restaurante_id, codigo, nombre, precio) values ('p-x','rest-fogon','1','x',1);
    fallas:=fallas+1; r:=r||'mesero creó producto';
  exception when insufficient_privilege then ok:=ok+1; end;
  begin
    insert into public.pagos (pedido_id, forma_pago, valor) values (v_pedido, 'efectivo', 1);
    fallas:=fallas+1; r:=r||'mesero registró pago';
  exception when insufficient_privilege then ok:=ok+1; end;
  begin
    update public.meseros set estado='inactivo' where id='u-laura';
    get diagnostics n = row_count;
    if n=0 then ok:=ok+1; else fallas:=fallas+1; r:=r||'mesero desactivó a otro'; end if;
  exception when insufficient_privilege then ok:=ok+1; end;
  begin
    update public.meseros set rol='admin' where id='u-pablo';
    fallas:=fallas+1; r:=r||'mesero se cambió el rol';
  exception when insufficient_privilege then ok:=ok+1; end;
  begin
    v := public.admin_crear_mesero('X','xx');
    fallas:=fallas+1; r:=r||'mesero creó mesero';
  exception when insufficient_privilege then ok:=ok+1; end;
  begin
    delete from public.pedidos where id=v_pedido;
    fallas:=fallas+1; r:=r||'mesero borró pedido';
  exception when insufficient_privilege then ok:=ok+1; end;
  execute 'reset role';

  -- ---------- caja (admin) ----------
  perform set_config('request.jwt.claims', json_build_object('sub', uid_caja, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from public.pagos;
  if n>=6 then ok:=ok+1; else fallas:=fallas+1; r:=r||('caja ve pagos: '||n); end if;
  insert into public.pagos (pedido_id, forma_pago, valor) values (v_pedido, 'efectivo', 1000);
  delete from public.pagos where pedido_id=v_pedido;
  get diagnostics n = row_count;
  if n=1 then ok:=ok+1; else fallas:=fallas+1; r:=r||'caja no pudo borrar pago'; end if;
  update public.pedidos set descuento=500, servicio_aplicado=false where id=v_pedido;
  update public.pedidos set estado_cuenta='pagado', pagado_en=now() where id=v_pedido;
  update public.mesas set pedido_activo_id=null where pedido_activo_id=v_pedido;
  get diagnostics n = row_count;
  if n=1 then ok:=ok+1; else fallas:=fallas+1; r:=r||'caja no pudo liberar mesa'; end if;
  update public.productos set precio=precio where id=(select id from public.productos limit 1);
  get diagnostics n = row_count;
  if n=1 then ok:=ok+1; else fallas:=fallas+1; r:=r||'caja no pudo editar producto'; end if;
  v := public.admin_crear_mesero('Mesero Prueba', 'prueba.rls');
  if (v->>'pin') ~ '^[0-9]{4}$' then ok:=ok+1; else fallas:=fallas+1; r:=r||('crear mesero: '||v); end if;
  v := public.admin_restablecer_pin('u-pablo');
  if (v->>'pin') ~ '^[0-9]{4}$' then ok:=ok+1; else fallas:=fallas+1; r:=r||('restablecer: '||v); end if;
  update public.meseros set estado='inactivo' where id='u-caja';
  get diagnostics n = row_count;
  if n=0 then ok:=ok+1; else fallas:=fallas+1; r:=r||'caja se desactivó a sí misma'; end if;
  begin
    v := public.admin_restablecer_pin('u-test-otro');
    fallas:=fallas+1; r:=r||'caja restableció pin de otro restaurante';
  exception when sqlstate '22023' then ok:=ok+1; end;
  select count(*) into n from public.meseros where restaurante_id='rest-test';
  if n=0 then ok:=ok+1; else fallas:=fallas+1; r:=r||'caja ve meseros de otro restaurante'; end if;
  execute 'reset role';

  -- el PIN restablecido es el que vale ahora (y el plano se borró)
  select count(*) into n from public.meseros where id='u-pablo' and pin is null;
  if n=1 then ok:=ok+1; else fallas:=fallas+1; r:=r||'pin plano no se borró'; end if;

  -- ---------- admin de OTRO restaurante ----------
  perform set_config('request.jwt.claims', json_build_object('sub', uid_otro, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from public.pedidos;
  if n=0 then ok:=ok+1; else fallas:=fallas+1; r:=r||('otro restaurante ve pedidos: '||n); end if;
  select count(*) into n from public.pagos;
  if n=0 then ok:=ok+1; else fallas:=fallas+1; r:=r||('otro restaurante ve pagos: '||n); end if;
  update public.productos set precio=1;
  get diagnostics n = row_count;
  if n=0 then ok:=ok+1; else fallas:=fallas+1; r:=r||'otro restaurante cambió precios'; end if;
  execute 'reset role';

  -- ---------- mesero desactivado pierde acceso de inmediato ----------
  update public.meseros set estado='inactivo' where id='u-pablo';
  perform set_config('request.jwt.claims', json_build_object('sub', uid_pablo, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from public.pedidos;
  if n=0 then ok:=ok+1; else fallas:=fallas+1; r:=r||('mesero inactivo ve pedidos: '||n); end if;
  execute 'reset role';

  raise exception 'RESULTADO: % OK, % FALLAS %', ok, fallas, array_to_string(r, ' | ');
end $$;
