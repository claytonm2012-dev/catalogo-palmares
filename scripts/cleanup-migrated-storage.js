// Limpeza segura do bucket product-images: remove do Supabase Storage SOMENTE os
// PNGs originais dos 77 produtos ja migrados para public/images/produtos (ver
// migrate-storage-to-local.js), depois de provar arquivo a arquivo que nada mais
// depende deles e que existe backup integro fora do Supabase.
//
// Modos (rodar nesta ordem; so "delete" e "restore" escrevem no Supabase):
//   node scripts/cleanup-migrated-storage.js preflight      1 chamada: o Supabase responde?
//   node scripts/cleanup-migrated-storage.js backup         baixa os PNGs originais para BACKUP_DIR
//   node scripts/cleanup-migrated-storage.js verify-backup  confere sha256 + decodificacao do backup
//   node scripts/cleanup-migrated-storage.js audit          dump do banco + classifica cada arquivo (A/B/C/D)
//   node scripts/cleanup-migrated-storage.js delete --confirm [--batch-size 25]
//        apaga UM lote da categoria A (via API oficial do Storage), revalida as
//        paginas dos produtos afetados em producao e para no primeiro problema
//   node scripts/cleanup-migrated-storage.js restore --confirm  reenvia ao Storage tudo que foi apagado
//
// O backup fica fora do repositorio e fora de public/ (padrao:
// ../auditoria-supabase-2026-10-13/originais, ou CLEANUP_BACKUP_DIR).
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const { createClient } = require('@supabase/supabase-js');

const ROOT = path.join(__dirname, '..');
const BUCKET = 'product-images';
const BASE_URL = (process.env.MIGRATION_BASE_URL || 'https://catalogo-palmares.vercel.app').replace(/\/$/, '');
const AUDIT_DIR = path.resolve(process.env.CLEANUP_AUDIT_DIR || path.join(ROOT, '..', 'auditoria-supabase-2026-10-13'));
const BACKUP_DIR = path.resolve(process.env.CLEANUP_BACKUP_DIR || path.join(AUDIT_DIR, 'originais'));
const BACKUP_MANIFEST = path.join(BACKUP_DIR, 'backup-manifest.json');
const PLAN_FILE = path.join(AUDIT_DIR, 'cleanup-plan.json');
const DELETION_LOG = path.join(AUDIT_DIR, 'deletion-log.json');
const PLAN_MAX_AGE_MS = 60 * 60 * 1000;
const DB_TABLES = ['products', 'product_images', 'product_videos', 'product_documents', 'categories', 'brands', 'collections', 'settings', 'product_redirects'];

const migrationReport = JSON.parse(fs.readFileSync(path.join(ROOT, 'storage-migration-report.json'), 'utf8'));
const filesBefore = JSON.parse(fs.readFileSync(path.join(ROOT, 'storage-files-before-migration.json'), 'utf8'));
const sizeByPath = new Map(filesBefore.files.map(f => [f.path, f.size]));
const objectPathOf = url => url.split(`/object/public/${BUCKET}/`)[1];
// Uma linha por PNG original migrado (385): caminho no bucket + URL nova + registro do banco.
const CANDIDATES = migrationReport.images_detail.map(img => ({
  path: objectPathOf(img.old_url), sku: img.sku, product_id: img.product_id, kind: img.kind,
  product_image_id: img.product_image_id, old_url: img.old_url, new_url: img.new_url,
  size: sizeByPath.get(objectPathOf(img.old_url)), original_size: img.original_size
}));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const readJson = (file, fallback) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback);
const writeJson = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 1)); };
const backupPathFor = objectPath => path.join(BACKUP_DIR, ...objectPath.split('/'));

