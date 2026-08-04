// Provisiona (ou atualiza) o usuario do Supabase Auth correspondente ao admin ja
// cadastrado na tabela `users`. Idempotente — seguro rodar de novo. Nao apaga nem
// recria a tabela `users`; so garante que exista uma conta no Supabase Auth com o
// mesmo e-mail/senha para o login administrativo autenticar contra o Supabase Auth.
require('dotenv').config({ quiet: true });
const { createClient } = require('@supabase/supabase-js');
const db = require('../db/database');

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

async function main() {
  const email = process.env.ADMIN_DEFAULT_EMAIL;
  const password = process.env.ADMIN_DEFAULT_PASSWORD;
  if (!email || !password) {
    throw new Error('Defina ADMIN_DEFAULT_EMAIL e ADMIN_DEFAULT_PASSWORD no .env antes de rodar este script.');
  }

  const profile = await db.findOne('users', { email });
  if (!profile) {
    throw new Error(`Nenhum perfil encontrado em 'users' para ${email}. Crie o perfil (com role) antes de rodar este script.`);
  }
  if (profile.role !== 'admin') {
    console.warn(`Aviso: perfil ${email} tem role "${profile.role}", nao "admin" — o login sera bloqueado ate isso ser corrigido na tabela users.`);
  }

  const { data: list, error: listErr } = await supabaseAdmin.auth.admin.listUsers();
  if (listErr) throw listErr;
  const existing = list.users.find(u => u.email === email);

  if (existing) {
    const { error } = await supabaseAdmin.auth.admin.updateUserById(existing.id, {
      password, email_confirm: true, app_metadata: { role: profile.role }
    });
    if (error) throw error;
    console.log(`Usuario do Supabase Auth atualizado: ${email} (id ${existing.id})`);
  } else {
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email, password, email_confirm: true, app_metadata: { role: profile.role }
    });
    if (error) throw error;
    console.log(`Usuario do Supabase Auth criado: ${email} (id ${data.user.id})`);
  }
}

main().then(() => process.exit(0)).catch(err => { console.error('Erro:', err.message || err); process.exit(1); });
