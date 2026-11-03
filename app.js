const express = require('express');
const path = require('path');
const database = require('./db/database');
const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');
const { cardThumb } = require('./lib/image-url');

const app = express();
const PORT = process.env.PORT || 3000;
app.disable('x-powered-by');

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
// CSS/JS ja usam query string de versao (?v=4.x) pra invalidar cache quando o
// conteudo muda, entao um maxAge generoso aqui e seguro (nao serve conteudo velho).
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1d' }));

app.use(async (req, res, next) => {
  try {
    await database.ensureReady();
    const settings = await database.getSettingsMap();
    res.locals.settings = settings;
    const digits = (settings.whatsapp || '').replace(/\D/g, '');
    res.locals.whatsappDigits = digits ? (digits.startsWith('55') ? digits : `55${digits}`) : '5535991710177';
    res.locals.cardThumb = cardThumb;
    next();
  } catch (err) {
    next(err);
  }
});

app.use('/', publicRoutes);
app.use('/admin', adminRoutes);

app.use((req, res) => {
  res.status(404).render('public/404', { title: 'Página não encontrada' });
});

// Erro do banco por indisponibilidade do Supabase (projeto restrito/fora do ar),
// e nao por bug do app: vira 503 com pagina propria, sem cache na CDN.
const OUTAGE_MESSAGE = /service for this project is restricted|exceed_\w+_quota|fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN/i;
function isDatabaseUnavailable(err) {
  if (database.getOutage()) return true;
  return !!err && OUTAGE_MESSAGE.test(`${err.message || ''} ${err.details || ''}`);
}

app.use((err, req, res, next) => {
  if (isDatabaseUnavailable(err)) {
    const outage = database.getOutage();
    console.error(`[db] Supabase indisponível${outage ? ` (HTTP ${outage.status})` : ''} em ${req.method} ${req.originalUrl}`);
    res.set('Cache-Control', 'no-store');
    res.set('Retry-After', '300');
    if (req.path === '/pesquisa' || !req.accepts('html')) {
      return res.status(503).json({ error: 'Catálogo temporariamente indisponível. Tente novamente em alguns minutos.' });
    }
    return res.status(503).render('public/unavailable', { title: 'Catálogo temporariamente indisponível' });
  }
  console.error(err);
  if (err && err.code === '23505') {
    return res.status(409).send('Já existe um registro com esse valor único (SKU/slug/e-mail duplicado).');
  }
  res.status(500).send('Erro interno do servidor.');
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Servidor rodando em http://localhost:${PORT}`);
  });
}

module.exports = app;
