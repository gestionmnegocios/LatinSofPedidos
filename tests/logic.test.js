const L = require('../src/logic.js');

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; }
  else { fail++; console.error('FALLÓ:', msg); }
}
function assertEq(a, b, msg) {
  assert(a === b, `${msg} (esperado ${JSON.stringify(b)}, obtuvo ${JSON.stringify(a)})`);
}

// ---------- 1. Flujo feliz: Pablo toma pedido en Mesa 10 ----------
(function flujoFeliz() {
  const s = L.nuevoEstado();
  assertEq(L.estadoMesa(s, 'mesa-10'), 'disponible', 'mesa inicia disponible');

  // escanea 2 hamburguesas especiales y 2 papas
  L.agregarProductoAlCarrito(s, 'mesa-10', 'u-pablo', 'p-hamb-esp');
  L.agregarProductoAlCarrito(s, 'mesa-10', 'u-pablo', 'p-hamb-esp');
  L.agregarProductoAlCarrito(s, 'mesa-10', 'u-pablo', 'p-papas');
  L.agregarProductoAlCarrito(s, 'mesa-10', 'u-pablo', 'p-papas');
  assertEq(L.estadoMesa(s, 'mesa-10'), 'abierto', 'mesa con carrito = abierto');
  assertEq(s.carritos['mesa-10'].items.length, 2, 'dos líneas distintas en el carrito');
  assertEq(s.carritos['mesa-10'].items[0].cantidad, 2, 'la segunda lectura suma unidad, no duplica línea');

  const envio = L.enviarPedido(s, 'mesa-10', 'u-pablo', 1000);
  assert(envio.ok, 'el envío debe ser exitoso');
  assertEq(L.estadoMesa(s, 'mesa-10'), 'enviado', 'mesa pasa a enviado tras enviar pedido');
  assertEq(s.carritos['mesa-10'].items.length, 0, 'el carrito se vacía tras enviar');

  const pedido = L.getPedido(s, envio.idPedido);
  assertEq(pedido.rondas.length, 1, 'una ronda creada');
  assertEq(pedido.rondas[0].estado, 'nuevo', 'ronda inicia en nuevo');

  const totales1 = L.totalesPedido(pedido);
  assertEq(totales1.subtotal, 2 * 28000 + 2 * 8000, 'subtotal correcto (2 hamb + 2 papas)');
  assertEq(totales1.servicio, Math.round(totales1.subtotal * 0.10), 'servicio 10% por defecto');

  // administración avanza la ronda: nuevo -> aceptado -> preparando -> listo -> entregado
  let r = pedido.rondas[0];
  let sig = L.siguienteEstadoRonda(r.estado);
  assertEq(sig, 'aceptado', 'siguiente estado tras nuevo es aceptado');
  L.cambiarEstadoRonda(s, pedido.id, r.id, 'aceptado', 'admin', 1100);
  L.cambiarEstadoRonda(s, pedido.id, r.id, 'preparando', 'admin', 1200);
  L.cambiarEstadoRonda(s, pedido.id, r.id, 'listo', 'admin', 1300);
  L.cambiarEstadoRonda(s, pedido.id, r.id, 'entregado', 'admin', 1400);
  assertEq(r.estado, 'entregado', 'ronda llega a entregado');
  assertEq(r.historial.length, 5, 'historial registra los 5 cambios (incluye creación)');
  assert(L.siguienteEstadoRonda('entregado') === null, 'entregado no tiene siguiente estado');

  // pedir cuenta y facturar
  L.pedirCuenta(s, pedido.id, 'u-pablo', 1500);
  assertEq(pedido.estadoCuenta, 'cuenta_solicitada', 'cuenta solicitada');
  assertEq(L.estadoMesa(s, 'mesa-10'), 'cuenta_solicitada', 'mesa refleja cuenta solicitada');

  const totales = L.totalesPedido(pedido);
  // pago en efectivo exacto
  L.registrarPago(s, pedido.id, { formaPago: 'efectivo', valor: totales.total, recibido: totales.total });
  const cobro = L.cobrarPedido(s, pedido.id, 'admin', 1600);
  assert(cobro.ok, 'el cobro debe ser exitoso con pago completo');
  assertEq(pedido.estadoCuenta, 'pagado', 'pedido queda pagado');
  assertEq(L.estadoMesa(s, 'mesa-10'), 'disponible', 'la mesa vuelve a disponible tras cobrar');
  assertEq(L.getMesa(s, 'mesa-10').idPedidoActivo, null, 'la mesa ya no tiene pedido activo');
})();

