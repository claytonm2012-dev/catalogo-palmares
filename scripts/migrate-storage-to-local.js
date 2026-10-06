// Migra as imagens de um conjunto fechado de produtos do Supabase Storage
// (bucket product-images, perto do limite do plano gratuito) para arquivos
// estaticos otimizados em public/images/produtos/{SKU}/NN.webp — mesmo padrao
// de import-parte-final.js (01 = imagem principal, 02..NN = galeria em ordem).
//
// O conjunto e o estado anterior vem de storage-migration-backup.json (gerado
// na auditoria). NUNCA apaga nada do Storage — a exclusao das copias antigas e
// um passo separado, manual e so depois da validacao em producao.
//
// Modos (rodar nesta ordem, com commit + deploy entre "copy" e "update-db"):
//   node scripts/migrate-storage-to-local.js copy         baixa e converte (so disco local)
//   node scripts/migrate-storage-to-local.js verify-urls  confere HTTP 200 de toda URL nova em BASE_URL
//   node scripts/migrate-storage-to-local.js update-db    confere producao e regrava as URLs no banco
//   node scripts/migrate-storage-to-local.js rollback     restaura as URLs antigas do Supabase
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { createClient } = require('@supabase/supabase-js');

const ROOT = path.join(__dirname, '..');
const BACKUP_FILE = path.join(ROOT, 'storage-migration-backup.json');
const REPORT_FILE = path.join(ROOT, 'storage-migration-report.json');
const PUBLIC_PRODUCTS_DIR = path.join(ROOT, 'public', 'images', 'produtos');
const URL_PREFIX = '/images/produtos';
const BASE_URL = (process.env.MIGRATION_BASE_URL || 'https://catalogo-palmares.vercel.app').replace(/\/$/, '');
const MAX_DIMENSION = 1600;
const WEBP_QUALITY = 80;
const CONCURRENCY = 4;

const backup = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8'));

function supabaseClient() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}

// Plano deterministico: main_image -> 01, galeria (sort_order, id) -> 02, 03...
function planFor(product) {
  const gallery = [...product.old_gallery].sort((a, b) => a.sort_order - b.sort_order || a.product_image_id - b.product_image_id);
  const items = [{ kind: 'main', oldUrl: product.old_main_image }];
  gallery.forEach(g => items.push({ kind: 'gallery', productImageId: g.product_image_id, oldUrl: g.url }));
  return items.map((item, i) => {
    const file = `${String(i + 1).padStart(2, '0')}.webp`;
    return { ...item, file, diskPath: path.join(PUBLIC_PRODUCTS_DIR, product.sku, file), newUrl: `${URL_PREFIX}/${product.sku}/${file}` };
  });
}

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

async function fetchWithRetry(url, attempts = 4) {
  for (let t = 1; ; t++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (t >= attempts) throw new Error(`${url}: ${err.message}`);
      await new Promise(r => setTimeout(r, 2000 * t));
    }
  }
}

