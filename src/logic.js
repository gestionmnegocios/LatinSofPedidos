// ============================================================
// LatinSoft Pedidos — lógica de estado (pura, sin DOM)
// Se prueba con node antes de incrustarse en el artifact HTML.
// ============================================================

function clonaSeed() {
  const categorias = [
    { id: 'cat-comidas', nombre: 'Comidas' },
    { id: 'cat-bebidas', nombre: 'Bebidas' },
    { id: 'cat-acomp', nombre: 'Acompañamientos' },
  ];

  const productos = [
    { id: 'p-hamb-esp', codigo: '770001', nombre: 'Hamburguesa Especial', idCategoria: 'cat-comidas', precio: 28000, estado: 'activo' },
    { id: 'p-hamb-sen', codigo: '770002', nombre: 'Hamburguesa Sencilla', idCategoria: 'cat-comidas', precio: 19000, estado: 'activo' },
    { id: 'p-plato-paisa', codigo: '770003', nombre: 'Plato Paisa', idCategoria: 'cat-comidas', precio: 32000, estado: 'activo' },
    { id: 'p-mini-paisa', codigo: '770004', nombre: 'Mini Paisa', idCategoria: 'cat-comidas', precio: 24000, estado: 'activo' },
    { id: 'p-ensalada', codigo: '770005', nombre: 'Ensalada de la Casa', idCategoria: 'cat-comidas', precio: 15000, estado: 'activo' },
    { id: 'p-patacones', codigo: '770006', nombre: 'Patacones con Hogao', idCategoria: 'cat-acomp', precio: 9000, estado: 'activo' },
    { id: 'p-papas', codigo: '770007', nombre: 'Papas a la Francesa', idCategoria: 'cat-acomp', precio: 8000, estado: 'activo' },
    { id: 'p-arepa', codigo: '770008', nombre: 'Arepa de Choclo', idCategoria: 'cat-acomp', precio: 6000, estado: 'activo' },
    { id: 'p-cerveza', codigo: '770009', nombre: 'Cerveza Nacional', idCategoria: 'cat-bebidas', precio: 7000, estado: 'activo' },
    { id: 'p-gaseosa', codigo: '770010', nombre: 'Gaseosa 400 ml', idCategoria: 'cat-bebidas', precio: 5000, estado: 'activo' },
    { id: 'p-limonada', codigo: '770011', nombre: 'Limonada de Coco', idCategoria: 'cat-bebidas', precio: 8500, estado: 'activo' },
    { id: 'p-jugo', codigo: '770012', nombre: 'Jugo en Leche', idCategoria: 'cat-bebidas', precio: 7500, estado: 'activo' },
  ];

  const meseros = [
    { id: 'u-pablo', nombre: 'Pablo Pérez', usuario: 'pablo', pin: '1234', estado: 'activo', ultimoIngreso: null },
    { id: 'u-laura', nombre: 'Laura Gómez', usuario: 'laura', pin: '2222', estado: 'activo', ultimoIngreso: null },
    { id: 'u-andres', nombre: 'Andrés Ruiz', usuario: 'andres', pin: '3333', estado: 'activo', ultimoIngreso: null },
  ];

  const mesas = [];
  for (let i = 1; i <= 15; i++) {
    mesas.push({ id: 'mesa-' + i, numero: i, idPedidoActivo: null });
  }

  return {
    restaurante: {
      nombre: 'Asadero El Fogón',
      nit: '900.123.456-7',
      direccion: 'Cra 45 #10-23, Medellín',
      porcentajeServicio: 10,
      pieComprobante: '¡Gracias por su visita! Vuelva pronto.',
    },
    categorias,
    productos,
    meseros,
    mesas,
    pedidos: {},
    carritos: {},
    consecutivo: 122,
  };
}

function nuevoEstado() {
  return clonaSeed();
}

// ---------- utilidades ----------
function getMesa(state, idMesa) { return state.mesas.find(m => m.id === idMesa); }
function getProducto(state, idProducto) { return state.productos.find(p => p.id === idProducto); }
function getMesero(state, idMesero) { return state.meseros.find(m => m.id === idMesero); }
function getPedido(state, idPedido) { return state.pedidos[idPedido]; }

function estadoMesa(state, idMesa) {
  const mesa = getMesa(state, idMesa);
  if (!mesa) return null;
  if (mesa.idPedidoActivo) {
    const pedido = getPedido(state, mesa.idPedidoActivo);
    if (pedido.estadoCuenta === 'cuenta_solicitada') return 'cuenta_solicitada';
    return 'enviado';
  }
  const carrito = state.carritos[idMesa];
  if (carrito && carrito.items.length > 0) return 'abierto';
  return 'disponible';
}

