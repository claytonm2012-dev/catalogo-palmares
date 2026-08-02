Catálogo Virtual — Grupo Palmares

Instruções rápidas:

1. Instalar dependências: `npm install`
2. Iniciar servidor: `npm start`
3. Acesse: http://localhost:3000

Melhorias visuais implementadas:
- Grid Scan inspired canvas in hero (public/css/animations.css + public/js/animations.js)
- Card hover, badge, scroll reveal and QR highlight
- Product page gallery area with QR interaction

Notes:
- Prefer `prefers-reduced-motion` honored.
- QR endpoint `/qr/:sku` returns PNG when requested as image, or JSON when fetched.