async function copy() {
  const jobs = backup.products.flatMap(p => planFor(p).map(item => ({ product: p, item })));
  const rows = await mapWithConcurrency(jobs, CONCURRENCY, async ({ product, item }) => {
    const original = await fetchWithRetry(item.oldUrl);
    const meta = await sharp(original).metadata();
    const optimized = await sharp(original)
      .rotate()
      .resize(MAX_DIMENSION, MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer();
    const outMeta = await sharp(optimized).metadata(); // garante que o webp gerado e decodificavel
    fs.mkdirSync(path.dirname(item.diskPath), { recursive: true });
    fs.writeFileSync(item.diskPath, optimized);
    return {
      sku: product.sku, product_id: product.product_id, kind: item.kind, product_image_id: item.productImageId || null,
      old_url: item.oldUrl, new_url: item.newUrl,
      original_bytes: original.length, optimized_bytes: optimized.length,
      original_size: `${meta.width}x${meta.height}`, optimized_size: `${outMeta.width}x${outMeta.height}`, has_alpha: !!meta.hasAlpha
    };
  });
  const totalOriginal = rows.reduce((s, r) => s + r.original_bytes, 0);
  const totalOptimized = rows.reduce((s, r) => s + r.optimized_bytes, 0);
  fs.writeFileSync(REPORT_FILE, JSON.stringify({
    generated_at: new Date().toISOString(), products: backup.products.length, images: rows.length,
    total_original_bytes: totalOriginal, total_optimized_bytes: totalOptimized, images_detail: rows
  }, null, 2));
  console.log(`${backup.products.length} produtos, ${rows.length} imagens: ${(totalOriginal / 1048576).toFixed(1)} MB -> ${(totalOptimized / 1048576).toFixed(1)} MB`);
}

async function verifyUrls() {
  const urls = backup.products.flatMap(p => planFor(p).map(i => i.newUrl));
  const failures = [];
  await mapWithConcurrency(urls, 8, async url => {
    try {
      const res = await fetch(BASE_URL + url);
      const type = res.headers.get('content-type') || '';
      const body = Buffer.from(await res.arrayBuffer());
      if (res.status !== 200 || !type.startsWith('image/webp') || body.length < 100) failures.push(`${url} -> ${res.status} ${type} ${body.length}B`);
    } catch (err) {
      failures.push(`${url} -> ${err.message}`);
    }
  });
  console.log(`${BASE_URL}: ${urls.length - failures.length}/${urls.length} URLs OK`);
  failures.forEach(f => console.log('FALHA', f));
  return failures.length === 0;
}

async function updateDb() {
  if (!(await verifyUrls())) throw new Error('Alguma imagem nova nao esta acessivel em producao — banco NAO foi alterado.');
  const supabase = supabaseClient();

  // Antes de escrever qualquer coisa: o banco precisa estar exatamente no estado
  // do backup (ninguem editou esses produtos pelo Admin desde a auditoria).
  const conflicts = [];
  for (const p of backup.products) {
    const { data: prod, error } = await supabase.from('products').select('id,sku,main_image').eq('id', p.product_id).single();
    if (error) throw error;
    if (prod.sku !== p.sku || prod.main_image !== p.old_main_image) conflicts.push(`produto ${p.sku}: main_image mudou`);
    const { data: imgs, error: imgErr } = await supabase.from('product_images').select('id,url').eq('product_id', p.product_id);
    if (imgErr) throw imgErr;
    const current = new Map(imgs.map(i => [i.id, i.url]));
    if (imgs.length !== p.old_gallery.length) conflicts.push(`produto ${p.sku}: galeria tem ${imgs.length} imagens (backup: ${p.old_gallery.length})`);
    p.old_gallery.forEach(g => { if (current.get(g.product_image_id) !== g.url) conflicts.push(`produto ${p.sku}: imagem ${g.product_image_id} mudou`); });
  }
  if (conflicts.length) {
    conflicts.forEach(c => console.log('CONFLITO', c));
    throw new Error('Banco diverge do backup — nada foi alterado.');
  }

  let updated = 0;
  for (const p of backup.products) {
    for (const item of planFor(p)) {
      const q = item.kind === 'main'
        ? supabase.from('products').update({ main_image: item.newUrl }).eq('id', p.product_id).eq('main_image', item.oldUrl)
        : supabase.from('product_images').update({ url: item.newUrl }).eq('id', item.productImageId).eq('url', item.oldUrl);
      const { data, error } = await q.select('id');
      if (error) throw error;
      if (!data || data.length !== 1) throw new Error(`Atualizacao inesperada em ${p.sku} ${item.file} (${(data || []).length} linhas) — rode "rollback" se necessario.`);
      updated++;
    }
  }
  console.log(`${updated} registros atualizados (${backup.products.length} produtos).`);
}

async function rollback() {
  const supabase = supabaseClient();
  let restored = 0;
  for (const p of backup.products) {
    for (const item of planFor(p)) {
      const q = item.kind === 'main'
        ? supabase.from('products').update({ main_image: item.oldUrl }).eq('id', p.product_id).eq('main_image', item.newUrl)
        : supabase.from('product_images').update({ url: item.oldUrl }).eq('id', item.productImageId).eq('url', item.newUrl);
      const { data, error } = await q.select('id');
      if (error) throw error;
      restored += (data || []).length;
    }
  }
  console.log(`${restored} registros restaurados para as URLs do Supabase Storage.`);
}

const modes = { copy, 'verify-urls': async () => { if (!(await verifyUrls())) process.exitCode = 1; }, 'update-db': updateDb, rollback };
const mode = process.argv[2];
if (!modes[mode]) {
  console.error(`Uso: node scripts/migrate-storage-to-local.js <${Object.keys(modes).join('|')}>`);
  process.exit(1);
}
modes[mode]().catch(err => { console.error(err.message || err); process.exit(1); });
