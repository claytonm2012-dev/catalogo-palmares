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

async function cleanupCategory(slug) {
  const category = await db.findOne('categories', { slug });
  if (category) await db.deleteCategory(category.id);
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
    await cleanupProduct('AUD-A001');
    await cleanupProduct('AUD-B001');
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
    await cleanupProduct('AUD-A001');
    await cleanupProduct('AUD-B001');
  }
});

test('TESTE 4: editar descricao/imagens do Produto A preserva o mesmo slug/QR e mostra o conteudo atualizado', async () => {
  const agent = await loginAgent();
  try {
    await agent.post('/admin/products').type('form').send({ name: 'Produto Auditoria A', sku: 'AUD-A001', slug: '', status: 'active' });
    const productBefore = await db.getProductBySku('AUD-A001');
    const slugBefore = productBefore.slug;

    await agent.post(`/admin/products/${productBefore.id}`).type('form').send({
      name: 'Produto Auditoria A', sku: 'AUD-A001', slug: slugBefore,
      description: 'Descricao atualizada apos edicao', status: 'active'
    });

    const productAfter = await db.getProductBySku('AUD-A001');
    assert.equal(productAfter.slug, slugBefore, 'slug nao deveria mudar quando nao alterado explicitamente');

    const page = await request(app).get(`/produto/${slugBefore}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /Descricao atualizada apos edicao/);
  } finally {
    await cleanupProduct('AUD-A001');
  }
});

test('TESTE 5: cadastrar SKU duplicado deve ser bloqueado', async () => {
  const agent = await loginAgent();
  try {
    await agent.post('/admin/products').type('form').send({ name: 'Produto Auditoria A', sku: 'AUD-A001', slug: '', status: 'active' });
    const dup = await agent.post('/admin/products').type('form').send({ name: 'Outro nome', sku: 'AUD-A001', slug: 'outro-slug', status: 'active' });
    assert.equal(dup.status, 400);
    assert.equal((await db.list('products', { sku: 'AUD-A001' })).length, 1);
  } finally {
    await cleanupProduct('AUD-A001');
  }
});

test('TESTE 6: cadastrar slug duplicado deve ser bloqueado', async () => {
  const agent = await loginAgent();
  try {
    await agent.post('/admin/products').type('form').send({ name: 'Produto Auditoria A', sku: 'AUD-A001', slug: 'slug-auditoria-unico', status: 'active' });
    const dup = await agent.post('/admin/products').type('form').send({ name: 'Produto Auditoria C', sku: 'AUD-C001', slug: 'slug-auditoria-unico', status: 'active' });
    assert.equal(dup.status, 400);
    assert.equal((await db.list('products', { slug: 'slug-auditoria-unico' })).length, 1);
  } finally {
    await cleanupProduct('AUD-A001');
    await cleanupProduct('AUD-C001');
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
    const product = await db.getProductBySku('AUD-A001');

    await agent.post(`/admin/products/${product.id}`).type('form').send({ name: 'Produto Auditoria A', sku: 'AUD-A001', slug: product.slug, status: 'inactive' });

    const page = await request(app).get(`/produto/${product.slug}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /indisponível/i);
  } finally {
    await cleanupProduct('AUD-A001');
  }
});