// ---------- 2. Rondas: segundo envío a mesa con pedido ya enviado ----------
(function rondas() {
  const s = L.nuevoEstado();
  L.agregarProductoAlCarrito(s, 'mesa-5', 'u-laura', 'p-hamb-esp');
  const e1 = L.enviarPedido(s, 'mesa-5', 'u-laura', 1000);
  const idPedido = e1.idPedido;

  // segundo mesero agrega una ronda a la misma mesa
  L.agregarProductoAlCarrito(s, 'mesa-5', 'u-andres', 'p-cerveza');
  L.agregarProductoAlCarrito(s, 'mesa-5', 'u-andres', 'p-cerveza');
  const e2 = L.enviarPedido(s, 'mesa-5', 'u-andres', 2000);
  assertEq(e2.idPedido, idPedido, 'la segunda ronda se agrega al mismo pedido, no crea uno nuevo');

  const pedido = L.getPedido(s, idPedido);
  assertEq(pedido.rondas.length, 2, 'dos rondas en el mismo pedido');
  assertEq(pedido.rondas[1].numero, 2, 'segunda ronda numerada como 2');
  assertEq(pedido.rondas[1].idMesero, 'u-andres', 'la ronda registra quién la tomó');

  const totales = L.totalesPedido(pedido);
  assertEq(totales.subtotal, 28000 + 2 * 7000, 'la factura suma todas las rondas');
})();

// ---------- 3. Anulación: solo en nuevo/aceptado, con motivo ----------
(function anulacion() {
  const s = L.nuevoEstado();
  L.agregarProductoAlCarrito(s, 'mesa-2', 'u-pablo', 'p-plato-paisa');
  const e = L.enviarPedido(s, 'mesa-2', 'u-pablo', 1000);
  const pedido = L.getPedido(s, e.idPedido);
  const ronda = pedido.rondas[0];

  const anulOk = L.anularRonda(s, pedido.id, ronda.id, 'Cliente se retractó', 'admin', 1100);
  assert(anulOk.ok, 'se puede anular en estado nuevo');
  assertEq(ronda.estado, 'anulado', 'ronda queda anulada');

  // otra mesa: intentar anular después de "preparando" debe fallar
  const s2 = L.nuevoEstado();
  L.agregarProductoAlCarrito(s2, 'mesa-3', 'u-pablo', 'p-plato-paisa');
  const e2 = L.enviarPedido(s2, 'mesa-3', 'u-pablo', 1000);
  const pedido2 = L.getPedido(s2, e2.idPedido);
  const ronda2 = pedido2.rondas[0];
  L.cambiarEstadoRonda(s2, pedido2.id, ronda2.id, 'aceptado', 'admin', 1100);
  L.cambiarEstadoRonda(s2, pedido2.id, ronda2.id, 'preparando', 'admin', 1200);
  const anulFail = L.anularRonda(s2, pedido2.id, ronda2.id, 'motivo', 'admin', 1300);
  assert(!anulFail.ok, 'no se puede anular después de preparando');
  assertEq(anulFail.motivo, 'estado_no_anulable', 'motivo correcto de rechazo');
})();

