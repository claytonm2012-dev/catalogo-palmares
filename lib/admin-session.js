// Sessao do Admin baseada no Supabase Auth: tokens em cookies HttpOnly assinados pelo
// proprio Supabase (JWT), sem estado no servidor (compativel com serverless/Vercel).
// Nenhuma senha ou Service Role Key trafega pelo cookie — so o access/refresh token do
// Supabase Auth, e a role e sempre reconferida na tabela `users` (nao confiamos so no token).
const db = require('../db/database');
const { authClient } = require('./supabase-auth');

const ACCESS_COOKIE = 'sb_admin_at';
const REFRESH_COOKIE = 'sb_admin_rt';
const REFRESH_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30; // 30 dias, renovado a cada uso

function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  });
  return cookies;
}

function cookieOptions(maxAgeMs) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: maxAgeMs,
    path: '/'
  };
}

function setAuthCookies(res, session) {
  const accessMaxAge = 1000 * (session.expires_in || 3600);
  res.cookie(ACCESS_COOKIE, session.access_token, cookieOptions(accessMaxAge));
  res.cookie(REFRESH_COOKIE, session.refresh_token, cookieOptions(REFRESH_MAX_AGE_MS));
}

function clearAuthCookies(res) {
  res.clearCookie(ACCESS_COOKIE, { path: '/' });
  res.clearCookie(REFRESH_COOKIE, { path: '/' });
}

async function resolveAdminProfile(authUser) {
  if (!authUser || !authUser.email) return null;
  const profile = await db.findOne('users', { email: authUser.email });
  if (!profile || profile.role !== 'admin') return null;
  return { id: profile.id, name: profile.name, email: profile.email, role: profile.role };
}

// Le os cookies, valida a sessao Supabase Auth (renovando via refresh token se o access
// token expirou) e confirma que o e-mail corresponde a um perfil com role "admin".
// Retorna o perfil do admin (formato compativel com o antigo req.session.user) ou null.
async function getAdminFromRequest(req, res) {
  const cookies = parseCookies(req);
  const accessToken = cookies[ACCESS_COOKIE];
  const refreshToken = cookies[REFRESH_COOKIE];

  if (accessToken) {
    const { data, error } = await authClient.auth.getUser(accessToken);
    if (!error && data && data.user) {
      return resolveAdminProfile(data.user);
    }
  }

  if (refreshToken) {
    const { data, error } = await authClient.auth.refreshSession({ refresh_token: refreshToken });
    if (!error && data && data.session) {
      setAuthCookies(res, data.session);
      return resolveAdminProfile(data.session.user);
    }
  }

  return null;
}

module.exports = {
  ACCESS_COOKIE, REFRESH_COOKIE,
  parseCookies, setAuthCookies, clearAuthCookies, getAdminFromRequest
};
