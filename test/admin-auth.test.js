const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../app');
const db = require('../db/database');
const request = require('supertest');
const { createClient } = require('@supabase/supabase-js');

const ADMIN_EMAIL = process.env.ADMIN_DEFAULT_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_DEFAULT_PASSWORD;
if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  throw new Error('Defina ADMIN_DEFAULT_EMAIL e ADMIN_DEFAULT_PASSWORD no .env para rodar os testes de autenticacao');
}

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

test('Login: credenciais corretas autenticam e redirecionam pro dashboard', async () => {
  const res = await request(app).post('/admin/login').type('form').send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/admin/dashboard');
  assert.ok(res.headers['set-cookie'].some(c => c.startsWith('sb_admin_at=')), 'deveria setar cookie de access token');
  assert.ok(res.headers['set-cookie'].some(c => c.startsWith('sb_admin_rt=')), 'deveria setar cookie de refresh token');
});

test('Login: senha incorreta e rejeitada com mensagem em portugues, sem cookie', async () => {
  const res = await request(app).post('/admin/login').type('form').send({ email: ADMIN_EMAIL, password: 'senha-errada-123' });
  assert.equal(res.status, 401);
  assert.match(res.text, /Credenciais inválidas/);
  assert.equal(res.headers['set-cookie'], undefined);
});

test('Login: usuario valido no Supabase Auth mas sem role admin e bloqueado', async () => {
  const email = 'sem-permissao-teste@grupopalmares.com';
  const password = 'SenhaTeste123!';
  await db.create('users', { name: 'Sem Permissao Teste', email, password: 'n/a', role: 'viewer' });
  const { data: created } = await supabaseAdmin.auth.admin.createUser({ email, password, email_confirm: true, app_metadata: { role: 'viewer' } });
  try {
    const res = await request(app).post('/admin/login').type('form').send({ email, password });
    assert.equal(res.status, 403);
    assert.match(res.text, /não tem permissão de administrador/);
  } finally {
    await supabaseAdmin.auth.admin.deleteUser(created.user.id);
    await db.remove('users', (await db.findOne('users', { email })).id);
  }
});

test('Acesso direto: rota /admin/* sem cookie redireciona para /admin/login', async () => {
  const res = await request(app).get('/admin/products');
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /\/admin\/login/);
});

test('Sessao persiste apos "atualizar a pagina" (nova requisicao com o mesmo cookie)', async () => {
  const agent = request.agent(app);
  await agent.post('/admin/login').type('form').send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  const firstLoad = await agent.get('/admin/dashboard');
  assert.equal(firstLoad.status, 200);
  const reload = await agent.get('/admin/dashboard');
  assert.equal(reload.status, 200);
  assert.match(reload.text, /Bem-vindo, Administrador\./);
});

test('Sessao invalida/expirada: cookies corrompidos redirecionam para login', async () => {
  const res = await request(app)
    .get('/admin/dashboard')
    .set('Cookie', ['sb_admin_at=token-corrompido-invalido', 'sb_admin_rt=refresh-tambem-invalido']);
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /\/admin\/login/);
});

test('Logout: limpa a sessao e bloqueia acesso as rotas admin depois', async () => {
  const agent = request.agent(app);
  await agent.post('/admin/login').type('form').send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  const beforeLogout = await agent.get('/admin/dashboard');
  assert.equal(beforeLogout.status, 200);

  const logoutRes = await agent.get('/admin/logout');
  assert.equal(logoutRes.status, 302);
  assert.match(logoutRes.headers.location, /\/admin\/login/);

  const afterLogout = await agent.get('/admin/dashboard');
  assert.equal(afterLogout.status, 302);
  assert.match(afterLogout.headers.location, /\/admin\/login/);
});

test('Ja logado: acessar /admin/login redireciona direto pro dashboard', async () => {
  const agent = request.agent(app);
  await agent.post('/admin/login').type('form').send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  const res = await agent.get('/admin/login');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/admin/dashboard');
});