function totalItem(item) { return item.cantidad * item.precioUnitario; }

function subtotalRonda(ronda) {
  return ronda.items.reduce((acc, it) => acc + totalItem(it), 0);
}

function subtotalPedido(pedido) {
  return pedido.rondas
    .filter(r => r.estado !== 'anulado')
    .reduce((acc, r) => acc + subtotalRonda(r), 0);
}

function totalesPedido(pedido) {
  const subtotal = subtotalPedido(pedido);
  const servicio = pedido.servicioAplicado ? Math.round(subtotal * (pedido.servicioPct / 100)) : 0;
  const descuento = pedido.descuento || 0;
  const total = Math.max(0, subtotal + servicio - descuento);
  return { subtotal, servicio, descuento, total };
}

// ---------- carrito (pedido abierto, aún no enviado) ----------
function abrirCarrito(state, idMesa, idMesero) {
  if (!state.carritos[idMesa]) {
    state.carritos[idMesa] = { idMesero, items: [] };
  }
  return state.carritos[idMesa];
}

function agregarProductoAlCarrito(state, idMesa, idMesero, idProducto) {
  const producto = getProducto(state, idProducto);
  if (!producto) return { ok: false, motivo: 'no_encontrado' };
  if (producto.estado !== 'activo') return { ok: false, motivo: 'inactivo' };
  const carrito = abrirCarrito(state, idMesa, idMesero);
  const existente = carrito.items.find(it => it.idProducto === idProducto && !it.observacion);
  if (existente) {
    existente.cantidad += 1;
  } else {
    carrito.items.push({
      idProducto,
      nombre: producto.nombre,
      cantidad: 1,
      precioUnitario: producto.precio,
      observacion: '',
    });
  }
  return { ok: true };
}

function cambiarCantidadCarrito(state, idMesa, index, delta) {
  const carrito = state.carritos[idMesa];
  if (!carrito || !carrito.items[index]) return;
  carrito.items[index].cantidad += delta;
  if (carrito.items[index].cantidad <= 0) {
    carrito.items.splice(index, 1);
  }
}

function eliminarItemCarrito(state, idMesa, index) {
  const carrito = state.carritos[idMesa];
  if (!carrito) return;
  carrito.items.splice(index, 1);
}

function setObservacionCarrito(state, idMesa, index, texto) {
  const carrito = state.carritos[idMesa];
  if (!carrito || !carrito.items[index]) return;
  carrito.items[index].observacion = texto;
}

// ---------- enviar pedido / rondas ----------
function enviarPedido(state, idMesa, idMesero, now) {
  const carrito = state.carritos[idMesa];
  if (!carrito || carrito.items.length === 0) return { ok: false, motivo: 'carrito_vacio' };

  const mesa = getMesa(state, idMesa);
  let pedido;
  let numeroRonda;

  if (mesa.idPedidoActivo) {
    pedido = getPedido(state, mesa.idPedidoActivo);
    numeroRonda = pedido.rondas.length + 1;
  } else {
    state.consecutivo += 1;
    const idPedido = 'PED' + state.consecutivo;
    pedido = {
      id: idPedido,
      consecutivo: state.consecutivo,
      idMesa,
      meseroPrincipal: idMesero,
      estadoCuenta: 'abierta',
      rondas: [],
      servicioPct: state.restaurante.porcentajeServicio,
      servicioAplicado: true,
      descuento: 0,
      pagos: [],
      creadoEn: now,
    };
    state.pedidos[idPedido] = pedido;
    mesa.idPedidoActivo = idPedido;
    numeroRonda = 1;
  }

  const ronda = {
    id: pedido.id + '-R' + numeroRonda,
    numero: numeroRonda,
    idMesero,
    items: carrito.items.map(it => ({ ...it })),
    estado: 'nuevo',
    enviadoEn: now,
    historial: [{ de: null, a: 'nuevo', usuario: idMesero, hora: now }],
  };
  pedido.rondas.push(ronda);
  state.carritos[idMesa] = { idMesero, items: [] };

  return { ok: true, idPedido: pedido.id, idRonda: ronda.id };
}

const ORDEN_ESTADOS_RONDA = ['nuevo', 'aceptado', 'preparando', 'listo', 'entregado'];

