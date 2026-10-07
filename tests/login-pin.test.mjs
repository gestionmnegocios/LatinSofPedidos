// Pruebas de la lógica de la Edge Function login-pin (handler.ts) con
// dependencias simuladas. Node >= 22.18 / 23.6 importa .ts directamente.
import { manejarLogin, emailSintetico } from '../supabase/functions/login-pin/handler.ts';

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) pass++;
  else { fail++; console.error('FALLÓ:', msg); }
}

function dobles(verificacion, opciones = {}) {
  const llamadas = [];
  const usuarios = new Set(opciones.usuariosExistentes || []);
  const deps = {
    async verificarPin(id, pin, rol) { llamadas.push(['verificarPin', id, pin, rol]); return verificacion; },
    async existeUsuario(uid) { llamadas.push(['existeUsuario', uid]); return usuarios.has(uid); },
    async crearUsuario(email, meta) { llamadas.push(['crearUsuario', email, meta]); usuarios.add('nuevo-uid'); return 'nuevo-uid'; },
    async actualizarMetadatos(uid, meta) { llamadas.push(['actualizarMetadatos', uid, meta]); },
    async vincularUsuario(id, uid) { llamadas.push(['vincularUsuario', id, uid]); },
    async emitirSesion(email) { llamadas.push(['emitirSesion', email]); return { access_token: 'at', refresh_token: 'rt', expires_at: 1, user: { secreto: 'no debe salir' } }; },
  };
  return { deps, llamadas, nombres: () => llamadas.map(l => l[0]) };
}

const OK = { ok: true, mesero_id: 'u-pablo', restaurante_id: 'rest-fogon', rol: 'mesero', nombre: 'Pablo Pérez', auth_user_id: null };

// 1) Entradas inválidas: ni siquiera se consulta la base
for (const [entrada, desc] of [
  [null, 'sin cuerpo'],
  [{ mesero_id: 'u-pablo', pin: '123', rol: 'mesero' }, 'PIN de 3 dígitos'],
  [{ mesero_id: 'u-pablo', pin: '12a4', rol: 'mesero' }, 'PIN no numérico'],
  [{ mesero_id: 'u-pablo', pin: 1234, rol: 'mesero' }, 'PIN como número'],
  [{ mesero_id: "x' or 1=1", pin: '1234', rol: 'mesero' }, 'id con caracteres raros'],
  [{ mesero_id: 'u-pablo', pin: '1234', rol: 'superadmin' }, 'rol desconocido'],
]) {
  const d = dobles(OK);
  const r = await manejarLogin(entrada, d.deps);
  assert(r.status === 400 && r.body.motivo === 'solicitud_invalida', 'rechaza ' + desc);
  assert(d.llamadas.length === 0, 'no consulta nada con ' + desc);
}

// 2) PIN incorrecto: se reenvía el motivo y los intentos, sin crear sesión
{
  const d = dobles({ ok: false, motivo: 'pin_incorrecto', intentos_restantes: 3 });
  const r = await manejarLogin({ mesero_id: 'u-pablo', pin: '0000', rol: 'mesero' }, d.deps);
  assert(r.status === 200 && r.body.ok === false && r.body.motivo === 'pin_incorrecto' && r.body.intentos_restantes === 3, 'PIN incorrecto informa intentos restantes');
  assert(!d.nombres().includes('emitirSesion'), 'PIN incorrecto no emite sesión');
  assert(!('session' in r.body), 'PIN incorrecto no devuelve tokens');
}

// 3) Bloqueado
{
  const d = dobles({ ok: false, motivo: 'bloqueado', bloqueado_hasta: '2026-10-07T20:00:00Z' });
  const r = await manejarLogin({ mesero_id: 'u-pablo', pin: '1234', rol: 'mesero' }, d.deps);
  assert(r.body.motivo === 'bloqueado' && r.body.bloqueado_hasta === '2026-10-07T20:00:00Z', 'bloqueo informa hasta cuándo');
  assert(!d.nombres().includes('emitirSesion'), 'bloqueado no emite sesión');
}

