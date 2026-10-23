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
  // 2) Flujo feliz: Mesa 1 -> menú táctil -> carrito -> enviar
  // ============================================================
  assert(!html.includes('zxing') && !html.includes('getUserMedia') && !html.includes('BarcodeDetector'), 'la app ya no carga lector de códigos ni pide la cámara');
  const mesa1Btn = q('[data-action="mesa-tap"][data-arg="mesa-1"]');
  assert(!!mesa1Btn && text(mesa1Btn).includes('Disponible'), 'Mesa 1 arranca disponible');
  await clickAction('mesa-tap', 'mesa-1');
  assert(!!q('.menu-ov'), 'una mesa libre abre directo el menú táctil');
  assert(qa('.menu-card').length === 12, 'el menú muestra los 12 productos como cuadros');
  const cardHamb = () => q('.menu-card[data-producto="p-hamb-esp"]');
  const imgHamb = cardHamb().querySelector('img.menu-img');
  assert(!!imgHamb && imgHamb.getAttribute('src') === fake.URL_PUBLICA + 'rest-fogon/p-hamb-esp-1.jpg', 'el producto con foto muestra su imagen');
  assert(!!q('.menu-card[data-producto="p-papas"] .menu-img.sin-foto'), 'un producto sin foto muestra sus iniciales');
  assert(text(cardHamb()).includes('Hamburguesa Especial') && mismoTexto(cardHamb(), '28.000', '28,000'), 'el cuadro muestra nombre y precio');
  assert(text(cardHamb().querySelector('.qty-val')) === '0' && cardHamb().querySelector('[data-action="menu-menos"]').hasAttribute('disabled'), 'arranca en 0 y sin poder restar');

  await clickEl(cardHamb().querySelector('.menu-card-foto')); // tocar la foto suma uno
  await clickEl(cardHamb().querySelector('.menu-qty [data-action="menu-mas"]')); // y el "+" otro
  assert(text(cardHamb().querySelector('.qty-val')) === '2', 'tocar la foto y el + suma 2 unidades');
  assert(text(cardHamb().querySelector('.menu-badge')) === '2' && cardHamb().classList.contains('en-carrito'), 'el cuadro marca que ya está en el carrito');
  assert(text(q('#menu-ir-carrito')).includes('(2)') && mismoTexto(q('#menu-ir-carrito'), '56.000', '56,000'), 'el botón Ir al carrito muestra cantidad y total — ' + text(q('#menu-ir-carrito')));

  await clickAction('menu-mas', 'p-papas');
  await clickAction('menu-menos', 'p-papas');
  assert(text(q('.menu-card[data-producto="p-papas"] .qty-val')) === '0', 'el – resta la unidad agregada');
  assert(text(q('#menu-ir-carrito')).includes('(2)'), 'restar actualiza el total del carrito');

  await clickAction('menu-categoria', 'cat-bebidas');
  assert(qa('.menu-card').length === 4 && qa('.menu-cat').length === 1 && text(q('.menu-cat')).toLowerCase() === 'bebidas', 'el filtro de categoría muestra solo las 4 bebidas');
  await clickAction('menu-categoria', 'todas');
  const buscador = q('#menu-buscar-input');
  buscador.value = 'paisa';
  buscador.dispatchEvent(new window.Event('input', { bubbles: true }));
  await esperar();
  assert(qa('.menu-card').length === 2, 'buscar "paisa" deja 2 productos — ' + qa('.menu-card').length);
  assert(document.activeElement && document.activeElement.id === 'menu-buscar-input', 'el buscador no pierde el foco al filtrar');
  q('#menu-buscar-input').value = 'xyz';
  q('#menu-buscar-input').dispatchEvent(new window.Event('input', { bubbles: true }));
  await esperar();
  assert(!!q('.menu-vacio'), 'una búsqueda sin resultados lo indica');
  q('#menu-buscar-input').value = '';
  q('#menu-buscar-input').dispatchEvent(new window.Event('input', { bubbles: true }));
  await esperar();

  await clickAction('menu-ir-carrito');
  assert(!q('.menu-ov'), 'Ir al carrito cierra el menú');
  assert(qa('.cart-item').length === 1, 'el carrito tiene la hamburguesa (las papas se quitaron)');
  assert(text(q('.qty-val')) === '2', 'con cantidad 2');
  assert(mismoTexto(q('.cart-total'), '56.000', '56,000'), 'el subtotal del carrito es $56.000 — DOM: ' + text(q('.cart-total')));
  await clickAction('abrir-menu');
  assert(!!q('.menu-ov') && text(cardHamb().querySelector('.qty-val')) === '2', 'desde el carrito se vuelve al menú y conserva las cantidades');
  await clickAction('cerrar-menu');

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
  await clickAction('menu-mas', 'p-plato-paisa');
  await clickAction('menu-ir-carrito');
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
  await clickAction('menu-mas', 'p-gaseosa');
  await clickAction('menu-ir-carrito');
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

  // --- fotos de productos ---
  function elegirArchivo(input, archivo) {
    Object.defineProperty(input, 'files', { value: [archivo], configurable: true });
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
  }
  const pngFalso = (nombre) => new window.File([new Uint8Array(2048)], nombre || 'foto.png', { type: 'image/png' });
  assert(!q('[data-action="productos-imprimir-codigos"]'), 'ya no está el botón de imprimir códigos de barras');
  const inputSencilla = q('input[data-subir-imagen="p-hamb-sen"]');
  assert(!!inputSencilla, 'cada producto tiene botón para subir foto');
  elegirArchivo(inputSencilla, pngFalso());
  await esperar(30);
  const rutasSencilla = () => Object.keys(backend.archivos).filter(r => r.indexOf('rest-fogon/p-hamb-sen-') === 0);
  assert(rutasSencilla().length === 1, 'la foto se subió a la carpeta del restaurante — ' + JSON.stringify(Object.keys(backend.archivos)));
  const prodSencilla = () => backend.db.productos.find(x => x.id === 'p-hamb-sen');
  assert(prodSencilla().imagen_url === fake.URL_PUBLICA + rutasSencilla()[0], 'el producto quedó con la URL de su foto');
  assert(backend.logStorage.filter(l => l.op === 'upload').every(l => l.cliente === 'admin'), 'las fotos se suben con la sesión de caja');
  const filaSencilla = () => qa('table.data-table tbody tr').find(r => text(r).includes('Hamburguesa Sencilla'));
  assert(!!filaSencilla().querySelector('img.prod-thumb'), 'la tabla muestra la miniatura de la foto');

  const rutaVieja = rutasSencilla()[0];
  await new Promise(r => setTimeout(r, 5)); // otro milisegundo => otro nombre de archivo
  elegirArchivo(q('input[data-subir-imagen="p-hamb-sen"]'), pngFalso('nueva.png'));
  await esperar(30);
  assert(rutasSencilla().length === 1 && rutasSencilla()[0] !== rutaVieja, 'cambiar la foto reemplaza el archivo y borra el anterior');

  const archivosAntes = Object.keys(backend.archivos).length;
  elegirArchivo(q('input[data-subir-imagen="p-ensalada"]'), new window.File(['%PDF'], 'menu.pdf', { type: 'application/pdf' }));
  await esperar(30);
  assert(Object.keys(backend.archivos).length === archivosAntes && !backend.db.productos.find(x => x.id === 'p-ensalada').imagen_url, 'un archivo que no es imagen se rechaza');
  assert(qa('.toast').some(t => text(t).includes('JPG, PNG o WebP')), 'y se explica por qué');
  elegirArchivo(q('input[data-subir-imagen="p-ensalada"]'), new window.File([new Uint8Array(3 * 1024 * 1024)], 'grande.png', { type: 'image/png' }));
  await esperar(30);
  assert(!backend.db.productos.find(x => x.id === 'p-ensalada').imagen_url, 'una imagen de más de 2 MB que no se puede reducir se rechaza');

  await clickEl(filaSencilla().querySelector('[data-action="producto-quitar-imagen"]'));
  assert(prodSencilla().imagen_url === null && rutasSencilla().length === 0, 'Quitar borra la foto del producto y del almacenamiento');

  await clickAction('producto-crear-abrir');
  setVal('#prod-nombre-input', 'Bandeja Paisa');
  setVal('#prod-precio-input', '35000');
  Object.defineProperty(q('#prod-imagen-input'), 'files', { value: [pngFalso('bandeja.png')], configurable: true });
  await clickAction('producto-crear-guardar');
  await esperar(30);
  const bandeja = backend.db.productos.find(x => x.nombre === 'Bandeja Paisa');
  assert(!!bandeja && !!bandeja.imagen_url && bandeja.imagen_url.indexOf(fake.URL_PUBLICA + 'rest-fogon/' + bandeja.id + '-') === 0, 'al crear un producto se puede subir su foto de una vez');

  // y el mesero la ve en el menú
  elegirArchivo(q('input[data-subir-imagen="p-hamb-sen"]'), pngFalso('otra.png'));
  await esperar(30);

  await clickAction('switch-vista', 'mesero');
  await clickAction('mesero-tab', 'mesas');
  await clickAction('mesa-tap', 'mesa-6');
  const imgSencillaMenu = q('.menu-card[data-producto="p-hamb-sen"] img.menu-img');
  assert(!!imgSencillaMenu && imgSencillaMenu.getAttribute('src') === backend.db.productos.find(x => x.id === 'p-hamb-sen').imagen_url, 'el mesero ve en el menú la foto que subió caja');
  assert(!!q('.menu-card[data-producto="' + bandeja.id + '"] img.menu-img'), 'y el producto nuevo con su foto');
  const cardCerveza = q('.menu-card[data-producto="p-cerveza"]');
  assert(!!cardCerveza && cardCerveza.classList.contains('inactivo') && text(cardCerveza).includes('No disponible'), 'la Cerveza aparece como no disponible en el menú');
  assert(cardCerveza.querySelector('.menu-qty [data-action="menu-mas"]').hasAttribute('disabled') && cardCerveza.querySelector('.menu-card-foto').hasAttribute('disabled'), 'y no se puede agregar');
  await clickAction('cerrar-menu');

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
  // 10b) Cambio de mesa
  // ============================================================
  // pablo (reactivado) vuelve a entrar y abre un pedido en la Mesa 7 con un pago parcial
  await clickAction('switch-vista', 'mesero');
  await clickAction('login-usuario-select', 'u-pablo');
  await teclearPin('', pinNuevoPablo);
  await clickAction('mesa-tap', 'mesa-7');
  await clickAction('menu-mas', 'p-limonada');
  await clickAction('menu-ir-carrito');
  await clickAction('enviar-pedido-confirmar-abrir');
  await clickAction('enviar-pedido-confirmar-si');
  await clickAction('confirmacion-nuevo-pedido');
  const idPedidoMesa7 = backend.db.mesas.find(x => x.id === 'mesa-7').pedido_activo_id;
  assert(!!idPedidoMesa7, 'la Mesa 7 quedó con pedido abierto');
  backend.db.pagos.push({ id: 900, pedido_id: idPedidoMesa7, forma_pago: 'efectivo', valor: 5000, recibido: null, hora: new Date().toISOString() });
  // y deja algo sin enviar en el carrito de esa mesa
  await clickAction('abrir-menu');
  await clickAction('menu-mas', 'p-arepa');
  await clickAction('menu-ir-carrito');

  await clickAction('cambio-mesa-abrir');
  assert(!!q('.mesa-elegir-grid'), 'se abre la ventana para elegir mesa');
  const ofrecidas = qa('[data-action="cambio-mesa-elegir"]').map(b => b.getAttribute('data-arg'));
  assert(ofrecidas.indexOf('mesa-7') === -1 && ofrecidas.indexOf('mesa-4') === -1, 'no ofrece la misma mesa ni mesas ocupadas — ' + ofrecidas.join(','));
  assert(ofrecidas.indexOf('mesa-8') !== -1, 'ofrece mesas libres');
  assert(q('[data-action="cambio-mesa-confirmar"]').hasAttribute('disabled'), 'no se puede confirmar sin elegir mesa');

  // otra persona ocupa la Mesa 8 justo antes de confirmar: el servidor lo rechaza
  await clickAction('cambio-mesa-elegir', 'mesa-8');
  assert(text(q('[data-action="cambio-mesa-confirmar"]')).includes('Mesa 8'), 'el botón dice a qué mesa se mueve');
  backend.db.mesas.find(x => x.id === 'mesa-8').pedido_activo_id = idPedidoMesa4;
  await clickAction('cambio-mesa-confirmar');
  assert(qa('.toast').some(t => text(t).includes('se acaba de ocupar')), 'si el destino se ocupó, avisa y deja elegir otra');
  assert(backend.db.mesas.find(x => x.id === 'mesa-7').pedido_activo_id === idPedidoMesa7, 'y no movió nada');
  assert(!!q('.mesa-elegir-grid') && qa('[data-action="cambio-mesa-elegir"]').every(b => b.getAttribute('data-arg') !== 'mesa-8'), 'la Mesa 8 ya no aparece como libre');
  backend.db.mesas.find(x => x.id === 'mesa-8').pedido_activo_id = null;

  await clickAction('cambio-mesa-elegir', 'mesa-12');
  await clickAction('cambio-mesa-confirmar');
  assert(backend.db.mesas.find(x => x.id === 'mesa-7').pedido_activo_id === null, 'la Mesa 7 queda libre');
  assert(backend.db.mesas.find(x => x.id === 'mesa-12').pedido_activo_id === idPedidoMesa7, 'la Mesa 12 queda con el pedido');
  assert(backend.db.pedidos.find(x => x.id === idPedidoMesa7).mesa_id === 'mesa-12', 'el pedido apunta a la Mesa 12');
  assert(backend.db.pagos.filter(x => x.pedido_id === idPedidoMesa7).length === 1, 'los pagos siguen con el pedido');
  assert(text(q('.pedido-topbar h2')) === 'Mesa 12', 'el mesero queda en la Mesa 12');
  assert(qa('.cart-item').some(c => text(c).includes('Arepa')), 'el carrito sin enviar se mudó con la mesa');
  assert(qa('.ronda-prev').length === 1 && text(q('.ronda-prev')).includes('Limonada'), 'las rondas enviadas se ven en la mesa nueva');
  assert(backend.log.rpc.some(r => r.fn === 'cambiar_mesa' && r.cliente === 'mesero'), 'el cambio lo hizo el servidor con la sesión del mesero');
  await clickAction('volver-mesas');
  assert(text(q('[data-action="mesa-tap"][data-arg="mesa-7"]')).includes('Disponible'), 'en el mapa la Mesa 7 aparece disponible');

  // caja también puede cambiar de mesa, y facturación sigue a la mesa nueva
  await clickAction('switch-vista', 'admin');
  await clickAction('admin-nav', 'mesas');
  await clickAction('admin-mesa-tap', 'mesa-12');
  await clickAction('admin-cambio-mesa-abrir', 'mesa-12');
  await clickAction('admin-cambio-mesa-elegir', 'mesa-15');
  await clickAction('admin-cambio-mesa-confirmar');
  assert(backend.db.pedidos.find(x => x.id === idPedidoMesa7).mesa_id === 'mesa-15' && backend.db.mesas.find(x => x.id === 'mesa-12').pedido_activo_id === null, 'caja movió el pedido a la Mesa 15');
  assert(text(q('[data-action="admin-mesa-tap"][data-arg="mesa-15"]')).includes('Pedido enviado'), 'el mapa de caja refleja el cambio');
  await clickAction('admin-mesa-tap', 'mesa-15');
  await clickAction('ir-facturar', 'mesa-15');
  assert(mismoTexto(q('.total-line.grand'), '9.350', '9,350'), 'la cuenta (limonada 8.500 + 10%) se factura en la Mesa 15 — ' + text(q('.total-line.grand')));
  await clickAction('admin-nav', 'dashboard');
  assert(qa('.kcard').some(c => text(c).includes(idPedidoMesa7) && text(c).includes('Mesa 15')), 'el kanban muestra el pedido en la Mesa 15');
  await clickAction('switch-vista', 'mesero');
  await clickAction('mesero-tab', 'perfil');
  await clickAction('mesero-logout');
  await clickAction('switch-vista', 'admin');

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
