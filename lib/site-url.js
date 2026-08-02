const db = require('../db/database');

function getPublicSiteUrl() {
  const envUrl = process.env.PUBLIC_SITE_URL;
  if (envUrl) return envUrl.replace(/\/+$/, '');

  const setting = db.findOne('settings', { key: 'catalog_url' });
  if (setting && setting.value) return setting.value.replace(/\/+$/, '');

  if (process.env.NODE_ENV === 'production') {
    console.warn('[site-url] PUBLIC_SITE_URL não definida em produção — usando localhost. Configure a variável de ambiente antes de gerar QR Codes definitivos.');
  }
  return `http://localhost:${process.env.PORT || 3000}`;
}

module.exports = { getPublicSiteUrl };