// ---------- 4. Pago mixto: la suma debe igualar el total para habilitar cobrar ----------
(function pagoMixto() {
  const s = L.nuevoEstado();
  L.agregarProductoAlCarrito(s, 'mesa-7', 'u-pablo', 'p-plato-paisa'); // 32000
  const e = L.enviarPedido(s, 'mesa-7', 'u-pablo', 1000);
  const pedido = L.getPedido(s, e.idPedido);
  L.aplicarServicioDescuento(s, pedido.id, { servicioAplicado: true });
  const totales = L.totalesPedido(pedido); // 32000 + 3200 = 35200

  // pago parcial: no debe permitir cobrar
  L.registrarPago(s, pedido.id, { formaPago: 'efectivo', valor: 20000, recibido: 20000 });
  const intento1 = L.cobrarPedido(s, pedido.id, 'admin', 1500);
  assert(!intento1.ok, 'no se puede cobrar con pago insuficiente');
  assertEq(intento1.motivo, 'pago_insuficiente', 'motivo correcto');
  assertEq(intento1.faltante, totales.total - 20000, 'calcula correctamente el faltante');

  // completa con tarjeta
  L.registrarPago(s, pedido.id, { formaPago: 'tarjeta', valor: totales.total - 20000 });
  const intento2 = L.cobrarPedido(s, pedido.id, 'admin', 1600);
  assert(intento2.ok, 'se puede cobrar cuando la suma de pagos iguala el total');
})();

// ---------- 5. Producto inactivo / inexistente no se agrega ----------
(function productoInvalido() {
  const s = L.nuevoEstado();
  const p = L.getProducto(s, 'p-hamb-esp');
  p.estado = 'inactivo';
  const r1 = L.agregarProductoAlCarrito(s, 'mesa-1', 'u-pablo', 'p-hamb-esp');
  assert(!r1.ok, 'producto inactivo no se agrega');
  assertEq(r1.motivo, 'inactivo', 'motivo inactivo');

  const r2 = L.agregarProductoAlCarrito(s, 'mesa-1', 'u-pablo', 'codigo-que-no-existe');
  assert(!r2.ok, 'código desconocido no se agrega');
  assertEq(r2.motivo, 'no_encontrado', 'motivo no_encontrado');
})();

// ---------- 6. Cantidades y eliminación en el carrito ----------
(function carritoEdicion() {
  const s = L.nuevoEstado();
  L.agregarProductoAlCarrito(s, 'mesa-4', 'u-pablo', 'p-gaseosa');
  L.agregarProductoAlCarrito(s, 'mesa-4', 'u-pablo', 'p-gaseosa');
  L.agregarProductoAlCarrito(s, 'mesa-4', 'u-pablo', 'p-gaseosa');
  assertEq(s.carritos['mesa-4'].items[0].cantidad, 3, 'tres unidades acumuladas');

  L.cambiarCantidadCarrito(s, 'mesa-4', 0, -1);
  assertEq(s.carritos['mesa-4'].items[0].cantidad, 2, 'cantidad baja a 2');

  L.cambiarCantidadCarrito(s, 'mesa-4', 0, -2);
  assertEq(s.carritos['mesa-4'].items.length, 0, 'la línea se elimina al llegar a 0');
})();

// ---------- 7. Consecutivo de pedidos incremental ----------
(function consecutivos() {
  const s = L.nuevoEstado();
  L.agregarProductoAlCarrito(s, 'mesa-1', 'u-pablo', 'p-gaseosa');
  const e1 = L.enviarPedido(s, 'mesa-1', 'u-pablo', 1000);
  L.agregarProductoAlCarrito(s, 'mesa-2', 'u-pablo', 'p-gaseosa');
  const e2 = L.enviarPedido(s, 'mesa-2', 'u-pablo', 1000);
  const p1 = L.getPedido(s, e1.idPedido);
  const p2 = L.getPedido(s, e2.idPedido);
  assertEq(p2.consecutivo, p1.consecutivo + 1, 'consecutivo incrementa en 1 por pedido nuevo');
})();

console.log(`\n${pass} pruebas pasaron, ${fail} fallaron.`);
if (fail > 0) process.exit(1);
