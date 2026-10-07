// Recorrido de clics reales sobre index.html con jsdom, contra un Supabase
// falso en memoria (tests/fake-supabase.js) que aplica reglas de acceso
// parecidas a las del servidor. Cubre el login seguro por PIN (sesión por
// vista, bloqueo por intentos, nada de PIN en el navegador) y los flujos
// del mesero y de caja.
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const fake = require('./fake-supabase.js');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf-8');

// PIN de prueba (solo existen dentro de este doble en memoria)
const PINES = { 'u-pablo': '4821', 'u-laura': '7302', 'u-andres': '1590', 'u-caja': '6047' };

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; }
  else { fail++; console.error('FALLÓ:', msg); }
}

const errors = [];
function abrirPagina(backend, antesDeCargar) {
  const vc = new VirtualConsole();
  vc.on('jsdomError', function (e) { errors.push(e); });
  vc.on('error', function (e) { errors.push(e); });
  return new JSDOM(html, {
    runScripts: 'dangerously',
    resources: undefined, // no carga el CDN de supabase-js: usamos el doble
    url: 'https://example.org/latinsoft-pedidos',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      window.supabase = fake.instalar(backend);
      if (antesDeCargar) antesDeCargar(window);
    },
  });
}

const esperar = async (veces) => { for (let i = 0; i < (veces || 12); i++) await new Promise(r => setTimeout(r, 0)); };

