const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '..', 'app.html'), 'utf-8');

let pass = 0, fail = 0;
const failures = [];
function assert(cond, msg) {
  if (cond) { pass++; }
  else { fail++; failures.push(msg); console.error('FALLÓ:', msg); }
}

const errors = [];
const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  resources: undefined, // no cargar hojas de estilo/fuentes externas
  url: 'https://example.org/latinsoft-pedidos',
  pretendToBeVisual: true,
  virtualConsole: (function(){
    const { VirtualConsole } = require('jsdom');
    const vc = new VirtualConsole();
    vc.on('jsdomError', function(e){ errors.push(e); });
    vc.on('error', function(e){ errors.push(e); });
    return vc;
  })(),
});

const { window } = dom;
const document = window.document;

function q(sel) { return document.querySelector(sel); }
function qa(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
function clickAction(action, arg) {
  const sel = arg != null
    ? '[data-action="' + action + '"][data-arg="' + String(arg).replace(/"/g,'\\"') + '"]'
    : '[data-action="' + action + '"]';
  const el = q(sel);
  assert(!!el, 'existe el elemento clicable para acción=' + action + ' arg=' + arg);
  if (el) el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  return el;
}
function setVal(sel, val) {
  const el = q(sel);
  assert(!!el, 'existe el input ' + sel);
  if (!el) return;
  el.value = val;
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
  el.dispatchEvent(new window.Event('change', { bubbles: true }));
}
function text(el) { return el ? el.textContent.replace(/\s+/g, ' ').trim() : ''; }

// ---------- esperar a que el script arranque ----------
assert(typeof window.document.getElementById('app-topbar') !== 'undefined', 'el DOM inicial existe');

// ============================================================
// 1) Pantalla de login visible al inicio
// ============================================================
assert(!!q('.login-wrap'), 'se muestra la pantalla de login al cargar');
assert(qa('.user-chip').length === 3, 'aparecen los 3 meseros activos como opciones de login');

// login incorrecto: PIN equivocado
clickAction('login-usuario-select', 'u-pablo');
['9','9','9','9'].forEach(d => clickAction('login-pin-digit', d));
assert(!!q('.pin-error'), 'muestra error con PIN incorrecto');
assert(text(q('.pin-error')).toLowerCase().includes('incorrecto'), 'el mensaje de error menciona PIN incorrecto');

// login correcto
clickAction('login-usuario-select', 'u-pablo');
['1','2','3','4'].forEach(d => clickAction('login-pin-digit', d));
assert(!q('.login-wrap'), 'tras login correcto ya no se muestra la pantalla de login');
assert(!!q('.mesas-grid'), 'tras login se muestra el mapa de mesas');
assert(qa('.mesa-circ').length === 15, 'se muestran las 15 mesas');

// ============================================================
// 2) Flujo feliz: Mesa 1 disponible -> escanear -> enviar
// ============================================================
const mesa1Btn = q('[data-action="mesa-tap"][data-arg="mesa-1"]');
assert(!!mesa1Btn && text(mesa1Btn).includes('Disponible'), 'Mesa 1 arranca disponible');
clickAction('mesa-tap', 'mesa-1');
assert(!!q('.carrito-empty'), 'el carrito de la Mesa 1 arranca vacío');

clickAction('abrir-scanner');
assert(!!q('.scanner-ov'), 'se abre el overlay del escáner');
assert(qa('.scan-card').length === 12, 'se listan los 12 productos del catálogo en el escáner');

clickAction('scan-producto', 'p-hamb-esp');
clickAction('scan-producto', 'p-hamb-esp');
clickAction('cerrar-scanner');
assert(!q('.scanner-ov'), 'el escáner se cierra');
assert(!!q('.cart-item'), 'el carrito muestra el producto escaneado');
assert(text(q('.qty-val')) === '2', 'la segunda lectura sumó una unidad (cantidad = 2)');
assert(text(q('.cart-total')).includes('56.000') || text(q('.cart-total')).includes('56,000'), 'el subtotal del carrito es 2 x $28.000 = $56.000 — DOM: ' + text(q('.cart-total')));

// agregar observación a la primera línea
clickAction('carrito-obs-abrir', '0');
assert(!!q('#obs-texto-input'), 'se abre el modal de observación');
clickAction('carrito-obs-chip', '0|sin cebolla');
clickAction('carrito-obs-guardar', '0');
assert(text(q('.cart-item-obs')).includes('sin cebolla'), 'la observación "sin cebolla" quedó guardada en el ítem');

// enviar pedido
clickAction('enviar-pedido-confirmar-abrir');
assert(!!q('.m-modal h3'), 'se muestra el modal de confirmación de envío');
clickAction('enviar-pedido-confirmar-si');
assert(!!q('.confirm-wrap'), 'se muestra la pantalla de confirmación tras enviar');
assert(text(q('.confirm-wrap h2')).includes('enviado correctamente'), 'el mensaje de confirmación es correcto');

const idPedidoMesa1 = (function(){
  const m = text(q('.confirm-wrap h2')).match(/PED\d+/);
  return m ? m[0] : null;
})();
assert(!!idPedidoMesa1, 'se pudo extraer el ID del pedido recién enviado: ' + idPedidoMesa1);

clickAction('confirmacion-volver-mesas');
assert(!!q('.mesas-grid'), 'tras confirmar, se vuelve al mapa de mesas');
const mesa1Despues = q('[data-action="mesa-tap"][data-arg="mesa-1"]');
assert(text(mesa1Despues).includes('Pedido enviado'), 'la Mesa 1 ahora figura como "Pedido enviado"');

// ============================================================
// 3) Cambiar a Administración: el pedido debe aparecer en Nuevo
// ============================================================
clickAction('switch-vista', 'admin');
assert(!q('#vista-admin').classList.contains('hidden'), 'la vista de administración queda visible');
assert(q('#vista-mesero').classList.contains('hidden'), 'la vista de mesero queda oculta');

const kcardMesa1 = qa('.kcard').find(c => text(c).includes('Mesa 1') && text(c).includes(idPedidoMesa1));
assert(!!kcardMesa1, 'el pedido de la Mesa 1 aparece como tarjeta en el kanban');
assert(text(kcardMesa1).includes('Pablo Pérez'), 'la tarjeta identifica al mesero correcto (Pablo Pérez)');
assert(text(kcardMesa1).includes('sin cebolla'), 'la observación se refleja en la tarjeta de cocina');

const avanzarBtn = kcardMesa1.querySelector('[data-action="ronda-avanzar"]');
assert(!!avanzarBtn, 'la tarjeta Nuevo tiene botón para avanzar de estado');
const idRondaMesa1 = avanzarBtn.getAttribute('data-arg').split(',')[1];

// avanzar nuevo -> aceptado -> preparando -> listo -> entregado
['aceptado','preparando','listo','entregado'].forEach(function(esperado){
  const btn = q('[data-action="ronda-avanzar"][data-arg="' + idPedidoMesa1 + ',' + idRondaMesa1 + '"]');
  assert(!!btn, 'existe botón para avanzar a ' + esperado);
  if (btn) btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
});
const kcardFinal = qa('.kcard').find(c => text(c).includes(idPedidoMesa1));
assert(!!kcardFinal, 'la tarjeta sigue existiendo tras llegar a Entregado');
assert(!q('[data-action="ronda-avanzar"][data-arg="' + idPedidoMesa1 + ',' + idRondaMesa1 + '"]'), 'ya no hay botón de avanzar: Entregado es el último estado');

// ============================================================
// 4) El mesero pide la cuenta y el admin la factura y cobra
// ============================================================
clickAction('switch-vista', 'mesero');
clickAction('mesa-tap', 'mesa-1');
assert(!!q('[data-action="pedir-cuenta"]'), 'el botón "Pedir cuenta" está disponible tras la ronda enviada');
clickAction('pedir-cuenta');

clickAction('switch-vista', 'admin');
const kcardConCuenta = qa('.kcard').find(c => text(c).includes(idPedidoMesa1));
assert(text(kcardConCuenta).includes('Pidió la cuenta'), 'la tarjeta muestra la bandera "Pidió la cuenta"');
const facturarBtn = kcardConCuenta.querySelector('[data-action="ir-facturar"]');
assert(!!facturarBtn, 'hay botón Facturar en la tarjeta con cuenta solicitada');
facturarBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

assert(q('.admin-topline h2') && text(q('.admin-topline h2')) === 'Facturación', 'navegó a la pantalla de Facturación');
assert(text(q('.total-line.grand')).includes('61.600') || text(q('.total-line.grand')).includes('61,600'), 'el total facturado es 56.000 + 10% servicio = 61.600 — DOM: ' + text(q('.total-line.grand')));

clickAction('facturacion-forma-pago', 'efectivo');
setVal('#recibido-input', '70000');
assert(text(q('#cambio-calc')).includes('8.400') || text(q('#cambio-calc')).includes('8,400'), 'el cambio calculado es correcto (70.000 - 61.600 = 8.400) — DOM: ' + text(q('#cambio-calc')));

const cobrarBtn = q('[data-action="facturacion-cobrar"]');
assert(!!cobrarBtn && !cobrarBtn.hasAttribute('disabled'), 'el botón Cobrar e imprimir está habilitado para pago en efectivo');
clickAction('facturacion-cobrar');
assert(!!q('.comprobante-paper'), 'se muestra el comprobante tras cobrar');
assert(text(q('.comprobante-paper')).includes('Cambio'), 'el comprobante incluye el cambio');
clickAction('comprobante-cerrar');

clickAction('admin-nav', 'mesas');
const mesaAdmin1 = q('[data-action="admin-mesa-tap"][data-arg="mesa-1"]');
assert(text(mesaAdmin1).includes('Disponible'), 'la Mesa 1 vuelve a figurar disponible tras el cobro');

// ============================================================
// 5) Pago mixto en otra mesa (Mesa 3)
// ============================================================
clickAction('switch-vista', 'mesero');
clickAction('mesero-tab', 'mesas');
clickAction('mesa-tap', 'mesa-3');
clickAction('abrir-scanner');
clickAction('scan-producto', 'p-plato-paisa'); // 32.000
clickAction('cerrar-scanner');
clickAction('enviar-pedido-confirmar-abrir');
clickAction('enviar-pedido-confirmar-si');
clickAction('confirmacion-volver-mesas');

clickAction('switch-vista', 'admin');
clickAction('admin-nav', 'dashboard');
const kcardMesa3 = qa('.kcard').find(c => text(c).includes('Mesa 3'));
assert(!!kcardMesa3, 'aparece la tarjeta de la Mesa 3');
const idPedidoMesa3 = text(kcardMesa3).match(/PED\d+/)[0];
const idRondaMesa3 = kcardMesa3.querySelector('[data-action="ronda-avanzar"]').getAttribute('data-arg').split(',')[1];

clickAction('admin-nav', 'mesas');
clickAction('admin-mesa-tap', 'mesa-3');
const facturarDesdePanel = q('[data-action="ir-facturar"][data-arg="mesa-3"]');
assert(!!facturarDesdePanel, 'el panel de la mesa permite ir a facturar aunque la ronda siga en Nuevo');
clickAction('ir-facturar', 'mesa-3');

assert(text(q('.total-line.grand')).includes('35.200') || text(q('.total-line.grand')).includes('35,200'), 'total Mesa 3 = 32.000 + 10% = 35.200 — DOM: ' + text(q('.total-line.grand')));
clickAction('facturacion-forma-pago', 'mixto');
setVal('#mixto-monto-input', '20000');
clickAction('facturacion-agregar-pago');
const cobrarMixtoBtn1 = q('[data-action="facturacion-cobrar"]');
assert(!!cobrarMixtoBtn1 && cobrarMixtoBtn1.hasAttribute('disabled'), 'Cobrar sigue deshabilitado con pago parcial (20.000 de 35.200)');
setVal('#mixto-monto-input', '15200');
clickAction('facturacion-agregar-pago');
const cobrarMixtoBtn2 = q('[data-action="facturacion-cobrar"]');
assert(!!cobrarMixtoBtn2 && !cobrarMixtoBtn2.hasAttribute('disabled'), 'Cobrar se habilita cuando la suma de pagos (20.000+15.200) iguala el total');
clickAction('facturacion-cobrar');
assert(!!q('.comprobante-paper'), 'se cobra correctamente con pago mixto y se muestra el comprobante');
clickAction('comprobante-cerrar');

// ============================================================
// 6) Anulación: solo permitida en nuevo/aceptado
// ============================================================
clickAction('switch-vista', 'mesero');
clickAction('mesero-tab', 'mesas');
clickAction('mesa-tap', 'mesa-4');
clickAction('abrir-scanner');
clickAction('scan-producto', 'p-gaseosa');
clickAction('cerrar-scanner');
clickAction('enviar-pedido-confirmar-abrir');
clickAction('enviar-pedido-confirmar-si');
clickAction('confirmacion-volver-mesas');

clickAction('switch-vista', 'admin');
clickAction('admin-nav', 'dashboard');
const kcardMesa4 = qa('.kcard').find(c => text(c).includes('Mesa 4'));
const idPedidoMesa4 = text(kcardMesa4).match(/PED\d+/)[0];
const idRondaMesa4 = kcardMesa4.querySelector('[data-action="ronda-detalle-abrir"]').getAttribute('data-arg').split(',')[1];
clickAction('ronda-detalle-abrir', idPedidoMesa4 + ',' + idRondaMesa4);
assert(!!q('[data-action="ronda-anular-abrir"]'), 'se puede anular una ronda en estado Nuevo');
clickAction('ronda-anular-abrir', idPedidoMesa4 + ',' + idRondaMesa4);
setVal('#anular-motivo-input', 'Cliente se retractó (prueba automática)');
clickAction('ronda-anular-confirmar');
assert(!qa('.kcard').some(c => text(c).includes(idPedidoMesa4)), 'la ronda anulada desaparece del kanban');

// ============================================================
// 7) Mis pedidos del mesero y marcar entregado
// ============================================================
clickAction('switch-vista', 'mesero');
clickAction('mesero-tab', 'pedidos');
assert(!!q('.mp-item, .empty-state'), 'la pantalla "Mis pedidos" renderiza sin errores');

// ============================================================
// 8) Producto inactivo no se puede escanear
// ============================================================
clickAction('switch-vista', 'admin');
clickAction('admin-nav', 'productos');
assert(qa('table.data-table tbody tr').length === 12, 'la tabla de productos lista 12 productos');
const toggleCerveza = q('[data-action="producto-toggle-estado"][data-arg="p-cerveza"]');
assert(!!toggleCerveza, 'existe el botón para desactivar la Cerveza Nacional');
clickAction('producto-toggle-estado', 'p-cerveza');

clickAction('switch-vista', 'mesero');
clickAction('mesero-tab', 'mesas');
clickAction('mesa-tap', 'mesa-6');
clickAction('abrir-scanner');
const cardCerveza = qa('.scan-card').find(c => text(c).includes('Cerveza'));
assert(!!cardCerveza && cardCerveza.hasAttribute('disabled'), 'la Cerveza Nacional aparece deshabilitada en el escáner tras desactivarla');
clickAction('cerrar-scanner');

// ============================================================
// 9) Crear producto nuevo y usarlo
// ============================================================
clickAction('switch-vista', 'admin');
clickAction('admin-nav', 'productos');
clickAction('producto-crear-abrir');
setVal('#prod-nombre-input', 'Chuzo de Pollo');
setVal('#prod-precio-input', '21000');
clickAction('producto-crear-guardar');
assert(qa('table.data-table tbody tr').length === 13, 'el nuevo producto aparece en la tabla (13 filas)');
assert(qa('table.data-table tbody tr').some(r => text(r).includes('Chuzo de Pollo')), 'el producto creado tiene el nombre correcto');

// ============================================================
// 10) Crear mesero
// ============================================================
clickAction('admin-nav', 'meseros');
assert(qa('table.data-table tbody tr').length === 3, 'la tabla de meseros lista 3 meseros');
clickAction('mesero-crear-abrir');
setVal('#mesero-nombre-input', 'Camila Restrepo');
setVal('#mesero-usuario-input', 'camila');
clickAction('mesero-crear-guardar');
assert(qa('table.data-table tbody tr').length === 4, 'el nuevo mesero aparece en la tabla (4 filas)');

// ============================================================
// 11) Ventas del día refleja los dos pedidos cobrados
// ============================================================
clickAction('admin-nav', 'ventas');
assert(text(q('.admin-topline')).includes('Ventas del día'), 'se muestra la pantalla de Ventas del día');
const statCards = qa('.stat-card');
// la demo ya trae un pedido histórico pagado sembrado (Mesa 9, PED124 = 26.400),
// más los dos que cobramos en esta prueba (Mesa 1 = 61.600, Mesa 3 = 35.200) = 3 en total
assert(statCards.some(c => text(c).includes('3') && text(c).includes('Pedidos cobrados')), 'Ventas del día contabiliza 3 pedidos cobrados (histórico + Mesa 1 + Mesa 3) — stats: ' + statCards.map(text).join(' | '));
const totalEsperado = 26400 + 61600 + 35200; // 123.200
assert(statCards.some(c => text(c).replace(/\./g,'').replace(/,/g,'').includes(String(totalEsperado)) ), 'el total vendido del día es 96.800 — stats: ' + statCards.map(text).join(' | '));

// ============================================================
// 12) Reiniciar demo deja todo como al principio
// ============================================================
clickAction('reiniciar-demo');
clickAction('switch-vista', 'mesero');
assert(!!q('.login-wrap'), 'tras reiniciar la demo, vuelve a mostrarse el login (sesión cerrada)');

// ============================================================
// Resumen + errores de consola capturados por jsdom
// ============================================================
console.log('\n--- Errores de consola/jsdom capturados: ' + errors.length + ' ---');
errors.forEach(function(e){ console.error(e && e.message ? e.message : e); });

console.log('\n' + pass + ' aserciones pasaron, ' + fail + ' fallaron.');
process.exit((fail > 0 || errors.length > 0) ? 1 : 0);
