const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../app');
const db = require('../db/database');
const request = require('supertest');

const ADMIN_EMAIL = process.env.ADMIN_DEFAULT_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_DEFAULT_PASSWORD;
if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  throw new Error('Defina ADMIN_DEFAULT_EMAIL e ADMIN_DEFAULT_PASSWORD no .env para rodar os testes administrativos');
}

async function loginAgent() {
  const agent = request.agent(app);
  await agent.post('/admin/login').type('form').send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  return agent;
}

async function cleanupProduct(sku) {
  const product = await db.getProductBySku(sku);
  if (product) await db.deleteProduct(product.id);
}

test('Produto: duplicar cria copia inativa com SKU/slug novos e mesmas imagens', async () => {
  const agent = await loginAgent();
  try {
    await agent.post('/admin/products').type('form').send({ name: 'Produto Duplicar', sku: 'DUP-001', slug: '', status: 'active' });
    const original = await db.getProductBySku('DUP-001');

    const dupRes = await agent.post(`/admin/products/${original.id}/duplicate`);
    assert.equal(dupRes.status, 302);

    const copies = await db.list('products', {});
    const copy = copies.find(p => p.sku.startsWith('DUP-001-COPIA-'));
    assert.ok(copy, 'copia deveria existir');
    assert.equal(copy.status, 'inactive');
    assert.notEqual(copy.slug, original.slug);

    await db.deleteProduct(copy.id);
  } finally {
    await cleanupProduct('DUP-001');
  }
});

test('Produto: teste de QR persiste status e timestamp no banco', async () => {
  const agent = await loginAgent();
  try {
    await agent.post('/admin/products').type('form').send({ name: 'Produto QR Status', sku: 'QRSTATUS-001', slug: '', status: 'active' });
    const testRes = await agent.get('/admin/qr-codes/QRSTATUS-001/testar');
    const testJson = testRes.body;
    assert.equal(testJson.testStatus, 'funcionando');

    const refreshed = await db.getProductBySku('QRSTATUS-001');
    assert.equal(refreshed.last_qr_test_status, 'funcionando');
    assert.ok(refreshed.last_qr_test_at);
  } finally {
    await cleanupProduct('QRSTATUS-001');
  }
});

test('Produto: teste de QR detecta produto inativo', async () => {
  const agent = await loginAgent();
  try {
    await agent.post('/admin/products').type('form').send({ name: 'Produto QR Inativo', sku: 'QRINATIVO-001', slug: '', status: 'inactive' });
    const testRes = await agent.get('/admin/qr-codes/QRINATIVO-001/testar');
    assert.equal(testRes.body.testStatus, 'produto_inativo');
    assert.equal(testRes.body.ok, false);
  } finally {
    await cleanupProduct('QRINATIVO-001');
  }
});

test('Categorias: excluir categoria com produtos vinculados exige confirmacao', async () => {
  const agent = await loginAgent();
  try {
    await agent.post('/admin/categories').type('form').send({ name: 'Categoria Guard Test', slug: 'categoria-guard-test', description: '', status: 'active' });
    const category = await db.findOne('categories', { slug: 'categoria-guard-test' });
    await agent.post('/admin/products').type('form').send({ name: 'Produto Guard Test', sku: 'GUARD-001', slug: '', status: 'active', category_id: category.id });

    const blocked = await agent.post(`/admin/categories/${category.id}/delete`).type('form').send({ confirmed: '0' });
    assert.equal(blocked.status, 400);
    const stillThere = await db.findOne('categories', { id: category.id });
    assert.ok(stillThere, 'categoria nao deveria ter sido excluida sem confirmacao');

    const confirmed = await agent.post(`/admin/categories/${category.id}/delete`).type('form').send({ confirmed: '1' });
    assert.equal(confirmed.status, 302);
    const gone = await db.findOne('categories', { id: category.id });
    assert.equal(gone, null);
  } finally {
    await cleanupProduct('GUARD-001');
  }
});

test('Marcas: CRUD completo com website e delete guard', async () => {
  const agent = await loginAgent();
  try {
    await agent.post('/admin/brands').type('form').send({ name: 'Marca CRUD Test', slug: 'marca-crud-test', description: '', status: 'active', website: 'https://marca-teste.com' });
    const brand = await db.findOne('brands', { slug: 'marca-crud-test' });
    assert.ok(brand);
    assert.equal(brand.website, 'https://marca-teste.com');

    await agent.post(`/admin/products`).type('form').send({ name: 'Produto Marca Guard', sku: 'BRANDGUARD-001', slug: '', status: 'active', brand_id: brand.id });

    const blocked = await agent.post(`/admin/brands/${brand.id}/delete`).type('form').send({ confirmed: '0' });
    assert.equal(blocked.status, 400);

    await cleanupProduct('BRANDGUARD-001');
    const confirmed = await agent.post(`/admin/brands/${brand.id}/delete`).type('form').send({ confirmed: '1' });
    assert.equal(confirmed.status, 302);
  } finally {
    await cleanupProduct('BRANDGUARD-001');
  }
});

test('Configuracoes: atualizar settings reflete no site publico (WhatsApp)', async () => {
  const agent = await loginAgent();
  const original = await db.getSettingsMap();
  try {
    await agent.post('/admin/settings').type('form').send({
      whatsapp: '(35) 91234-5678', phone: original.phone, email: original.email,
      site_title: original.site_title, site_url: original.site_url, catalog_url: original.catalog_url,
      instagram_url: '', facebook_url: '', institutional_years: original.institutional_years,
      hero_fallback_title: original.hero_fallback_title, hero_fallback_subtitle: original.hero_fallback_subtitle
    });
    const home = await request(app).get('/');
    assert.match(home.text, /5535912345678/);
  } finally {
    await db.upsertSetting('whatsapp', original.whatsapp);
  }
});

test('Admin: busca e filtro na listagem de produtos', async () => {
  const agent = await loginAgent();
  try {
    await agent.post('/admin/products').type('form').send({ name: 'Produto Filtro Unico XYZ', sku: 'FILTRO-XYZ-001', slug: '', status: 'inactive' });
    const found = await agent.get('/admin/products?q=FILTRO-XYZ&status=inactive');
    assert.match(found.text, /FILTRO-XYZ-001/);
    const notFound = await agent.get('/admin/products?q=FILTRO-XYZ&status=active');
    assert.doesNotMatch(notFound.text, /FILTRO-XYZ-001/);
  } finally {
    await cleanupProduct('FILTRO-XYZ-001');
  }
});

test('Video e documento: cadastrados no produto aparecem na pagina publica', async () => {
  const agent = await loginAgent();
  try {
    await agent.post('/admin/products').type('form').send({ name: 'Produto Midia', sku: 'MIDIA-001', slug: '', status: 'active' });
    const product = await db.getProductBySku('MIDIA-001');
    await agent.post(`/admin/products/${product.id}`).type('form').send({ name: product.name, sku: product.sku, slug: product.slug, status: 'active', video_url: 'https://example.com/teste-midia.mp4' });

    const page = await request(app).get(`/produto/${product.slug}`);
    assert.match(page.text, /teste-midia\.mp4/);
  } finally {
    await cleanupProduct('MIDIA-001');
  }
});