async function mapWithConcurrency(items, limit, fn) {
  let index = 0;
  const results = new Array(items.length);
  async function worker() {
    while (index < items.length) {
      const current = index++;
      results[current] = await fn(items[current], current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Sem retentativas: se o projeto estiver restrito (HTTP 402) para aqui.
async function preflight() {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/settings?select=id&limit=1`, {
    headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` }
  });
  const body = (await res.text()).slice(0, 200);
  if (res.status !== 200) throw new Error(`Supabase respondeu HTTP ${res.status}: ${body} — nada foi feito.`);
  console.log('Supabase acessivel (HTTP 200).');
}

// PNG valido = tamanho igual ao registrado no bucket antes da migracao,
// decodifica inteiro e tem as dimensoes registradas no relatorio da conversao.
async function checkOriginal(buf, c) {
  if (buf.length !== c.size) throw new Error(`${c.path}: ${buf.length} bytes, esperado ${c.size}`);
  const meta = await sharp(buf).metadata();
  await sharp(buf).stats();
  if (`${meta.width}x${meta.height}` !== c.original_size) throw new Error(`${c.path}: ${meta.width}x${meta.height}, esperado ${c.original_size}`);
}

async function backup() {
  await preflight();
  const manifest = readJson(BACKUP_MANIFEST, { bucket: BUCKET, files: {} });
  const failures = [];
  await mapWithConcurrency(CANDIDATES, 4, async c => {
    const dest = backupPathFor(c.path);
    const known = manifest.files[c.path];
    if (known && fs.existsSync(dest) && sha256(fs.readFileSync(dest)) === known.sha256) return;
    try {
      const { data, error } = await supabase.storage.from(BUCKET).download(c.path);
      if (error) throw error;
      const buf = Buffer.from(await data.arrayBuffer());
      await checkOriginal(buf, c);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
      manifest.files[c.path] = { sku: c.sku, product_id: c.product_id, size: buf.length, sha256: sha256(buf), dimensions: c.original_size, old_url: c.old_url, new_url: c.new_url, saved_at: new Date().toISOString() };
    } catch (err) {
      failures.push(`${c.path}: ${err.message || err}`);
    }
  });
  manifest.updated_at = new Date().toISOString();
  writeJson(BACKUP_MANIFEST, manifest);
  console.log(`Backup: ${Object.keys(manifest.files).length}/${CANDIDATES.length} arquivos em ${BACKUP_DIR}`);
  failures.forEach(f => console.log('FALHA', f));
  if (failures.length) process.exitCode = 1;
}

async function verifyBackupFiles() {
  const manifest = readJson(BACKUP_MANIFEST, { files: {} });
  const ok = new Set();
  const failures = [];
  await mapWithConcurrency(CANDIDATES, 8, async c => {
    try {
      const entry = manifest.files[c.path];
      if (!entry) throw new Error('fora do manifesto de backup');
      const buf = fs.readFileSync(backupPathFor(c.path));
      if (sha256(buf) !== entry.sha256) throw new Error('sha256 diverge do manifesto');
      await checkOriginal(buf, c);
      ok.add(c.path);
    } catch (err) {
      failures.push(`${c.path}: ${err.message || err}`);
    }
  });
  return { ok, failures };
}

async function verifyBackup() {
  const { ok, failures } = await verifyBackupFiles();
  console.log(`Backup integro: ${ok.size}/${CANDIDATES.length}`);
  failures.forEach(f => console.log('FALHA', f));
  if (failures.length) process.exitCode = 1;
}

async function selectAll(table) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from(table).select('*').order('id').range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...data);
    if (data.length < 1000) break;
  }
  return rows;
}

async function listBucket(prefix = '') {
  const files = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase.storage.from(BUCKET).list(prefix, { limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } });
    if (error) throw error;
    for (const o of data) {
      const p = prefix ? `${prefix}/${o.name}` : o.name;
      if (o.id === null) files.push(...await listBucket(p));
      else files.push({ path: p, size: o.metadata && o.metadata.size });
    }
    if (data.length < 1000) break;
  }
  return files;
}

