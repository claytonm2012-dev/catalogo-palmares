const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../app');
const db = require('../db/database');
const request = require('supertest');

const ADMIN_EMAIL = 'admin@grupopalmares.com.br';
const ADMIN_PASSWORD = 'Palmares2026!';

async function loginAgent() {
  const agent = request.agent(app);
  await agent.post('/admin/login').type('form').send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  return agent;
}

function cleanupProduct(sku) {
  const product = db.getProductBySku(sku);
  if (product) db.deleteProduct(product.id);
}

test('TESTE 1 e 2: cada produto novo (A e B) tem sua propria URL/QR e abre sua propria pagina', async () => {
  const agent = await loginAgent();
  try {
    await agent.post('/admin/products').type('form').send({ name: 'Produto Auditoria A', sku: 'AUD-A001', slug: '', status: 'active' });
    await agent.post('/admin/products').type('form').send({ name: 'Produto Auditoria B', sku: 'AUD-B001', slug: '', status: 'active' });

    const qrA = await request(app).get('/qr/AUD-A001');
    const qrB = await request(app).get('/qr/AUD-B001');
    assert.equal(qrA.status, 200);
    assert.equal(qrB.status, 200);
    assert.notEqual(qrA.body.url, qrB.body.url);

    const pageA = await request(app).get(new URL(qrA.body.url).pathname);
    const pageB = await request(app).get(new URL(qrB.body.url).pathname);
    assert.equal(pageA.status, 200);
    assert.equal(pageB.status, 200);
    assert.match(pageA.text, /AUD-A001/);
    assert.match(pageB.text, /AUD-B001/);
  } finally {
    cleanupProduct('AUD-A001');
    cleanupProduct('AUD-B001');
  }
});

test('TESTE 3: o QR Code do Produto A nunca abre o Produto B', async () => {
  const agent = await loginAgent();
  try {
    await agent.post('/admin/products').type('form').send({ name: 'Produto Auditoria A', sku: 'AUD-A001', slug: '', status: 'active' });
    await agent.post('/admin/products').type('form').send({ name: 'Produto Auditoria B', sku: 'AUD-B001', slug: '', status: 'active' });

    const qrA = await request(app).get('/qr/AUD-A001');
    const pageA = await request(app).get(new URL(qrA.body.url).pathname);
    // the "related products" section may legitimately reference other SKUs;
    // what must never happen is the page's own identity (title/SKU line) being product B
    assert.match(pageA.text, /<h1>Produto Auditoria A<\/h1>/);
    assert.match(pageA.text, /<strong>SKU:<\/strong> AUD-A001/);
    assert.doesNotMatch(pageA.text, /<strong>SKU:<\/strong> AUD-B001/);
  } finally {
    cleanupProduct('AUD-A001');
    cleanupProduct('AUD-B001');
  }
});

test('TESTE 4: editar descricao/imagens do Produto A preserva o mesmo slug/QR e mostra o conteudo atualizado', async () => {
  const agent = await loginAgent();
  try {
    await agent.post('/admin/products').type('form').send({ name: 'Produto Auditoria A', sku: 'AUD-A001', slug: '', status: 'active' });
    const productBefore = db.getProductBySku('AUD-A001');
    const slugBefore = productBefore.slug;

    await agent.post(`/admin/products/${productBefore.id}`).type('form').send({
      name: 'Produto Auditoria A', sku: 'AUD-A001', slug: slugBefore,
      description: 'Descricao atualizada apos edicao', status: 'active'
    });

    const productAfter = db.getProductBySku('AUD-A001');
    assert.equal(productAfter.slug, slugBefore, 'slug nao deveria mudar quando nao alterado explicitamente');

    const page = await request(app).get(`/produto/${slugBefore}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /Descricao atualizada apos edicao/);
  } finally {
    cleanupProduct('AUD-A001');
  }
});

test('TESTE 5: cadastrar SKU duplicado deve ser bloqueado', async () => {
  const agent = await loginAgent();
  try {
    await agent.post('/admin/products').type('form').send({ name: 'Produto Auditoria A', sku: 'AUD-A001', slug: '', status: 'active' });
    const dup = await agent.post('/admin/products').type('form').send({ name: 'Outro nome', sku: 'AUD-A001', slug: 'outro-slug', status: 'active' });
    assert.equal(dup.status, 400);
    assert.equal(db.list('products', { sku: 'AUD-A001' }).length, 1);
  } finally {
    cleanupProduct('AUD-A001');
  }
});

test('TESTE 6: cadastrar slug duplicado deve ser bloqueado', async () => {
  const agent = await loginAgent();
  try {
    await agent.post('/admin/products').type('form').send({ name: 'Produto Auditoria A', sku: 'AUD-A001', slug: 'slug-auditoria-unico', status: 'active' });
    const dup = await agent.post('/admin/products').type('form').send({ name: 'Produto Auditoria C', sku: 'AUD-C001', slug: 'slug-auditoria-unico', status: 'active' });
    assert.equal(dup.status, 400);
    assert.equal(db.list('products', { slug: 'slug-auditoria-unico' }).length, 1);
  } finally {
    cleanupProduct('AUD-A001');
    cleanupProduct('AUD-C001');
  }
});

test('TESTE 7: acessar SKU/slug inexistente exibe 404 amigavel', async () => {
  const pageRes = await request(app).get('/produto/sku-que-nao-existe-jamais');
  assert.equal(pageRes.status, 404);
  assert.match(pageRes.text, /não encontrad/i);

  const qrRes = await request(app).get('/qr/SKU-INEXISTENTE-000');
  assert.equal(qrRes.status, 404);
});

test('TESTE 8: desativar produto exibe pagina informativa sem quebrar a aplicacao', async () => {
  const agent = await loginAgent();
  try {
    await agent.post('/admin/products').type('form').send({ name: 'Produto Auditoria A', sku: 'AUD-A001', slug: '', status: 'active' });
    const product = db.getProductBySku('AUD-A001');

    await agent.post(`/admin/products/${product.id}`).type('form').send({ name: 'Produto Auditoria A', sku: 'AUD-A001', slug: product.slug, status: 'inactive' });

    const page = await request(app).get(`/produto/${product.slug}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /indisponível/i);
  } finally {
    cleanupProduct('AUD-A001');
  }
});

