// Edge Function: login de meseros y caja por PIN.
//
// 1. Verifica el PIN en la base (hash bcrypt + bloqueo por intentos) con
//    la función verificar_pin_login, que solo puede ejecutar service_role.
// 2. Si es correcto, asegura que el mesero tenga su usuario de Supabase Auth
//    (email sintético en un dominio .invalid, sin contraseña).
// 3. Emite una sesión real para ese usuario: genera un enlace mágico con la
//    API de administración (no se envía ningún correo) y lo canjea en el
//    servidor. El navegador solo recibe access_token + refresh_token.
//
// verify_jwt = false: quien llama todavía no tiene sesión; la autenticación
// es el propio PIN.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { manejarLogin, type Dependencias } from './handler.ts';

const URL_SUPABASE = Deno.env.get('SUPABASE_URL')!;
const CLAVE_SERVICIO = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CLAVE_ANON = Deno.env.get('SUPABASE_ANON_KEY')!;

const opcionesSinSesion = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(URL_SUPABASE, CLAVE_SERVICIO, opcionesSinSesion);

const deps: Dependencias = {
  async verificarPin(meseroId, pin, rol) {
    const { data, error } = await admin.rpc('verificar_pin_login', { p_mesero_id: meseroId, p_pin: pin, p_rol: rol });
    if (error) throw error;
    return data;
  },
  async existeUsuario(id) {
    const { data, error } = await admin.auth.admin.getUserById(id);
    return !error && !!data?.user;
  },
  async crearUsuario(email, meta) {
    const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true, app_metadata: meta });
    if (error) throw error;
    return data.user.id;
  },
  async actualizarMetadatos(id, meta) {
    const { error } = await admin.auth.admin.updateUserById(id, { app_metadata: meta });
    if (error) throw error;
  },
  async vincularUsuario(meseroId, authUserId) {
    const { error } = await admin.rpc('vincular_usuario_auth', { p_mesero_id: meseroId, p_auth_user_id: authUserId });
    if (error) throw error;
  },
  async emitirSesion(email) {
    const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
    if (error) throw error;
    const publico = createClient(URL_SUPABASE, CLAVE_ANON, opcionesSinSesion);
    const r = await publico.auth.verifyOtp({ type: 'magiclink', token_hash: data.properties.hashed_token });
    if (r.error || !r.data.session) throw r.error || new Error('sin sesión');
    return r.data.session;
  },
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return Response.json({ ok: false, motivo: 'metodo' }, { status: 405, headers: CORS });
  try {
    const entrada = await req.json().catch(() => null);
    const r = await manejarLogin(entrada, deps);
    return Response.json(r.body, { status: r.status, headers: CORS });
  } catch (err) {
    console.error('login-pin', err);
    return Response.json({ ok: false, motivo: 'error_servidor' }, { status: 500, headers: CORS });
  }
});