// Todas as linhas de todas as tabelas que guardam URLs, serializadas: um caminho
// do bucket que aparece em qualquer coluna conta como referencia ativa.
function referenceIndex(dump) {
  const refs = new Map();
  for (const table of DB_TABLES) {
    for (const row of dump[table]) {
      const text = JSON.stringify(row);
      let i = text.indexOf(`/${BUCKET}/`);
      while (i !== -1) {
        const p = text.slice(i + BUCKET.length + 2).split(/["?\\\s]/)[0];
        if (!refs.has(p)) refs.set(p, []);
        refs.get(p).push(`${table}#${row.id}`);
        i = text.indexOf(`/${BUCKET}/`, i + 1);
      }
    }
  }
  return refs;
}

async function checkProduction(c) {
  const res = await fetch(BASE_URL + c.new_url);
  const buf = Buffer.from(await res.arrayBuffer());
  if (res.status !== 200 || !/image\/webp/.test(res.headers.get('content-type') || '')) throw new Error(`producao ${res.status} ${res.headers.get('content-type')}`);
  const local = fs.readFileSync(path.join(ROOT, 'public', c.new_url.replace(/^\//, '')));
  if (sha256(local) !== sha256(buf)) throw new Error('arquivo em producao difere do repositorio');
  await sharp(buf).stats();
}

async function audit() {
  await preflight();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dump = {};
  for (const table of DB_TABLES) dump[table] = await selectAll(table);
  const dumpFile = path.join(AUDIT_DIR, `db-dump-${stamp}.json`);
  writeJson(dumpFile, { generated_at: new Date().toISOString(), tables: dump });

  const bucket = await listBucket();
  const bucketByPath = new Map(bucket.map(f => [f.path, f]));
  const refs = referenceIndex(dump);
  const products = new Map(dump.products.map(p => [p.id, p]));
  const images = new Map(dump.product_images.map(i => [i.id, i]));
  const { ok: backupOk } = await verifyBackupFiles();
  const candidateByPath = new Map(CANDIDATES.map(c => [c.path, c]));

  const prodResults = new Map();
  await mapWithConcurrency(CANDIDATES, 8, async c => {
    try { await checkProduction(c); prodResults.set(c.path, null); } catch (err) { prodResults.set(c.path, err.message); }
  });

  const classified = bucket.map(file => {
    const c = candidateByPath.get(file.path);
    const usedBy = refs.get(file.path) || [];
    if (!c) return { ...file, category: usedBy.length ? 'C' : 'D', used_by: usedBy };
    const pending = [];
    const dbValue = c.kind === 'main' ? products.get(c.product_id)?.main_image : images.get(c.product_image_id)?.url;
    if (dbValue !== c.new_url) pending.push(`banco aponta para ${dbValue === undefined ? '(registro ausente)' : dbValue}`);
    if (usedBy.length) pending.push(`URL antiga ainda referenciada em ${usedBy.join(', ')}`);
    if (prodResults.get(c.path)) pending.push(prodResults.get(c.path));
    if (!backupOk.has(c.path)) pending.push('sem backup integro');
    if (file.size !== c.size) pending.push(`tamanho no bucket ${file.size} != ${c.size}`);
    return { ...file, sku: c.sku, product_id: c.product_id, old_url: c.old_url, new_url: c.new_url, category: pending.length ? (usedBy.length ? 'C' : 'B') : 'A', pending, used_by: usedBy };
  });
  CANDIDATES.filter(c => !bucketByPath.has(c.path)).forEach(c => classified.push({ path: c.path, category: 'ja-removido' }));

  const sum = cat => classified.filter(f => f.category === cat).reduce((s, f) => s + (f.size || 0), 0);
  const count = cat => classified.filter(f => f.category === cat).length;
  const totalBytes = bucket.reduce((s, f) => s + (f.size || 0), 0);
  const plan = {
    generated_at: new Date().toISOString(), db_dump: dumpFile, bucket_files: bucket.length, bucket_bytes: totalBytes,
    totals: Object.fromEntries(['A', 'B', 'C', 'D', 'ja-removido'].map(k => [k, { files: count(k), bytes: sum(k) }])),
    bytes_after_cleanup: totalBytes - sum('A'),
    files: classified
  };
  writeJson(PLAN_FILE, plan);
  const mb = b => (b / 1e6).toFixed(1);
  console.log(`Bucket: ${bucket.length} arquivos, ${mb(totalBytes)} MB. Dump do banco: ${dumpFile}`);
  for (const [k, v] of Object.entries(plan.totals)) console.log(`  ${k}: ${v.files} arquivos, ${mb(v.bytes)} MB`);
  console.log(`Apos limpar a categoria A: ${mb(plan.bytes_after_cleanup)} MB. Plano: ${PLAN_FILE}`);
  classified.filter(f => f.pending && f.pending.length).slice(0, 20).forEach(f => console.log('PENDENTE', f.path, '-', f.pending.join('; ')));
}

// Pagina publica de cada produto afetado: 200 e toda imagem dela acessivel, sem
// nenhuma referencia aos caminhos recem-apagados.
async function checkProductPages(slugs, deletedPaths) {
  const problems = [];
  for (const slug of slugs) {
    const res = await fetch(`${BASE_URL}/produto/${slug}`);
    const html = await res.text();
    if (res.status !== 200) { problems.push(`/produto/${slug} -> ${res.status}`); continue; }
    deletedPaths.forEach(p => { if (html.includes(p)) problems.push(`/produto/${slug} ainda referencia ${p}`); });
    const srcs = [...new Set([...html.matchAll(/(?:src|href|data-src)="([^"]+\.(?:webp|png|jpe?g))"/gi)].map(m => m[1]))];
    await mapWithConcurrency(srcs, 6, async src => {
      const url = src.startsWith('http') ? src : BASE_URL + src;
      const r = await fetch(url, { method: 'HEAD' });
      if (r.status !== 200) problems.push(`/produto/${slug}: ${src} -> ${r.status}`);
    });
  }
  return problems;
}

async function deleteBatch() {
  if (!process.argv.includes('--confirm')) throw new Error('Exclusao exige --confirm (e autorizacao expressa da lista).');
  const sizeArg = process.argv.indexOf('--batch-size');
  const batchSize = sizeArg !== -1 ? Number(process.argv[sizeArg + 1]) : 25;
  if (!(batchSize > 0 && batchSize <= 50)) throw new Error('--batch-size deve estar entre 1 e 50.');
  await preflight();
  const plan = readJson(PLAN_FILE, null);
  if (!plan || Date.now() - Date.parse(plan.generated_at) > PLAN_MAX_AGE_MS) throw new Error('Plano ausente ou com mais de 1h — rode "audit" de novo.');
  const log = readJson(DELETION_LOG, { batches: [] });
  const done = new Set(log.batches.flatMap(b => b.paths));
  const batch = plan.files.filter(f => f.category === 'A' && !done.has(f.path)).slice(0, batchSize);
  if (!batch.length) return console.log('Nenhum arquivo categoria A pendente.');

  // Revalida o lote contra o estado atual do banco logo antes de apagar.
  const { ok: backupOk } = await verifyBackupFiles();
  const productIds = [...new Set(batch.map(f => f.product_id))];
  const { data: prods, error: pErr } = await supabase.from('products').select('*').in('id', productIds);
  if (pErr) throw pErr;
  const { data: imgs, error: iErr } = await supabase.from('product_images').select('*').in('product_id', productIds);
  if (iErr) throw iErr;
  const freshText = JSON.stringify([prods, imgs]);
  const blocked = batch.filter(f => !backupOk.has(f.path) || freshText.includes(f.path));
  if (blocked.length) throw new Error(`Lote abortado, ainda referenciado ou sem backup: ${blocked.map(f => f.path).join(', ')}`);

  const paths = batch.map(f => f.path);
  const { data: removed, error } = await supabase.storage.from(BUCKET).remove(paths);
  if (error) throw error;
  const removedPaths = (removed || []).map(o => o.name);
  const entry = { at: new Date().toISOString(), paths, removed: removedPaths, bytes: batch.reduce((s, f) => s + f.size, 0) };
  log.batches.push(entry);
  writeJson(DELETION_LOG, log);
  console.log(`Lote apagado: ${removedPaths.length}/${paths.length} arquivos, ${(entry.bytes / 1e6).toFixed(1)} MB. Log: ${DELETION_LOG}`);

  const slugs = prods.map(p => p.slug);
  const problems = await checkProductPages(slugs, paths);
  if (removedPaths.length !== paths.length) problems.push(`Storage removeu ${removedPaths.length} de ${paths.length}`);
  entry.verification = problems.length ? problems : 'ok';
  writeJson(DELETION_LOG, log);
  if (problems.length) {
    problems.forEach(p => console.log('PROBLEMA', p));
    throw new Error('Verificacao pos-lote falhou — PARE e rode "restore --confirm".');
  }
  console.log(`${slugs.length} paginas de produto verificadas em producao: OK. Revise e rode o proximo lote.`);
}

async function restore() {
  if (!process.argv.includes('--confirm')) throw new Error('Restore exige --confirm.');
  await preflight();
  const log = readJson(DELETION_LOG, { batches: [] });
  const paths = [...new Set(log.batches.flatMap(b => b.removed))];
  const failures = [];
  await mapWithConcurrency(paths, 4, async p => {
    const { error } = await supabase.storage.from(BUCKET).upload(p, fs.readFileSync(backupPathFor(p)), { contentType: 'image/png', upsert: false });
    if (error && !/exists/i.test(error.message)) failures.push(`${p}: ${error.message}`);
  });
  console.log(`Restaurados ${paths.length - failures.length}/${paths.length} arquivos no bucket ${BUCKET}.`);
  failures.forEach(f => console.log('FALHA', f));
  if (failures.length) process.exitCode = 1;
}

const modes = { preflight, backup, 'verify-backup': verifyBackup, audit, delete: deleteBatch, restore };
const mode = process.argv[2];
if (!modes[mode]) {
  console.error(`Uso: node scripts/cleanup-migrated-storage.js <${Object.keys(modes).join('|')}>`);
  process.exit(1);
}
modes[mode]().catch(err => { console.error(err.message || err); process.exitCode = 1; });