// 4) Primer ingreso: crea el usuario de Auth, lo vincula y emite sesión
{
  const d = dobles(OK);
  const r = await manejarLogin({ mesero_id: 'u-pablo', pin: '1234', rol: 'mesero' }, d.deps);
  assert(r.status === 200 && r.body.ok === true, 'PIN correcto => ok');
  const crear = d.llamadas.find(l => l[0] === 'crearUsuario');
  assert(!!crear && crear[1] === 'u-pablo@usuarios.latinsofpedidos.invalid', 'crea el usuario con email sintético .invalid');
  assert(JSON.stringify(crear[2]) === JSON.stringify({ mesero_id: 'u-pablo', restaurante_id: 'rest-fogon', rol: 'mesero' }), 'app_metadata lleva mesero, restaurante y rol');
  assert(d.llamadas.some(l => l[0] === 'vincularUsuario' && l[1] === 'u-pablo' && l[2] === 'nuevo-uid'), 'vincula el usuario de Auth con el mesero');
  assert(d.llamadas.find(l => l[0] === 'verificarPin')[3] === 'mesero', 'verifica exigiendo el rol pedido');
  assert(r.body.session.access_token === 'at' && r.body.session.refresh_token === 'rt', 'devuelve los tokens de la sesión');
  assert(JSON.stringify(r.body).indexOf('no debe salir') === -1, 'no reenvía el objeto user completo de Auth');
  assert(JSON.stringify(r.body).indexOf('1234') === -1, 'la respuesta no contiene el PIN');
  assert(r.body.usuario.id === 'u-pablo' && r.body.usuario.rol === 'mesero', 'devuelve quién inició sesión');
}

// 5) Ingresos siguientes: reutiliza el usuario y refresca sus metadatos
{
  const d = dobles(Object.assign({}, OK, { rol: 'admin', auth_user_id: 'uid-1' }), { usuariosExistentes: ['uid-1'] });
  const r = await manejarLogin({ mesero_id: 'u-pablo', pin: '1234', rol: 'admin' }, d.deps);
  assert(r.body.ok === true, 'login con usuario existente');
  assert(!d.nombres().includes('crearUsuario'), 'no crea un usuario nuevo si ya existe');
  const act = d.llamadas.find(l => l[0] === 'actualizarMetadatos');
  assert(!!act && act[1] === 'uid-1' && act[2].rol === 'admin', 'actualiza app_metadata (p. ej. cambio de rol)');
}

// 6) Si el usuario de Auth vinculado fue borrado, se recrea
{
  const d = dobles(Object.assign({}, OK, { auth_user_id: 'uid-borrado' }));
  const r = await manejarLogin({ mesero_id: 'u-pablo', pin: '1234', rol: 'mesero' }, d.deps);
  assert(r.body.ok === true && d.nombres().includes('crearUsuario') && d.nombres().includes('vincularUsuario'), 'recrea y revincula un usuario de Auth borrado');
}

// 7) Errores internos se propagan (index.ts responde 500 sin detalles)
{
  const d = dobles(OK);
  d.deps.emitirSesion = async () => { throw new Error('auth caído'); };
  let lanzo = false;
  try { await manejarLogin({ mesero_id: 'u-pablo', pin: '1234', rol: 'mesero' }, d.deps); } catch (e) { lanzo = true; }
  assert(lanzo, 'un fallo al emitir la sesión no se convierte en login exitoso');
}

assert(emailSintetico('U-Pablo') === 'u-pablo@usuarios.latinsofpedidos.invalid', 'email sintético en minúsculas');

console.log('\n' + pass + ' pruebas de login-pin pasaron, ' + fail + ' fallaron.');
process.exit(fail > 0 ? 1 : 0);