let window, document;
function usar(dom) { window = dom.window; document = window.document; }
function q(sel) { return document.querySelector(sel); }
function qa(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
function text(el) { return el ? el.textContent.replace(/\s+/g, ' ').trim() : ''; }
async function clickAction(action, arg) {
  const sel = arg != null
    ? '[data-action="' + action + '"][data-arg="' + String(arg).replace(/"/g, '\\"') + '"]'
    : '[data-action="' + action + '"]';
  const el = q(sel);
  assert(!!el, 'existe el elemento clicable para acción=' + action + ' arg=' + arg);
  if (el) el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await esperar();
  return el;
}
async function clickEl(el) { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await esperar(); }
function setVal(sel, val) {
  const el = q(sel);
  assert(!!el, 'existe el input ' + sel);
  if (!el) return;
  el.value = val;
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
  el.dispatchEvent(new window.Event('change', { bubbles: true }));
}
async function teclearPin(prefijo, pin) {
  for (const d of pin.split('')) await clickAction(prefijo + 'login-pin-digit', d);
}
function mismoTexto(el, ...variantes) { const t = text(el); return variantes.some(v => t.includes(v)); }

(async function () {
  const backend = fake.crearBackend(PINES);
  const dom = abrirPagina(backend);
  usar(dom);
  await esperar(20);

  // ============================================================
  // 1) Pantalla de login: sin datos ni PIN en el navegador
  // ============================================================
  assert(!!q('.login-wrap'), 'se muestra la pantalla de login al cargar');
  assert(qa('#vista-mesero .user-chip').length === 3, 'aparecen los 3 meseros activos (no la caja) como opciones de login');
  assert(!/demo/i.test(text(q('#vista-mesero'))), 'la pantalla de login ya no muestra credenciales demo');
  assert(Object.values(PINES).every(p => !document.body.innerHTML.includes(p)), 'ningún PIN aparece en el HTML');
  assert(backend.log.from.length === 0, 'sin sesión no se consulta ninguna tabla (solo opciones_login) — consultas: ' + backend.log.from.length);
  assert(backend.log.rpc.some(r => r.fn === 'opciones_login'), 'la pantalla de login se arma con rpc(opciones_login)');

  // PIN equivocado: el error lo decide el servidor e informa los intentos restantes
  await clickAction('login-usuario-select', 'u-pablo');
  await teclearPin('', '9999');
  assert(!!q('.pin-error'), 'muestra error con PIN incorrecto');
  assert(text(q('.pin-error')).toLowerCase().includes('incorrecto'), 'el mensaje menciona PIN incorrecto');
  assert(text(q('.pin-error')).includes('4 intentos'), 'el mensaje dice cuántos intentos quedan — ' + text(q('.pin-error')));
  const ultimoInvoke = backend.log.invoke[backend.log.invoke.length - 1];
  assert(ultimoInvoke.fn === 'login-pin' && ultimoInvoke.body.mesero_id === 'u-pablo' && ultimoInvoke.body.rol === 'mesero',
    'el PIN se envía a la Edge Function login-pin con el rol de la vista');
  assert(ultimoInvoke.cliente === 'mesero', 'el login del mesero usa el cliente de la vista mesero');
  assert(!backend.almacen['latinsoft-sesion-mesero'], 'un PIN equivocado no crea sesión');

  // Bloqueo: 5 fallos seguidos bloquean al usuario, incluso con el PIN correcto
  await clickAction('login-usuario-select', 'u-laura');
  for (let i = 0; i < 5; i++) await teclearPin('', '0000');
  assert(text(q('.pin-error')).includes('Demasiados intentos'), 'tras 5 fallos se informa el bloqueo — ' + text(q('.pin-error')));
  await teclearPin('', PINES['u-laura']);
  assert(text(q('.pin-error')).includes('Demasiados intentos'), 'durante el bloqueo ni el PIN correcto deja entrar');
  assert(!!q('.login-wrap') && !backend.almacen['latinsoft-sesion-mesero'], 'laura sigue fuera mientras dura el bloqueo');

  // login correcto
  await clickAction('login-usuario-select', 'u-pablo');
  await teclearPin('', PINES['u-pablo']);
  assert(!q('#vista-mesero .login-wrap'), 'tras login correcto ya no se muestra la pantalla de login');
  assert(!!q('.mesas-grid'), 'tras login se muestra el mapa de mesas');
  assert(qa('.mesa-circ').length === 15, 'se muestran las 15 mesas');
  const sesionMesero = backend.almacen['latinsoft-sesion-mesero'];
  assert(!!sesionMesero && sesionMesero.user.app_metadata.mesero_id === 'u-pablo', 'queda una sesión de Supabase Auth para pablo');
  assert(backend.log.selectMeseros.length > 0 && backend.log.selectMeseros.every(c => c !== '*' && !/\bpin\b/.test(c)),
    'la app nunca pide la columna pin ni select(*) de meseros — ' + JSON.stringify(backend.log.selectMeseros));
  assert(!backend.almacen['latinsoft-sesion-admin'], 'la vista de caja sigue sin sesión');

  // ============================================================
  // 2) Flujo feliz: Mesa 1 disponible -> escanear -> enviar
  // ============================================================
  const mesa1Btn = q('[data-action="mesa-tap"][data-arg="mesa-1"]');
  assert(!!mesa1Btn && text(mesa1Btn).includes('Disponible'), 'Mesa 1 arranca disponible');
  await clickAction('mesa-tap', 'mesa-1');
  assert(!!q('.carrito-empty'), 'el carrito de la Mesa 1 arranca vacío');

  await clickAction('abrir-scanner');
  assert(qa('.scan-card').length === 12, 'se listan los 12 productos del catálogo en el escáner');
  await clickAction('scan-producto', 'p-hamb-esp');
  await clickAction('scan-producto', 'p-hamb-esp');
  await clickAction('cerrar-scanner');
  assert(!!q('.cart-item'), 'el carrito muestra el producto escaneado');
  assert(text(q('.qty-val')) === '2', 'la segunda lectura sumó una unidad (cantidad = 2)');
  assert(mismoTexto(q('.cart-total'), '56.000', '56,000'), 'el subtotal del carrito es $56.000 — DOM: ' + text(q('.cart-total')));

  await clickAction('carrito-obs-abrir', '0');
  assert(!!q('#obs-texto-input'), 'se abre el modal de observación');
  await clickAction('carrito-obs-chip', '0|sin cebolla');
  await clickAction('carrito-obs-guardar', '0');
  assert(text(q('.cart-item-obs')).includes('sin cebolla'), 'la observación quedó guardada en el ítem');

  await clickAction('enviar-pedido-confirmar-abrir');
  assert(!!q('.m-modal h3'), 'se muestra el modal de confirmación de envío');
  await clickAction('enviar-pedido-confirmar-si');
  assert(!!q('.confirm-wrap'), 'se muestra la pantalla de confirmación tras enviar');
  const idPedidoMesa1 = (text(q('.confirm-wrap')).match(/PED\d+/) || [])[0];
  assert(!!idPedidoMesa1, 'se pudo extraer el ID del pedido recién enviado: ' + idPedidoMesa1);
  const pedidoDb = backend.db.pedidos.find(p => p.id === idPedidoMesa1);
  assert(!!pedidoDb && pedidoDb.mesero_principal_id === 'u-pablo', 'el pedido quedó en la base a nombre de pablo');

  await clickAction('confirmacion-volver-mesas');
  assert(text(q('[data-action="mesa-tap"][data-arg="mesa-1"]')).includes('Pedido enviado'), 'la Mesa 1 figura como "Pedido enviado"');

  // ============================================================
  // 3) Caja: login propio, independiente del mesero
  // ============================================================
  await clickAction('switch-vista', 'admin');
  assert(!q('#vista-admin').classList.contains('hidden'), 'la vista de administración queda visible');
  assert(!!q('#vista-admin .login-wrap'), 'caja pide su propio PIN aunque el mesero ya entró');
  const chipsCaja = qa('#vista-admin .user-chip');
  assert(chipsCaja.length === 1 && text(chipsCaja[0]).includes('Caja'), 'en caja solo aparece la cuenta de administración');
  await clickAction('admin-login-usuario-select', 'u-caja');
  await teclearPin('admin-', PINES['u-pablo']); // PIN de otra persona
  assert(text(q('#vista-admin .pin-error')).toLowerCase().includes('incorrecto'), 'caja no entra con el PIN de un mesero');
  await teclearPin('admin-', PINES['u-caja']);
  assert(!!q('.admin-shell'), 'caja entra con su PIN');
  assert(backend.log.invoke.filter(i => i.cliente === 'admin').every(i => i.body.rol === 'admin'), 'el login de caja pide rol admin');
  assert(backend.almacen['latinsoft-sesion-mesero'].user.app_metadata.mesero_id === 'u-pablo', 'la sesión del mesero sigue intacta tras entrar caja');

  const kcardMesa1 = qa('.kcard').find(c => text(c).includes('Mesa 1') && text(c).includes(idPedidoMesa1));
  assert(!!kcardMesa1, 'el pedido de la Mesa 1 aparece como tarjeta en el kanban');
  assert(text(kcardMesa1).includes('Pablo Pérez'), 'la tarjeta identifica al mesero correcto');
  assert(text(kcardMesa1).includes('sin cebolla'), 'la observación se refleja en la tarjeta de cocina');
  const idRondaMesa1 = kcardMesa1.querySelector('[data-action="ronda-avanzar"]').getAttribute('data-arg').split(',')[1];
  for (const esperado of ['aceptado', 'preparando', 'listo', 'entregado']) {
    const btn = q('[data-action="ronda-avanzar"][data-arg="' + idPedidoMesa1 + ',' + idRondaMesa1 + '"]');
    assert(!!btn, 'existe botón para avanzar a ' + esperado);
    if (btn) await clickEl(btn);
    assert(backend.db.rondas.find(r => r.id === idRondaMesa1).estado === esperado, 'la ronda quedó en ' + esperado);
  }

  // ============================================================
  // 4) El mesero pide la cuenta y caja cobra (pagos solo con sesión de caja)
  // ============================================================
  await clickAction('switch-vista', 'mesero');
  await clickAction('mesa-tap', 'mesa-1');
  await clickAction('pedir-cuenta');
  assert(backend.db.pedidos.find(p => p.id === idPedidoMesa1).estado_cuenta === 'cuenta_solicitada', 'el mesero pudo pedir la cuenta');

  await clickAction('switch-vista', 'admin');
  const kcardConCuenta = qa('.kcard').find(c => text(c).includes(idPedidoMesa1));
  assert(text(kcardConCuenta).includes('Pidió la cuenta'), 'la tarjeta muestra "Pidió la cuenta"');
  await clickEl(kcardConCuenta.querySelector('[data-action="ir-facturar"]'));
  assert(text(q('.admin-topline h2')) === 'Facturación', 'navegó a Facturación');
  assert(mismoTexto(q('.total-line.grand'), '61.600', '61,600'), 'total = 56.000 + 10% = 61.600 — DOM: ' + text(q('.total-line.grand')));
  await clickAction('facturacion-forma-pago', 'efectivo');
  setVal('#recibido-input', '70000');
  assert(mismoTexto(q('#cambio-calc'), '8.400', '8,400'), 'el cambio calculado es 8.400 — DOM: ' + text(q('#cambio-calc')));
  await clickAction('facturacion-cobrar');
  assert(!!q('.comprobante-paper'), 'se muestra el comprobante tras cobrar');
  assert(backend.db.pedidos.find(p => p.id === idPedidoMesa1).estado_cuenta === 'pagado', 'el pedido quedó pagado en la base');
  await clickAction('comprobante-cerrar');
  await clickAction('admin-nav', 'mesas');
  assert(text(q('[data-action="admin-mesa-tap"][data-arg="mesa-1"]')).includes('Disponible'), 'la Mesa 1 vuelve a quedar disponible');

  // ============================================================
  // 5) Pago mixto (Mesa 3)
  // ============================================================
  await clickAction('switch-vista', 'mesero');
  await clickAction('mesero-tab', 'mesas');
  await clickAction('mesa-tap', 'mesa-3');
  await clickAction('abrir-scanner');
  await clickAction('scan-producto', 'p-plato-paisa');
  await clickAction('cerrar-scanner');
  await clickAction('enviar-pedido-confirmar-abrir');
  await clickAction('enviar-pedido-confirmar-si');
  await clickAction('confirmacion-volver-mesas');

  await clickAction('switch-vista', 'admin');
  await clickAction('admin-nav', 'mesas');
  await clickAction('admin-mesa-tap', 'mesa-3');
  await clickAction('ir-facturar', 'mesa-3');
  assert(mismoTexto(q('.total-line.grand'), '35.200', '35,200'), 'total Mesa 3 = 35.200 — DOM: ' + text(q('.total-line.grand')));
  await clickAction('facturacion-forma-pago', 'mixto');
  setVal('#mixto-monto-input', '20000');
  await clickAction('facturacion-agregar-pago');
  assert(q('[data-action="facturacion-cobrar"]').hasAttribute('disabled'), 'Cobrar sigue deshabilitado con pago parcial');
  setVal('#mixto-monto-input', '15200');
  await clickAction('facturacion-agregar-pago');
  assert(!q('[data-action="facturacion-cobrar"]').hasAttribute('disabled'), 'Cobrar se habilita cuando los pagos cubren el total');
  await clickAction('facturacion-cobrar');
  assert(!!q('.comprobante-paper'), 'se cobra con pago mixto y se muestra el comprobante');
  await clickAction('comprobante-cerrar');

  // ============================================================
  // 6) Anulación (Mesa 4)
  // ============================================================
  await clickAction('switch-vista', 'mesero');
  await clickAction('mesero-tab', 'mesas');
  await clickAction('mesa-tap', 'mesa-4');
  await clickAction('abrir-scanner');
  await clickAction('scan-producto', 'p-gaseosa');
  await clickAction('cerrar-scanner');
  await clickAction('enviar-pedido-confirmar-abrir');
  await clickAction('enviar-pedido-confirmar-si');
  await clickAction('confirmacion-volver-mesas');

  await clickAction('switch-vista', 'admin');
  await clickAction('admin-nav', 'dashboard');
  const kcardMesa4 = qa('.kcard').find(c => text(c).includes('Mesa 4'));
  const idPedidoMesa4 = text(kcardMesa4).match(/PED\d+/)[0];
  const idRondaMesa4 = kcardMesa4.querySelector('[data-action="ronda-detalle-abrir"]').getAttribute('data-arg').split(',')[1];
  await clickAction('ronda-detalle-abrir', idPedidoMesa4 + ',' + idRondaMesa4);
  await clickAction('ronda-anular-abrir', idPedidoMesa4 + ',' + idRondaMesa4);
  setVal('#anular-motivo-input', 'Cliente se retractó (prueba automática)');
  await clickAction('ronda-anular-confirmar');
  assert(!qa('.kcard').some(c => text(c).includes(idPedidoMesa4)), 'la ronda anulada desaparece del kanban');

  // ============================================================
  // 7) Productos: desactivar y crear (solo caja)
  // ============================================================
  await clickAction('admin-nav', 'productos');
  assert(qa('table.data-table tbody tr').length === 12, 'la tabla de productos lista 12 productos');
  await clickAction('producto-toggle-estado', 'p-cerveza');
  assert(backend.db.productos.find(p => p.id === 'p-cerveza').estado === 'inactivo', 'la cerveza quedó inactiva en la base');
  await clickAction('producto-crear-abrir');
  setVal('#prod-nombre-input', 'Chuzo de Pollo');
  setVal('#prod-precio-input', '21000');
  await clickAction('producto-crear-guardar');
  assert(qa('table.data-table tbody tr').some(r => text(r).includes('Chuzo de Pollo')), 'el producto creado aparece en la tabla');

  await clickAction('switch-vista', 'mesero');
  await clickAction('mesero-tab', 'mesas');
  await clickAction('mesa-tap', 'mesa-6');
  await clickAction('abrir-scanner');
  const cardCerveza = qa('.scan-card').find(c => text(c).includes('Cerveza'));
  assert(!!cardCerveza && cardCerveza.hasAttribute('disabled'), 'la Cerveza aparece deshabilitada en el escáner');
  await clickAction('cerrar-scanner');

  // ============================================================
  // 8) Meseros: crear con PIN generado en el servidor y restablecer PIN
  // ============================================================
  await clickAction('switch-vista', 'admin');
  await clickAction('admin-nav', 'meseros');
  const filasMeseros = qa('table.data-table tbody tr');
  assert(filasMeseros.length === 4, 'la tabla lista 3 meseros + la caja');
  const filaCaja = filasMeseros.find(r => text(r).includes('Caja Principal'));
  assert(!!filaCaja && !filaCaja.querySelector('[data-action="mesero-toggle-estado"]'), 'caja no puede desactivarse a sí misma desde la tabla');
  assert(!!filaCaja && !!filaCaja.querySelector('[data-action="mesero-resetear-pin"]'), 'caja puede restablecer su propio PIN');

  await clickAction('mesero-crear-abrir');
  setVal('#mesero-nombre-input', 'Camila Restrepo');
  setVal('#mesero-usuario-input', 'camila');
  await clickAction('mesero-crear-guardar');
  const pinCamila = text(q('#pin-nuevo-valor'));
  assert(/^\d{4}$/.test(pinCamila), 'al crear el mesero se muestra su PIN en una ventana: ' + pinCamila);
  assert(backend.log.rpc.some(r => r.fn === 'admin_crear_mesero' && r.cliente === 'admin'), 'el mesero se crea con rpc(admin_crear_mesero) desde la sesión de caja');
  await clickAction('pin-nuevo-cerrar');
  assert(!q('#pin-nuevo-valor'), 'la ventana del PIN se cierra y el PIN ya no está en pantalla');
  assert(qa('table.data-table tbody tr').length === 5, 'el nuevo mesero aparece en la tabla');

  await clickAction('mesero-resetear-pin', 'u-pablo');
  const pinNuevoPablo = text(q('#pin-nuevo-valor'));
  assert(/^\d{4}$/.test(pinNuevoPablo), 'restablecer muestra un PIN nuevo para pablo');
  await clickAction('pin-nuevo-cerrar');

  // ============================================================
  // 9) Cerrar sesión del mesero y volver a entrar con el PIN nuevo
  // ============================================================
  await clickAction('switch-vista', 'mesero');
  await clickAction('mesero-tab', 'perfil');
  await clickAction('mesero-logout');
  assert(!!q('#vista-mesero .login-wrap'), 'tras cerrar sesión vuelve el login del mesero');
  assert(!backend.almacen['latinsoft-sesion-mesero'], 'cerrar sesión borra la sesión de Supabase del mesero');
  assert(!!backend.almacen['latinsoft-sesion-admin'], 'la sesión de caja no se ve afectada');
  assert(qa('#vista-mesero .user-chip').length === 4, 'Camila ya aparece entre los meseros para ingresar');

  await clickAction('login-usuario-select', 'u-pablo');
  if (pinNuevoPablo !== PINES['u-pablo']) {
    await teclearPin('', PINES['u-pablo']);
    assert(!!q('#vista-mesero .pin-error'), 'el PIN anterior de pablo dejó de funcionar');
  }
  await teclearPin('', pinNuevoPablo);
  assert(!!q('.mesas-grid'), 'pablo entra con su PIN nuevo');

  // ============================================================
  // 10) Desactivar a un mesero con sesión abierta lo saca
  // ============================================================
  await clickAction('switch-vista', 'admin');
  await clickAction('admin-nav', 'meseros');
  await clickAction('mesero-toggle-estado', 'u-pablo');
  await clickAction('switch-vista', 'mesero');
  assert(!!q('#vista-mesero .login-wrap'), 'el mesero desactivado vuelve a la pantalla de login');
  assert(!backend.almacen['latinsoft-sesion-mesero'], 'y su sesión se cerró');
  await clickAction('switch-vista', 'admin');
  await clickAction('mesero-toggle-estado', 'u-pablo'); // reactivarlo
  assert(backend.db.meseros.find(m => m.id === 'u-pablo').estado === 'activo', 'pablo se puede reactivar');

  // ============================================================
  // 11) Ventas del día
  // ============================================================
  await clickAction('admin-nav', 'ventas');
  const statCards = qa('.stat-card');
  assert(statCards.some(c => text(c).includes('3') && text(c).includes('Pedidos cobrados')), 'Ventas cuenta 3 pedidos cobrados — ' + statCards.map(text).join(' | '));
  const totalEsperado = 26400 + 61600 + 35200;
  assert(statCards.some(c => text(c).replace(/[.,]/g, '').includes(String(totalEsperado))), 'el total vendido es 123.200 — ' + statCards.map(text).join(' | '));

  dom.window.close();

  // ============================================================
  // 12) Recargar la página: la sesión la decide Supabase Auth, no localStorage
  // ============================================================
  const dom2 = abrirPagina(backend, function (w) {
    // alguien intenta "entrar" escribiendo en localStorage
    w.localStorage.setItem('latinsoft_pedidos_ui_v1', JSON.stringify({ vista: 'mesero', mesero: { logueado: 'u-laura', pantalla: 'mesas' }, admin: { logueado: 'u-caja', pantalla: 'dashboard' } }));
  });
  usar(dom2);
  await esperar(20);
  assert(!!q('#vista-mesero .login-wrap'), 'editar localStorage no inicia sesión de mesero (sin sesión de Auth)');
  await clickAction('switch-vista', 'admin');
  assert(!!q('.admin-shell'), 'caja sigue dentro tras recargar: su sesión de Supabase se restauró');
  await clickAction('admin-logout');
  assert(!!q('#vista-admin .login-wrap'), 'cerrar sesión de caja vuelve al login');
  assert(!backend.almacen['latinsoft-sesion-admin'], 'y borra su sesión');
  assert(!q('.kcard') && !document.body.innerHTML.includes(idPedidoMesa1), 'sin sesiones, los datos del restaurante ya no están en la página');
  dom2.window.close();

  console.log('\n--- Errores de consola/jsdom capturados: ' + errors.length + ' ---');
  errors.forEach(function (e) { console.error(e && e.message ? e.message : e); });
  console.log('\n' + pass + ' aserciones pasaron, ' + fail + ' fallaron.');
  process.exit((fail > 0 || errors.length > 0) ? 1 : 0);
})().catch(function (e) { console.error(e); process.exit(1); });