function siguienteEstadoRonda(estado) {
  const idx = ORDEN_ESTADOS_RONDA.indexOf(estado);
  if (idx === -1 || idx === ORDEN_ESTADOS_RONDA.length - 1) return null;
  return ORDEN_ESTADOS_RONDA[idx + 1];
}

function cambiarEstadoRonda(state, idPedido, idRonda, nuevoEstadoValor, usuario, now) {
  const pedido = getPedido(state, idPedido);
  if (!pedido) return { ok: false, motivo: 'pedido_no_existe' };
  const ronda = pedido.rondas.find(r => r.id === idRonda);
  if (!ronda) return { ok: false, motivo: 'ronda_no_existe' };
  const anterior = ronda.estado;
  ronda.estado = nuevoEstadoValor;
  ronda.historial.push({ de: anterior, a: nuevoEstadoValor, usuario, hora: now });
  return { ok: true };
}

function anularRonda(state, idPedido, idRonda, motivo, usuario, now) {
  const pedido = getPedido(state, idPedido);
  if (!pedido) return { ok: false, motivo: 'pedido_no_existe' };
  const ronda = pedido.rondas.find(r => r.id === idRonda);
  if (!ronda) return { ok: false, motivo: 'ronda_no_existe' };
  if (!['nuevo', 'aceptado'].includes(ronda.estado)) {
    return { ok: false, motivo: 'estado_no_anulable' };
  }
  ronda.estado = 'anulado';
  ronda.motivoAnulacion = motivo;
  ronda.historial.push({ de: ronda.estado, a: 'anulado', usuario, hora: now, motivo });
  return { ok: true };
}

// ---------- cuenta / facturación / pago ----------
function pedirCuenta(state, idPedido, usuario, now) {
  const pedido = getPedido(state, idPedido);
  if (!pedido) return { ok: false, motivo: 'pedido_no_existe' };
  pedido.estadoCuenta = 'cuenta_solicitada';
  pedido.cuentaSolicitadaEn = now;
  return { ok: true };
}

function aplicarServicioDescuento(state, idPedido, { servicioAplicado, descuento }) {
  const pedido = getPedido(state, idPedido);
  if (!pedido) return { ok: false, motivo: 'pedido_no_existe' };
  if (typeof servicioAplicado === 'boolean') pedido.servicioAplicado = servicioAplicado;
  if (typeof descuento === 'number' && descuento >= 0) pedido.descuento = descuento;
  return { ok: true };
}

function registrarPago(state, idPedido, pago) {
  // pago: { formaPago, valor, recibido }
  const pedido = getPedido(state, idPedido);
  if (!pedido) return { ok: false, motivo: 'pedido_no_existe' };
  pedido.pagos.push({ ...pago, hora: Date.now() });
  return { ok: true };
}

function totalPagado(pedido) {
  return pedido.pagos.reduce((acc, p) => acc + p.valor, 0);
}

function cobrarPedido(state, idPedido, usuario, now) {
  const pedido = getPedido(state, idPedido);
  if (!pedido) return { ok: false, motivo: 'pedido_no_existe' };
  const { total } = totalesPedido(pedido);
  const pagado = totalPagado(pedido);
  if (pagado < total) return { ok: false, motivo: 'pago_insuficiente', faltante: total - pagado };
  pedido.estadoCuenta = 'pagado';
  pedido.pagadoEn = now;
  const mesa = getMesa(state, pedido.idMesa);
  if (mesa) mesa.idPedidoActivo = null;
  return { ok: true };
}

function facturarPedido(state, idPedido, usuario, now) {
  const pedido = getPedido(state, idPedido);
  if (!pedido) return { ok: false, motivo: 'pedido_no_existe' };
  pedido.estadoCuenta = 'cuenta_solicitada';
  pedido.cuentaSolicitadaEn = pedido.cuentaSolicitadaEn || now;
  return { ok: true };
}

module.exports = {
  clonaSeed, nuevoEstado, getMesa, getProducto, getMesero, getPedido,
  estadoMesa, totalItem, subtotalRonda, subtotalPedido, totalesPedido,
  abrirCarrito, agregarProductoAlCarrito, cambiarCantidadCarrito,
  eliminarItemCarrito, setObservacionCarrito, enviarPedido,
  ORDEN_ESTADOS_RONDA, siguienteEstadoRonda, cambiarEstadoRonda, anularRonda,
  pedirCuenta, aplicarServicioDescuento, registrarPago, totalPagado,
  cobrarPedido, facturarPedido,
};
