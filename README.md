# LatinSoft Pedidos

App de pedidos para restaurantes con dos interfaces en un solo `index.html`
(HTML + CSS + JS, sin build):

- **📱 App del mesero** — login con PIN, mapa de mesas, escaneo de productos,
  carrito con observaciones, envío de pedidos y rondas, "Mis pedidos".
- **🖥️ Panel de caja / administración** — kanban en tiempo real, mapa de
  mesas, facturación (servicio, descuento, pago mixto), productos, meseros y
  ventas del día.

Publicada en Vercel (https://latinsofpedidos.vercel.app, se despliega sola al
hacer push a `main`) sobre **Supabase** (Postgres + Auth + Realtime + Edge
Functions).

## Seguridad: cómo funciona el login

- El **PIN nunca llega al navegador**. Se guarda como hash bcrypt en
  `private.credenciales`, un esquema que la API pública no expone y sobre el
  que `anon` y `authenticated` no tienen permisos.
- Al teclear el PIN, la app llama a la Edge Function **`login-pin`**, que lo
  verifica en el servidor con `verificar_pin_login` (solo la puede ejecutar
  `service_role`). **5 intentos fallidos bloquean a ese usuario 15 min**; cada
  nueva tanda de 5 fallos duplica el bloqueo (máx. 24 h). Restablecer el PIN
  quita el bloqueo.
- Si el PIN es correcto, la función emite una **sesión real de Supabase Auth**
  para un usuario de Auth propio de ese mesero (email sintético en el dominio
  reservado `.invalid`, sin contraseña). El navegador solo recibe los tokens.
- Mesero y caja tienen **sesiones independientes** (un cliente de Supabase por
  vista), así pueden estar abiertas a la vez en el mismo equipo.
- Las **políticas RLS** se evalúan contra la tabla de meseros en cada
  petición (no contra el token), así que desactivar a alguien o cambiarle el
  rol corta su acceso al instante:
  - sin sesión (`anon`): solo `opciones_login` (nombre del restaurante y
    usuarios activos, sin PIN) y la función `login-pin`;
  - **mesero**: ve los datos de su restaurante (excepto pagos), crea pedidos a
    su nombre, rondas, pide la cuenta y marca rondas como entregadas;
  - **caja (`rol = 'admin'`)**: además cobra, aplica servicio/descuentos,
    anula rondas, gestiona productos y meseros.
- Crear un mesero o restablecer un PIN genera el PIN en la base de datos y se
  muestra **una sola vez** en pantalla.

La clave publicable que está en `index.html` es pública por diseño: sin una
sesión obtenida con un PIN válido no da acceso a ningún dato.

## Estructura

```
├── index.html                       # La app completa
├── src/logic.js                     # Lógica de negocio pura (prototipo en memoria), probada con node
├── supabase/
│   ├── migrations/                  # SQL aplicado en el proyecto de Supabase
│   │   ├── …_auth_pin_fase1.sql     # PIN con hash, sesiones, RLS por rol (compatible con la versión anterior)
│   │   └── …_auth_pin_fase2_cerrar_anon.sql  # quita el acceso anon y la columna meseros.pin
│   ├── functions/login-pin/         # Edge Function del login (index.ts + handler.ts, probable con node)
│   └── tests/fase1_rls_rollback.sql # pruebas de RLS por rol dentro de una transacción que se revierte
└── tests/
    ├── logic.test.js                # pruebas unitarias de src/logic.js
    ├── login-pin.test.mjs           # pruebas de la lógica de la Edge Function
    ├── fake-supabase.js             # doble en memoria de supabase-js con reglas de acceso
    └── e2e.test.js                  # recorrido de clics sobre index.html con jsdom
```

## Correr las pruebas

Requiere Node 22.18 o superior (para importar el `.ts` de la Edge Function).

```bash
npm install
npm test
```

## Operación

- **Rotar PIN**: en Caja → Meseros → "Restablecer PIN" (también para la
  propia cuenta de caja). El PIN nuevo aparece en una ventana una sola vez.
- **Usuario bloqueado por intentos**: esperar a que venza el bloqueo o
  restablecerle el PIN.
- **Nueva cuenta de caja**: crear la fila en `meseros` con `rol = 'admin'` desde
  el panel de Supabase y luego restablecerle el PIN desde otra cuenta de caja.
- **Desplegar la Edge Function**: `supabase functions deploy login-pin --no-verify-jwt`
  (no exige JWT porque quien llama aún no tiene sesión; la autenticación es el PIN).

## Pendiente / fuera de alcance

Pantalla de cocina (KDS), impresión ESC/POS directa, dividir cuenta o cambiar
mesa, cierre de caja y facturación electrónica DIAN.
