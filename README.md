# LatinSoft Pedidos — Prototipo funcional (MVP)

Prototipo interactivo del MicroSaaS de pedidos para restaurantes descrito en el PRD
"LatinSoft Pedidos (MVP)". Implementa las dos interfaces sobre un mismo estado
compartido en memoria:

- **📱 App del mesero** — login con PIN, mapa de mesas, escaneo simulado de
  productos, carrito con observaciones, envío de pedido y rondas, "Mis pedidos".
- **🖥️ Panel administrativo** — dashboard con kanban en tiempo real, mapa de
  mesas, facturación (servicio, descuento, pago mixto), productos, meseros y
  ventas del día con exportación CSV.

Es un prototipo de **front-end puro**: no hay backend real (PostgreSQL/Supabase),
tal como lo plantea la fase 1 del PRD. El estado vive en memoria (con respaldo
ligero en `localStorage` del navegador) y el botón "Reiniciar demo" lo limpia.

## Cómo verlo

Abre `app.html` directamente en el navegador (doble clic, o `open app.html` /
`start app.html` según tu sistema). No necesita servidor ni build.

Credenciales de demo (visibles también en la pantalla de login):

| Usuario | PIN  |
|---------|------|
| pablo   | 1234 |
| laura   | 2222 |
| andres  | 3333 |

## Estructura

```
latinsoft-pedidos/
├── app.html              # La app completa (HTML + CSS + JS autocontenido)
├── src/
│   └── logic.js           # La lógica de negocio pura, como módulo de Node
│                           # (misma lógica que va incrustada dentro de app.html,
│                           # separada aquí para poder probarla con node)
├── tests/
│   ├── logic.test.js      # 42 pruebas unitarias sobre src/logic.js
│   └── e2e.test.js        # Simula con jsdom un recorrido completo de clics
│                           # reales sobre app.html (login, pedidos, kanban,
│                           # facturación, productos, meseros, ventas)
├── package.json
└── .gitignore
```

## Correr las pruebas

```bash
npm install        # instala jsdom (única dependencia, solo de desarrollo)
npm test           # corre las 42 pruebas de lógica + las 157 del recorrido e2e
```

## Alcance y próximos pasos

Este prototipo cubre las pantallas y reglas del MVP descritas en el PRD. Quedan
fuera (como lo marca el propio documento para fases siguientes): pantalla de
cocina (KDS), impresión ESC/POS directa, dividir cuenta o cambiar mesa, cierre
de caja, y facturación electrónica DIAN.

Preguntas abiertas del PRD que vale la pena resolver antes de construir el
backend real: Code128 vs QR para los productos, si el servicio (propina) es
fijo o configurable por restaurante, si se necesita DIAN desde el día uno,
cuántas mesas/zonas tiene el piloto, si admin y caja son la misma persona, y
el modelo/conexión de la impresora térmica.
