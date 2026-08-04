// Cliente Supabase Auth do lado do servidor, usando a chave publica (anon/publishable) —
// nunca a Service Role Key. So faz login/refresh/logout; leitura e escrita de dados
// continuam via db/database.js (Service Role, nunca chega ao navegador).
require('dotenv').config({ quiet: true });
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_PUBLISHABLE_KEY;

if (!supabaseUrl || !anonKey) {
  throw new Error('SUPABASE_URL e SUPABASE_PUBLISHABLE_KEY precisam estar definidos (.env) para o login do Admin');
}

const authClient = createClient(supabaseUrl, anonKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

module.exports = { authClient };