test('TESTE 9: geracao em lote — cada QR do painel admin aponta para o produto correto', async () => {
  const agent = await loginAgent();
  try {
    await agent.post('/admin/products').type('form').send({ name: 'Produto Auditoria A', sku: 'AUD-A001', slug: '', status: 'active' });
    await agent.post('/admin/products').type('form').send({ name: 'Produto Auditoria B', sku: 'AUD-B001', slug: '', status: 'active' });

    const panel = await agent.get('/admin/qr-codes');
    assert.equal(panel.status, 200);
    const productA = db.getProductBySku('AUD-A001');
    const productB = db.getProductBySku('AUD-B001');
    assert.match(panel.text, new RegExp(`produto/${productA.slug}`));
    assert.match(panel.text, new RegExp(`produto/${productB.slug}`));

    const csv = await agent.get('/admin/qr-codes/export.csv');
    assert.equal(csv.status, 200);
    assert.match(csv.text, /AUD-A001/);
    assert.match(csv.text, /AUD-B001/);
  } finally {
    cleanupProduct('AUD-A001');
    cleanupProduct('AUD-B001');
  }
});

test('TESTE 10: nenhum QR Code final gerado contem localhost quando PUBLIC_SITE_URL/catalog_url estao configurados', async () => {
  const qr = await request(app).get('/qr/DEMO-001');
  assert.equal(qr.status, 200);
  assert.doesNotMatch(qr.body.url, /localhost/);

  process.env.PUBLIC_SITE_URL = 'https://catalogo.grupopalmares.com.br';
  const qrWithEnv = await request(app).get('/qr/DEMO-001');
  assert.doesNotMatch(qrWithEnv.body.url, /localhost/);
  assert.match(qrWithEnv.body.url, /^https:\/\/catalogo\.grupopalmares\.com\.br\/produto\//);
  delete process.env.PUBLIC_SITE_URL;
});

test('Redirecionamento permanente: alterar slug de produto com QR ja impresso redireciona a URL antiga', async () => {
  const agent = await loginAgent();
  try {
    await agent.post('/admin/products').type('form').send({ name: 'Produto Auditoria A', sku: 'AUD-A001', slug: 'slug-original-impresso', status: 'active' });
    const product = db.getProductBySku('AUD-A001');

    await agent.post(`/admin/products/${product.id}`).type('form').send({ name: 'Produto Auditoria A', sku: 'AUD-A001', slug: 'slug-novo-apos-edicao', status: 'active' });

    const oldUrlRes = await request(app).get('/produto/slug-original-impresso');
    assert.equal(oldUrlRes.status, 301);
    assert.equal(oldUrlRes.headers.location, '/produto/slug-novo-apos-edicao');

    const newUrlRes = await request(app).get('/produto/slug-novo-apos-edicao');
    assert.equal(newUrlRes.status, 200);
    assert.match(newUrlRes.text, /AUD-A001/);
  } finally {
    cleanupProduct('AUD-A001');
  }
});
