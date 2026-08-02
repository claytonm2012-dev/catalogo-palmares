const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../app');
const request = require('supertest');

test('rota inicial responde com sucesso', async () => {
  const response = await request(app).get('/');
  assert.equal(response.status, 200);
});

test('login administrativo responde', async () => {
  const response = await request(app).get('/admin/login');
  assert.equal(response.status, 200);
});

test('produto inexistente retorna 404', async () => {
  const response = await request(app).get('/produto/nao-existe');
  assert.equal(response.status, 404);
});
