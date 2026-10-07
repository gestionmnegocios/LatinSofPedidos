// Doble en memoria de supabase-js para las pruebas e2e con jsdom.
//
// Imita lo justo de la API que usa index.html (from/select/insert/update/
// delete/eq/order/limit/single, rpc, functions.invoke, auth, channel) y una
// versión simplificada de las reglas del servidor:
//   * sin sesión: solo rpc('opciones_login') y la función login-pin;
//   * mesero: no ve pagos, no crea/edita productos ni meseros, y en pedidos
//     solo puede pedir la cuenta;
//   * admin (caja): todo lo demás.
// Así, si la app usara la sesión equivocada para una acción, la prueba falla.

function hoyISO(offsetMin) { return new Date(Date.now() + (offsetMin || 0) * 60000).toISOString(); }

function semilla() {
  const productos = [
    ['p-hamb-esp', '770001', 'Hamburguesa Especial', 'cat-comidas', 28000],
    ['p-hamb-sen', '770002', 'Hamburguesa Sencilla', 'cat-comidas', 19000],
    ['p-plato-paisa', '770003', 'Plato Paisa', 'cat-comidas', 32000],
    ['p-mini-paisa', '770004', 'Mini Paisa', 'cat-comidas', 24000],
    ['p-ensalada', '770005', 'Ensalada de la Casa', 'cat-comidas', 15000],
    ['p-patacones', '770006', 'Patacones con Hogao', 'cat-acomp', 9000],
    ['p-papas', '770007', 'Papas a la Francesa', 'cat-acomp', 8000],
    ['p-arepa', '770008', 'Arepa de Choclo', 'cat-acomp', 6000],
    ['p-cerveza', '770009', 'Cerveza Nacional', 'cat-bebidas', 7000],
    ['p-gaseosa', '770010', 'Gaseosa 400 ml', 'cat-bebidas', 5000],
    ['p-limonada', '770011', 'Limonada de Coco', 'cat-bebidas', 8500],
    ['p-jugo', '770012', 'Jugo en Leche', 'cat-bebidas', 7500],
  ].map(([id, codigo, nombre, categoria_id, precio]) => ({ id, restaurante_id: 'rest-fogon', codigo, nombre, categoria_id, precio, estado: 'activo' }));
  const mesas = [];
  for (let i = 1; i <= 15; i++) mesas.push({ id: 'mesa-' + i, restaurante_id: 'rest-fogon', numero: i, pedido_activo_id: null });
  mesas[8].pedido_activo_id = null; // mesa 9: su pedido histórico ya está pagado
  return {
    restaurantes: [{ id: 'rest-fogon', nombre: 'El Fogón de Prueba', nit: '900.000.000-1', direccion: 'Calle 1 # 2-3', porcentaje_servicio: 10, pie_comprobante: 'Gracias' }],
    categorias: [
      { id: 'cat-comidas', restaurante_id: 'rest-fogon', nombre: 'Comidas', orden: 1 },
      { id: 'cat-bebidas', restaurante_id: 'rest-fogon', nombre: 'Bebidas', orden: 2 },
      { id: 'cat-acomp', restaurante_id: 'rest-fogon', nombre: 'Acompañamientos', orden: 3 },
    ],
    productos,
    meseros: [
      { id: 'u-pablo', restaurante_id: 'rest-fogon', nombre: 'Pablo Pérez', usuario: 'pablo', estado: 'activo', ultimo_ingreso: null, rol: 'mesero' },
      { id: 'u-laura', restaurante_id: 'rest-fogon', nombre: 'Laura Gómez', usuario: 'laura', estado: 'activo', ultimo_ingreso: null, rol: 'mesero' },
      { id: 'u-andres', restaurante_id: 'rest-fogon', nombre: 'Andrés Ruiz', usuario: 'andres', estado: 'activo', ultimo_ingreso: null, rol: 'mesero' },
      { id: 'u-caja', restaurante_id: 'rest-fogon', nombre: 'Caja Principal', usuario: 'caja', estado: 'activo', ultimo_ingreso: null, rol: 'admin' },
    ],
    mesas,
    pedidos: [{ consecutivo: 124, id: 'PED124', restaurante_id: 'rest-fogon', mesa_id: 'mesa-9', mesero_principal_id: 'u-laura',
      estado_cuenta: 'pagado', servicio_pct: 10, servicio_aplicado: true, descuento: 0, creado_en: hoyISO(-90),
      cuenta_solicitada_en: hoyISO(-60), pagado_en: hoyISO(-50) }],
    rondas: [{ id: 'PED124-R1', pedido_id: 'PED124', numero: 1, mesero_id: 'u-laura',
      items: [{ idProducto: 'p-mini-paisa', nombre: 'Mini Paisa', cantidad: 1, precioUnitario: 24000, observacion: '' }],
      estado: 'entregado', enviado_en: hoyISO(-90), historial: [], motivo_anulacion: null }],
    pagos: [{ id: 1, pedido_id: 'PED124', forma_pago: 'efectivo', valor: 26400, recibido: 30000, hora: hoyISO(-50) }],
  };
}

