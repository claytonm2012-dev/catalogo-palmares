const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

// Simula o Supabase restrito por cota (HTTP 402 em toda chamada) sem tocar a rede.
// O client do banco chama o fetch global na hora do request, entao basta trocar
// antes de carregar o app.
globalThis.fetch = async () => new Response(
  JSON.stringify({ message: 'Service for this project is restricted due to the following violations: exceed_storage_size_quota.' }),
  { status: 402, headers: { 'content-type': 'application/json' } }
);
const app = require('../app');

test('servidor nao cai e paginas viram 503 quando o Supabase responde 402', async () => {
  const response = await request(app).get('/');
  assert.equal(response.status, 503);
  assert.match(response.text, /temporariamente indisponível/);
  assert.equal(response.headers['cache-control'], 'no-store');
});

test('pagina de produto e admin tambem respondem 503 (sem burlar autenticacao)', async () => {
  for (const url of ['/produto/produto-21806', '/admin/login', '/admin/dashboard']) {
    const response = await request(app).get(url);
    assert.equal(response.status, 503, url);
  }
});

test('pesquisa (JSON) responde 503 em JSON', async () => {
  const response = await request(app).get('/pesquisa?q=21806');
  assert.equal(response.status, 503);
  assert.match(response.headers['content-type'], /json/);
});

test('arquivos estaticos continuam servidos sem o banco', async () => {
  const css = await request(app).get('/css/premium.css');
  assert.equal(css.status, 200);
  const img = await request(app).get('/images/produtos/21806/01.webp');
  assert.equal(img.status, 200);
  assert.match(img.headers['content-type'], /image\/webp/);
});