test('TESTE 9: geracao em lote — cada QR do painel admin aponta para o produto correto', async () => {
  const agent = await loginAgent();
  try {
    await agent.post('/admin/products').type('form').send({ name: 'Produto Auditoria A', sku: 'AUD-A001', slug: '', status: 'active' });
    await agent.post('/admin/products').type('form').send({ name: 'Produto Auditoria B', sku: 'AUD-B001', slug: '', status: 'active' });

    const panel = await agent.get('/admin/qr-codes');
    assert.equal(panel.status, 200);
    const productA = await db.getProductBySku('AUD-A001');
    const productB = await db.getProductBySku('AUD-B001');
    assert.match(panel.text, new RegExp(`produto/${productA.slug}`));
    assert.match(panel.text, new RegExp(`produto/${productB.slug}`));

    const csv = await agent.get('/admin/qr-codes/export.csv');
    assert.equal(csv.status, 200);
    assert.match(csv.text, /AUD-A001/);
    assert.match(csv.text, /AUD-B001/);
  } finally {
    await cleanupProduct('AUD-A001');
    await cleanupProduct('AUD-B001');
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
    const product = await db.getProductBySku('AUD-A001');

    await agent.post(`/admin/products/${product.id}`).type('form').send({ name: 'Produto Auditoria A', sku: 'AUD-A001', slug: 'slug-novo-apos-edicao', status: 'active' });

    const oldUrlRes = await request(app).get('/produto/slug-original-impresso');
    assert.equal(oldUrlRes.status, 301);
    assert.equal(oldUrlRes.headers.location, '/produto/slug-novo-apos-edicao');

    const newUrlRes = await request(app).get('/produto/slug-novo-apos-edicao');
    assert.equal(newUrlRes.status, 200);
    assert.match(newUrlRes.text, /AUD-A001/);
  } finally {
    await cleanupProduct('AUD-A001');
  }
});

test('Autenticacao: login com senha errada falha e nao cria sessao', async () => {
  const res = await request(app).post('/admin/login').type('form').send({ email: ADMIN_EMAIL, password: 'senha-errada' });
  assert.equal(res.status, 401);

  const agent = request.agent(app);
  await agent.post('/admin/login').type('form').send({ email: ADMIN_EMAIL, password: 'senha-errada' });
  const dashboard = await agent.get('/admin/dashboard');
  assert.equal(dashboard.status, 302);
  assert.match(dashboard.headers.location, /\/admin\/login/);
});

test('Autenticacao: sem login, rotas /admin redirecionam para login', async () => {
  const res = await request(app).get('/admin/products');
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /\/admin\/login/);
});

test('CRUD de categorias: criar, editar e excluir uma categoria', async () => {
  const agent = await loginAgent();
  try {
    await agent.post('/admin/categories').type('form').send({ name: 'Categoria Auditoria', slug: 'categoria-auditoria', description: 'teste', status: 'active' });
    let category = await db.findOne('categories', { slug: 'categoria-auditoria' });
    assert.ok(category, 'categoria deveria ter sido criada');

    await agent.post(`/admin/categories/${category.id}`).type('form').send({ name: 'Categoria Auditoria Editada', slug: 'categoria-auditoria', description: 'teste editado', status: 'active' });
    category = await db.findOne('categories', { id: category.id });
    assert.equal(category.name, 'Categoria Auditoria Editada');

    await agent.post(`/admin/categories/${category.id}/delete`);
    const afterDelete = await db.findOne('categories', { id: category.id });
    assert.equal(afterDelete, null);
  } finally {
    await cleanupCategory('categoria-auditoria');
  }
});

test('Upload de imagem: cadastrar produto com foto principal envia para o Supabase Storage', async () => {
  const agent = await loginAgent();
  // 1x1 transparent PNG
  const pngBuffer = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  try {
    await agent.post('/admin/products')
      .field('name', 'Produto Auditoria Upload')
      .field('sku', 'AUD-UP001')
      .field('slug', '')
      .field('status', 'active')
      .attach('main_image_file', pngBuffer, 'foto.png');

    const product = await db.getProductBySku('AUD-UP001');
    assert.ok(product, 'produto deveria ter sido criado');
    assert.ok(product.main_image, 'main_image deveria estar preenchido');
    assert.match(product.main_image, /supabase\.co\/storage\/v1\/object\/public\/product-images\//);

    const objectPath = product.main_image.split('/product-images/')[1];
    const folder = objectPath.substring(0, objectPath.lastIndexOf('/'));
    const filename = objectPath.substring(objectPath.lastIndexOf('/') + 1);
    const { data: listing, error: listError } = await db.supabase.storage.from('product-images').list(folder, { search: filename });
    assert.equal(listError, null);
    assert.ok(listing.some(f => f.name === filename), 'arquivo deveria existir no bucket product-images');
  } finally {
    const product = await db.getProductBySku('AUD-UP001');
    if (product && product.main_image) {
      const { removeFromStorage } = require('../lib/upload');
      await removeFromStorage(product.main_image);
    }
    await cleanupProduct('AUD-UP001');
  }
});