function crearBackend(pines) {
  const db = semilla();
  const backend = {
    db,
    // credenciales "del servidor": PIN de prueba + control de intentos
    credenciales: {},
    almacen: {}, // sesiones persistidas por storageKey (sobrevive a "recargar la página")
    log: { from: [], selectMeseros: [], rpc: [], invoke: [] },
    sigConsecutivo: 125, sigPago: 2, sigToken: 1,
  };
  Object.keys(pines).forEach(id => { backend.credenciales[id] = { pin: pines[id], intentos: 0, bloqueadoHasta: 0 }; });
  return backend;
}

function err(code, message) { return { data: null, error: { code, message } }; }

function perfilDeSesion(backend, sesion) {
  if (!sesion) return null;
  const m = backend.db.meseros.find(x => x.id === sesion.user.app_metadata.mesero_id);
  if (!m || m.estado !== 'activo') return null; // como private.mi_rol(): desactivar corta el acceso
  return m;
}

function pinAleatorio() { return String(Math.floor(Math.random() * 10000)).padStart(4, '0'); }

class Consulta {
  constructor(cliente, tabla) {
    this.c = cliente; this.tabla = tabla; this.op = 'select'; this.cols = '*';
    this.filtros = []; this.orden = null; this.lim = null; this.unica = false; this.devolver = false;
  }
  select(cols) { if (this.op === 'select') this.cols = cols || '*'; else { this.devolver = true; this.cols = cols || '*'; } return this; }
  insert(v) { this.op = 'insert'; this.valor = v; return this; }
  update(v) { this.op = 'update'; this.valor = v; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(col, val) { this.filtros.push([col, val]); return this; }
  order(col) { this.orden = col; return this; }
  limit(n) { this.lim = n; return this; }
  single() { this.unica = true; return this; }
  then(ok, ko) { return Promise.resolve().then(() => this.ejecutar()).then(ok, ko); }
  coincide(fila) { return this.filtros.every(([c, v]) => String(fila[c]) === String(v)); }
  ejecutar() {
    const b = this.c.backend, t = this.tabla, filas = b.db[t];
    b.log.from.push({ cliente: this.c.nombre, tabla: t, op: this.op });
    if (t === 'meseros' && this.op === 'select') b.log.selectMeseros.push(this.cols);
    const yo = perfilDeSesion(b, this.c.sesion);
    if (!yo) return err('42501', 'permission denied (sin sesión)');
    const admin = yo.rol === 'admin';
    if (t === 'meseros' && this.cols.indexOf('pin') !== -1) return err('42501', 'permission denied for column pin');

    if (this.op === 'select') {
      let out = filas.filter(f => this.coincide(f));
      if (t === 'pagos' && !admin) out = [];
      if (this.orden) out = out.slice().sort((a, b2) => a[this.orden] - b2[this.orden]);
      if (this.lim != null) out = out.slice(0, this.lim);
      out = out.map(f => {
        const copia = Object.assign({}, f);
        if (t === 'pedidos' && this.cols.indexOf('rondas(') !== -1) copia.rondas = b.db.rondas.filter(r => r.pedido_id === f.id).map(r => Object.assign({}, r));
        if (t === 'pedidos' && this.cols.indexOf('pagos(') !== -1) copia.pagos = admin ? b.db.pagos.filter(p => p.pedido_id === f.id).map(p => Object.assign({}, p)) : [];
        return copia;
      });
      return { data: this.unica ? (out[0] || null) : out, error: null };
    }

    if (this.op === 'insert') {
      if (['productos', 'pagos', 'meseros'].indexOf(t) !== -1 && !admin) return err('42501', 'new row violates row-level security policy');
      const fila = Object.assign({}, this.valor);
      if (t === 'pedidos') {
        if (!admin && fila.mesero_principal_id !== yo.id) return err('42501', 'new row violates row-level security policy');
        const n = b.sigConsecutivo++;
        Object.assign(fila, { consecutivo: n, id: 'PED' + n, estado_cuenta: 'abierta', servicio_pct: 10, servicio_aplicado: true,
          descuento: 0, creado_en: new Date().toISOString(), cuenta_solicitada_en: null, pagado_en: null });
      }
      if (t === 'rondas') fila.enviado_en = fila.enviado_en || new Date().toISOString();
      if (t === 'pagos') { fila.id = b.sigPago++; fila.hora = new Date().toISOString(); }
      filas.push(fila);
      const copia = Object.assign({}, fila);
      return { data: this.devolver ? (this.unica ? copia : [copia]) : null, error: null };
    }

    if (this.op === 'update') {
      if (['productos', 'meseros'].indexOf(t) !== -1 && !admin) return { data: this.devolver ? [] : null, error: null }; // RLS: 0 filas
      const objetivo = filas.filter(f => this.coincide(f));
      if (!admin && t === 'pedidos') {
        const v = this.valor;
        const soloCuenta = Object.keys(v).every(k => k === 'estado_cuenta' || k === 'cuenta_solicitada_en') && v.estado_cuenta === 'cuenta_solicitada';
        if (!soloCuenta) return err('42501', 'Un mesero solo puede pedir la cuenta');
      }
      if (!admin && t === 'rondas' && (this.valor.estado !== 'entregado' || 'motivo_anulacion' in this.valor)) return err('42501', 'Un mesero solo puede marcar rondas como entregadas');
      if (!admin && t === 'mesas' && objetivo.some(f => f.pedido_activo_id && f.pedido_activo_id !== this.valor.pedido_activo_id)) return err('42501', 'mesa ocupada');
      if (t === 'meseros' && objetivo.some(f => f.id === yo.id)) return { data: [], error: null };
      objetivo.forEach(f => Object.assign(f, this.valor));
      return { data: this.devolver ? objetivo.map(f => Object.assign({}, f)) : null, error: null };
    }

    if (this.op === 'delete') {
      if (t !== 'pagos' || !admin) return err('42501', 'permission denied');
      b.db[t] = filas.filter(f => !this.coincide(f));
      return { data: null, error: null };
    }
  }
}

function crearCliente(backend, nombre, storageKey) {
  const oyentes = [];
  const cliente = {
    backend, nombre,
    get sesion() { return backend.almacen[storageKey] || null; },
    from(tabla) { return new Consulta(cliente, tabla); },
    async rpc(fn, args) {
      backend.log.rpc.push({ cliente: nombre, fn, args });
      const yo = perfilDeSesion(backend, cliente.sesion);
      if (fn === 'opciones_login') {
        const r = backend.db.restaurantes.find(x => x.id === args.p_restaurante_id);
        return { data: {
          restaurante: r ? { nombre: r.nombre } : null,
          usuarios: backend.db.meseros.filter(m => m.restaurante_id === args.p_restaurante_id && m.estado === 'activo')
            .map(m => ({ id: m.id, nombre: m.nombre, rol: m.rol })),
        }, error: null };
      }
      if (!yo || yo.rol !== 'admin') return err('42501', 'Solo administración');
      if (fn === 'admin_crear_mesero') {
        if (!/^[a-z0-9._-]{2,30}$/.test(args.p_usuario) || backend.db.meseros.some(m => m.usuario === args.p_usuario)) return err('22023', 'usuario inválido');
        const id = 'u-' + args.p_usuario, pin = pinAleatorio();
        backend.db.meseros.push({ id, restaurante_id: yo.restaurante_id, nombre: args.p_nombre, usuario: args.p_usuario, estado: 'activo', ultimo_ingreso: null, rol: 'mesero' });
        backend.credenciales[id] = { pin, intentos: 0, bloqueadoHasta: 0 };
        return { data: { id, pin }, error: null };
      }
      if (fn === 'admin_restablecer_pin') {
        const pin = pinAleatorio();
        backend.credenciales[args.p_mesero_id] = { pin, intentos: 0, bloqueadoHasta: 0 };
        return { data: { id: args.p_mesero_id, pin }, error: null };
      }
      return err('PGRST202', 'función desconocida ' + fn);
    },
    functions: {
      async invoke(fn, opciones) {
        const body = opciones && opciones.body || {};
        backend.log.invoke.push({ cliente: nombre, fn, body: Object.assign({}, body) });
        if (fn !== 'login-pin') return { data: null, error: { message: 'no existe' } };
        // misma regla que public.verificar_pin_login
        const m = backend.db.meseros.find(x => x.id === body.mesero_id);
        const cr = backend.credenciales[body.mesero_id];
        if (!m || m.estado !== 'activo' || m.rol !== body.rol) return { data: { ok: false, motivo: 'usuario_invalido' }, error: null };
        if (!cr) return { data: { ok: false, motivo: 'sin_pin' }, error: null };
        if (cr.bloqueadoHasta > Date.now()) return { data: { ok: false, motivo: 'bloqueado', bloqueado_hasta: new Date(cr.bloqueadoHasta).toISOString() }, error: null };
        if (body.pin === cr.pin) {
          cr.intentos = 0; cr.bloqueadoHasta = 0; m.ultimo_ingreso = new Date().toISOString();
          const tok = 'tok-' + (backend.sigToken++);
          backend.tokens = backend.tokens || {};
          backend.tokens[tok] = { mesero_id: m.id, restaurante_id: m.restaurante_id, rol: m.rol };
          return { data: { ok: true, session: { access_token: tok, refresh_token: 'ref-' + tok }, usuario: { id: m.id, rol: m.rol, nombre: m.nombre } }, error: null };
        }
        cr.intentos++;
        if (cr.intentos % 5 === 0) {
          cr.bloqueadoHasta = Date.now() + 15 * 60000;
          return { data: { ok: false, motivo: 'bloqueado', bloqueado_hasta: new Date(cr.bloqueadoHasta).toISOString() }, error: null };
        }
        return { data: { ok: false, motivo: 'pin_incorrecto', intentos_restantes: 5 - cr.intentos % 5 }, error: null };
      },
    },
    auth: {
      async getSession() { return { data: { session: cliente.sesion }, error: null }; },
      async setSession({ access_token, refresh_token }) {
        const meta = backend.tokens && backend.tokens[access_token];
        if (!meta) return { data: { session: null }, error: { message: 'token inválido' } };
        backend.almacen[storageKey] = { access_token, refresh_token, user: { id: 'auth-' + meta.mesero_id, app_metadata: Object.assign({}, meta) } };
        oyentes.forEach(f => f('SIGNED_IN', cliente.sesion));
        return { data: { session: cliente.sesion }, error: null };
      },
      async signOut() {
        delete backend.almacen[storageKey];
        oyentes.forEach(f => f('SIGNED_OUT', null));
        return { error: null };
      },
      onAuthStateChange(f) { oyentes.push(f); return { data: { subscription: { unsubscribe() {} } } }; },
    },
    channel() { const ch = { on() { return ch; }, subscribe() { return ch; } }; return ch; },
    removeChannel() {},
  };
  return cliente;
}

// Lo que se instala como window.supabase dentro de jsdom.
function instalar(backend) {
  let n = 0;
  return {
    createClient(url, key, opciones) {
      const storageKey = (opciones && opciones.auth && opciones.auth.storageKey) || 'sb-default';
      return crearCliente(backend, storageKey.replace('latinsoft-sesion-', '') || 'c' + (n++), storageKey);
    },
  };
}

module.exports = { crearBackend, instalar };
