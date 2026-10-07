// Lógica del login por PIN, sin dependencias: index.ts le inyecta las
// llamadas reales a Supabase y tests/login-pin.test.mjs le inyecta dobles.
// (Solo usa anotaciones de tipo, así Node puede importarlo tal cual.)

export type Rol = 'mesero' | 'admin';

export type ResultadoVerificacion = {
  ok: boolean;
  motivo?: string;
  mesero_id?: string;
  restaurante_id?: string;
  rol?: Rol;
  nombre?: string;
  auth_user_id?: string | null;
  intentos_restantes?: number;
  bloqueado_hasta?: string;
};

export type MetadatosApp = { mesero_id: string; restaurante_id: string; rol: Rol };

export type Dependencias = {
  verificarPin(meseroId: string, pin: string, rol: Rol): Promise<ResultadoVerificacion>;
  existeUsuario(authUserId: string): Promise<boolean>;
  crearUsuario(email: string, meta: MetadatosApp): Promise<string>;
  actualizarMetadatos(authUserId: string, meta: MetadatosApp): Promise<void>;
  vincularUsuario(meseroId: string, authUserId: string): Promise<void>;
  emitirSesion(email: string): Promise<{ access_token: string; refresh_token: string; expires_at?: number }>;
};

export type Respuesta = { status: number; body: Record<string, unknown> };

// Dominio reservado (RFC 2606): nadie puede recibir correo en ".invalid",
// así que un enlace mágico pedido para este email no le llega a nadie.
export function emailSintetico(meseroId: string): string {
  return meseroId.toLowerCase() + '@usuarios.latinsofpedidos.invalid';
}

export async function manejarLogin(entrada: unknown, deps: Dependencias): Promise<Respuesta> {
  const e = (entrada && typeof entrada === 'object') ? entrada as Record<string, unknown> : {};
  const meseroId = e.mesero_id, pin = e.pin, rol = e.rol;
  if (typeof meseroId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(meseroId)
      || typeof pin !== 'string' || !/^[0-9]{4}$/.test(pin)
      || (rol !== 'mesero' && rol !== 'admin')) {
    return { status: 400, body: { ok: false, motivo: 'solicitud_invalida' } };
  }

  const v = await deps.verificarPin(meseroId, pin, rol);
  if (!v.ok) {
    const body: Record<string, unknown> = { ok: false, motivo: v.motivo || 'pin_incorrecto' };
    if (v.intentos_restantes != null) body.intentos_restantes = v.intentos_restantes;
    if (v.bloqueado_hasta) body.bloqueado_hasta = v.bloqueado_hasta;
    return { status: 200, body };
  }

  const meta: MetadatosApp = { mesero_id: v.mesero_id!, restaurante_id: v.restaurante_id!, rol: v.rol! };
  const email = emailSintetico(meta.mesero_id);
  let authUserId = v.auth_user_id || null;
  if (authUserId && !(await deps.existeUsuario(authUserId))) authUserId = null;
  if (authUserId) {
    // el rol o el restaurante pudieron cambiar desde el último ingreso
    await deps.actualizarMetadatos(authUserId, meta);
  } else {
    authUserId = await deps.crearUsuario(email, meta);
    await deps.vincularUsuario(meta.mesero_id, authUserId);
  }

  const sesion = await deps.emitirSesion(email);
  return {
    status: 200,
    body: {
      ok: true,
      session: { access_token: sesion.access_token, refresh_token: sesion.refresh_token, expires_at: sesion.expires_at },
      usuario: { id: meta.mesero_id, rol: meta.rol, nombre: v.nombre },
    },
  };
}
