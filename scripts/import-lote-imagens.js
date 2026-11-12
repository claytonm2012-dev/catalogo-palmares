// Importacao de um lote de pastas numeradas (pasta = produto, nome = SKU), mesmo
// padrao de import-parte-final.js: imagens WebP (max 1600px, qualidade 80) em
// public/images/produtos/{SKU}/NN.webp, banco grava a URL relativa. NENHUMA
// imagem vai para o Supabase Storage.
//
// Diferente do import-parte-final.js, produtos que ja existem nao sao so pulados:
// cada imagem da pasta e comparada com as do produto (Storage: nome + tamanho em
// bytes pela listagem do bucket, sem download; local: sha256 do WebP gerado) e
// so as realmente novas entram na galeria. Capa, slug, ID e dados comerciais
// de produtos existentes nunca sao alterados.
//
// Fases (sem flag = dry-run, nao grava nada):
//   node scripts/import-lote-imagens.js                  # dry-run / relatorio
//   node scripts/import-lote-imagens.js --write-images   # grava so os WebP em public/
//   node scripts/import-lote-imagens.js --apply-db       # backup + grava no banco
// --apply-db exige que cada WebP novo ja responda 200 em producao (deploy antes).
//
// Variaveis: LOTE_SOURCE (pasta de origem), LOTE_NAME (pasta do relatorio em
// IMPORTACOES/, ignorada pelo Git), LOTE_PROD_URL (opcional, default = settings).
// Idempotente: rodar de novo nao cria produtos, arquivos nem registros duplicados.
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const { createClient } = require('@supabase/supabase-js');
const { getPublicSiteUrl } = require('../lib/site-url');

const SOURCE_DIR = process.env.LOTE_SOURCE;
const LOTE_NAME = process.env.LOTE_NAME || new Date().toISOString().slice(0, 10);
const REPORT_DIR = path.join(__dirname, '..', 'IMPORTACOES', LOTE_NAME);
const PUBLIC_PRODUCTS_DIR = path.join(__dirname, '..', 'public', 'images', 'produtos');
const URL_PREFIX = '/images/produtos';
const BUCKET = 'product-images';
const STORAGE_MARKER = `/storage/v1/object/public/${BUCKET}/`;
const CATEGORY_SLUG = 'catalogo-geral';
const MAX_DIMENSION = 1600;
const WEBP_QUALITY = 80;
const MODE = process.argv.includes('--apply-db') ? 'apply-db' : process.argv.includes('--write-images') ? 'write-images' : 'dry-run';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const isImageName = name => /\.(jpe?g|png|webp)$/i.test(name);
const naturalSort = (a, b) => a.localeCompare(b, undefined, { numeric: true });
// Capa: arquivo marcado como destaque/principal vem primeiro; o resto em ordem natural.
const COVER_RE = /destaque|principal/i;
const imageOrder = (a, b) => (COVER_RE.test(b) - COVER_RE.test(a)) || naturalSort(a, b);
// SKUs separados para revisao manual (LOTE_REVIEW=SKU1,SKU2): nao sao alterados.
const REVIEW = new Set((process.env.LOTE_REVIEW || '').split(',').map(s => s.trim()).filter(Boolean));

// Toda pasta-folha (sem subpastas), em qualquer profundidade, e um produto; o nome
// da folha e o SKU — pastas intermediarias (paginas do catalogo) nunca viram SKU.
function findLeafFolders(rootDir, mixed) {
  const leaves = [];
  (function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const subdirs = entries.filter(e => e.isDirectory());
    if (!subdirs.length) { if (dir !== rootDir) leaves.push({ sku: path.basename(dir), folder: dir }); return; }
    const loose = entries.filter(e => e.isFile()).map(e => e.name);
    if (loose.length) mixed.push({ dir: path.relative(rootDir, dir) || '.', arquivos: loose });
    subdirs.forEach(s => walk(path.join(dir, s.name)));
  })(rootDir);
  return leaves;
}

// dHash 64 bits para achar a mesma foto salva com outro nome/compressao.
async function dHash(buffer) {
  const px = await sharp(buffer).flatten({ background: '#fff' }).greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
  let bits = '';
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += px[y * 9 + x] > px[y * 9 + x + 1] ? '1' : '0';
  return bits;
}
const hamming = (a, b) => [...a].reduce((n, c, i) => n + (c !== b[i]), 0);
const mb = bytes => Number((bytes / (1024 * 1024)).toFixed(2));

async function optimizeImage(buffer) {
  try {
    if (!buffer.length) return null;
    let img = sharp(buffer, { failOn: 'error' });
    const meta = await img.metadata();
    if (!meta || !meta.width || !meta.height) return null;
    if (meta.width > MAX_DIMENSION || meta.height > MAX_DIMENSION) {
      img = img.resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside', withoutEnlargement: true });
    }
    const out = await img.webp({ quality: WEBP_QUALITY }).toBuffer();
    const outMeta = await sharp(out).metadata();
    return { buffer: out, width: meta.width, height: meta.height, outWidth: outMeta.width, outHeight: outMeta.height };
  } catch (err) {
    return null;
  }
}

async function fetchAll(table, column, values, select) {
  const rows = [];
  for (let i = 0; i < values.length; i += 100) {
    const { data, error } = await supabase.from(table).select(select).in(column, values.slice(i, i + 100));
    if (error) throw error;
    rows.push(...data);
  }
  return rows;
}

// Assinaturas das imagens que o produto ja tem: nome+tamanho para as do Storage
// (listagem do bucket, so metadados) e sha256 para os WebP locais.
async function existingSignatures(sku, urls) {
  const storageNames = new Set();
  const localHashes = new Set();
  const localFiles = new Set();
  for (const url of urls) {
    if (!url) continue;
    if (url.includes(STORAGE_MARKER)) storageNames.add(decodeURIComponent(url.split(STORAGE_MARKER)[1]));
    else if (url.startsWith(`${URL_PREFIX}/`)) {
      const file = path.join(__dirname, '..', 'public', url);
      localFiles.add(path.basename(url));
      if (fs.existsSync(file)) localHashes.add(sha256(fs.readFileSync(file)));
    }
  }
  const storageSizes = new Map();
  const folders = new Set([...storageNames].map(n => n.slice(0, n.lastIndexOf('/'))));
  for (const folder of folders) {
    const { data, error } = await supabase.storage.from(BUCKET).list(folder, { limit: 1000 });
    if (error) throw error;
    for (const obj of data) storageSizes.set(`${folder}/${obj.name}`, obj.metadata && obj.metadata.size);
  }
  const storageBySize = new Map();
  for (const name of storageNames) storageBySize.set(path.basename(name), storageSizes.get(name));
  return { storageBySize, localHashes, localFiles };
}

async function checkProductionUrl(base, url) {
  try {
    const res = await fetch(base + url, { method: 'HEAD', headers: { 'User-Agent': 'Catalogo-Palmares-Import/1.0' } });
    return res.status === 200 && /image\/webp/.test(res.headers.get('content-type') || '') ? 'OK' : `HTTP ${res.status} ${res.headers.get('content-type') || ''}`;
  } catch (err) {
    return `sem conexao: ${err.message}`;
  }
}

async function main() {
  if (!SOURCE_DIR || !fs.existsSync(SOURCE_DIR)) throw new Error(`Defina LOTE_SOURCE com a pasta de origem (atual: ${SOURCE_DIR})`);
  console.log(`Modo: ${MODE.toUpperCase()} | origem: ${SOURCE_DIR}`);

  const mixed = [];
  const leaves = findLeafFolders(SOURCE_DIR, mixed);
  const looseFiles = mixed;
  const folderBySku = new Map();
  const dupSkus = new Map();
  for (const l of leaves) {
    if (folderBySku.has(l.sku)) dupSkus.set(l.sku, [...(dupSkus.get(l.sku) || [folderBySku.get(l.sku)]), l.folder]);
    else folderBySku.set(l.sku, l.folder);
  }
  const folders = [...folderBySku.keys()].sort(naturalSort);
  // Nome de folha que nao e codigo numerico nao e tratado como SKU (vai para revisao).
  const badNames = folders.filter(n => !/^\d+$/.test(n) || dupSkus.has(n));
  const skus = folders.filter(n => !badNames.includes(n));

  const products = await fetchAll('products', 'sku', skus, '*');
  const bySlug = await fetchAll('products', 'slug', skus.map(s => `produto-${s}`), 'id,sku,slug');
  const bySku = new Map(products.map(p => [p.sku, p]));
  const slugConflicts = bySlug.filter(p => !bySku.has(p.sku) || bySku.get(p.sku).id !== p.id);
  const images = await fetchAll('product_images', 'product_id', products.map(p => p.id), '*');
  const imagesByProduct = new Map();
  for (const img of images) {
    if (!imagesByProduct.has(img.product_id)) imagesByProduct.set(img.product_id, []);
    imagesByProduct.get(img.product_id).push(img);
  }

  const plan = [];
  const totals = { originalBytes: 0, optimizedBytes: 0, newImages: 0, duplicatesSkipped: 0, invalid: [], emptyFolders: [], crossSkuDuplicates: [] };
  const seenSourceHash = new Map();

  for (const sku of skus) {
    const folder = folderBySku.get(sku);
    const dirEntries = fs.readdirSync(folder, { withFileTypes: true });
    const files = dirEntries.filter(d => d.isFile() && isImageName(d.name)).map(d => d.name).sort(imageOrder);
    const ignored = dirEntries.filter(d => !(d.isFile() && isImageName(d.name))).map(d => d.name);
    const existing = bySku.get(sku) || null;
    const item = { sku, origem: path.relative(SOURCE_DIR, folder), slug: existing ? existing.slug : `produto-${sku}`, name: existing ? existing.name : `Produto ${sku}`, existing: !!existing, productId: existing ? existing.id : null, files: [], ignored, status: null };
    if (!files.length) { totals.emptyFolders.push(sku); item.status = 'pasta_sem_imagens'; plan.push(item); continue; }
    if (REVIEW.has(sku)) { item.status = 'revisao_manual'; item.files = files.map(f => ({ source: f, action: 'revisao_manual' })); plan.push(item); continue; }

    const productDir = path.join(PUBLIC_PRODUCTS_DIR, sku);
    let sigs = null;
    let nextIndex = 1;
    if (existing) {
      const urls = [existing.main_image, ...(imagesByProduct.get(existing.id) || []).map(i => i.url)];
      sigs = await existingSignatures(sku, urls);
    }
    if (fs.existsSync(productDir)) {
      const nums = fs.readdirSync(productDir).map(n => parseInt(n, 10)).filter(Number.isFinite);
      if (nums.length && existing) nextIndex = Math.max(...nums) + 1;
    }

    const seenInFolder = new Set();
    const seenDHash = [];
    let newIndex = 0;
    for (let i = 0; i < files.length; i++) {
      const filename = files[i];
      const buffer = fs.readFileSync(path.join(folder, filename));
      const srcHash = sha256(buffer);
      const file = { source: filename, sourceBytes: buffer.length, action: null };
      item.files.push(file);
      if (seenInFolder.has(srcHash)) { file.action = 'duplicada_na_pasta'; totals.duplicatesSkipped++; continue; }
      seenInFolder.add(srcHash);
      let dh = null;
      try { dh = await dHash(buffer); } catch (err) { /* invalida: tratada abaixo */ }
      const twin = dh && seenDHash.find(s => hamming(s.h, dh) <= 3);
      if (twin) { file.action = `quase_identica_a_${twin.f}`; totals.duplicatesSkipped++; continue; }
      if (dh) seenDHash.push({ h: dh, f: filename });
      if (seenSourceHash.has(srcHash)) totals.crossSkuDuplicates.push(`${sku}/${filename} = ${seenSourceHash.get(srcHash)}`);
      else seenSourceHash.set(srcHash, `${sku}/${filename}`);

      if (existing && sigs.storageBySize.has(filename) && sigs.storageBySize.get(filename) === buffer.length) {
        file.action = 'ja_existe_no_storage'; totals.duplicatesSkipped++; continue;
      }
      const optimized = await optimizeImage(buffer);
      if (!optimized) { file.action = 'invalida'; totals.invalid.push(`${sku}/${filename}`); continue; }
      const outHash = sha256(optimized.buffer);
      if (existing && sigs.localHashes.has(outHash)) { file.action = 'ja_existe_local'; totals.duplicatesSkipped++; continue; }

      // Produto novo: NN segue a ordem natural da pasta. Produto existente: proximo NN livre.
      const index = existing ? nextIndex++ : ++newIndex;
      const destName = `${String(index).padStart(2, '0')}.webp`;
      const destPath = path.join(productDir, destName);
      if (fs.existsSync(destPath) && sha256(fs.readFileSync(destPath)) !== outHash) {
        throw new Error(`${destPath} ja existe com conteudo diferente — abortado para nao sobrescrever`);
      }
      Object.assign(file, { action: 'nova', dest: `${URL_PREFIX}/${sku}/${destName}`, destPath, optimizedBytes: optimized.buffer.length, size: `${optimized.width}x${optimized.height} -> ${optimized.outWidth}x${optimized.outHeight}`, buffer: optimized.buffer });
      totals.originalBytes += buffer.length;
      totals.optimizedBytes += optimized.buffer.length;
      totals.newImages++;
    }
    const newFiles = item.files.filter(f => f.action === 'nova');
    if (!existing) item.status = newFiles.length ? 'criar_produto' : 'sem_imagem_valida';
    else item.status = newFiles.length ? 'acrescentar_imagens' : 'sem_alteracao';
    plan.push(item);
  }

  const created = plan.filter(p => p.status === 'criar_produto');
  const appended = plan.filter(p => p.status === 'acrescentar_imagens');
  const newFiles = plan.flatMap(p => p.files.filter(f => f.action === 'nova'));
  const summary = {
    gerado_em: new Date().toISOString(), modo: MODE, origem: SOURCE_DIR,
    pastas_folha_encontradas: leaves.length, pastas_encontradas: folders.length, arquivos_soltos_ignorados: looseFiles,
    pastas_com_nome_invalido: badNames, skus_em_mais_de_uma_pasta: Object.fromEntries(dupSkus),
    revisao_manual: plan.filter(p => p.status === 'revisao_manual').map(p => p.sku),
    pastas_vazias: totals.emptyFolders, imagens_na_origem: plan.reduce((s, p) => s + p.files.length, 0),
    produtos_novos: created.length, produtos_existentes: plan.filter(p => p.existing).length,
    produtos_existentes_com_imagens_novas: appended.length, produtos_existentes_sem_alteracao: plan.filter(p => p.status === 'sem_alteracao').length,
    conflitos_de_slug: slugConflicts, imagens_novas: totals.newImages, imagens_duplicadas_ignoradas: totals.duplicatesSkipped,
    imagens_invalidas: totals.invalid, imagens_iguais_em_skus_diferentes: totals.crossSkuDuplicates,
    tamanho_original_mb: mb(totals.originalBytes), tamanho_otimizado_mb: mb(totals.optimizedBytes),
    maior_webp_kb: newFiles.length ? Math.round(Math.max(...newFiles.map(f => f.optimizedBytes)) / 1024) : 0,
    supabase_storage_uploads: 0
  };

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const strip = p => ({ ...p, files: p.files.map(({ buffer, destPath, ...f }) => f) });

  if (MODE === 'write-images') {
    let written = 0;
    for (const f of newFiles) {
      if (fs.existsSync(f.destPath)) continue;
      fs.mkdirSync(path.dirname(f.destPath), { recursive: true });
      fs.writeFileSync(f.destPath, f.buffer);
      if (sha256(fs.readFileSync(f.destPath)) !== sha256(f.buffer)) throw new Error(`Falha ao gravar ${f.destPath}`);
      written++;
    }
    summary.webp_gravados = written;
    summary.webp_ja_presentes = newFiles.length - written;
  }

  if (MODE === 'apply-db') {
    if (slugConflicts.length) throw new Error('Conflitos de slug — nada gravado');
    const missing = newFiles.filter(f => !fs.existsSync(f.destPath));
    if (missing.length) throw new Error(`${missing.length} WebP ainda nao gravados — rode --write-images e publique antes`);
    const base = (process.env.LOTE_PROD_URL || await getPublicSiteUrl()).replace(/\/+$/, '');
    if (!/^https:\/\//.test(base)) throw new Error(`URL de producao invalida: ${base}`);
    const offline = [];
    for (let i = 0; i < newFiles.length; i += 8) {
      const chunk = newFiles.slice(i, i + 8);
      const results = await Promise.all(chunk.map(f => checkProductionUrl(base, f.dest)));
      results.forEach((r, j) => { if (r !== 'OK') offline.push(`${chunk[j].dest}: ${r}`); });
    }
    if (offline.length) throw new Error(`Imagens ainda nao disponiveis em ${base}:\n${offline.slice(0, 20).join('\n')}`);
    console.log(`Todas as ${newFiles.length} imagens novas respondem 200 em ${base}.`);

    const backupFile = path.join(REPORT_DIR, `backup-antes-apply-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(backupFile, JSON.stringify({ products, product_images: images }, null, 2));
    summary.backup = backupFile;

    const { data: cat, error: catErr } = await supabase.from('categories').select('id').eq('slug', CATEGORY_SLUG).single();
    if (catErr) throw catErr;
    const log = [];
    for (const item of created) {
      const files = item.files.filter(f => f.action === 'nova');
      const { data: prod, error } = await supabase.from('products').insert({
        name: item.name, sku: item.sku, slug: item.slug, category_id: cat.id, status: 'active', is_launch: 'no', is_featured: 'no', main_image: files[0].dest
      }).select().single();
      if (error) throw new Error(`SKU ${item.sku}: ${error.message}`);
      item.productId = prod.id;
      const gallery = files.slice(1).map((f, i) => ({ product_id: prod.id, url: f.dest, sort_order: i }));
      if (gallery.length) {
        const { error: gErr } = await supabase.from('product_images').insert(gallery);
        if (gErr) throw new Error(`Galeria SKU ${item.sku}: ${gErr.message}`);
      }
      await supabase.from('products').update({ last_qr_test_status: 'funcionando', last_qr_test_at: new Date().toISOString() }).eq('id', prod.id);
      log.push(`criado SKU ${item.sku} (id ${prod.id}) capa + ${gallery.length} na galeria`);
    }
    for (const item of appended) {
      const current = imagesByProduct.get(item.productId) || [];
      const start = current.length ? Math.max(...current.map(i => i.sort_order || 0)) + 1 : 0;
      const rows = item.files.filter(f => f.action === 'nova').map((f, i) => ({ product_id: item.productId, url: f.dest, sort_order: start + i }));
      const { error } = await supabase.from('product_images').insert(rows);
      if (error) throw new Error(`Galeria SKU ${item.sku}: ${error.message}`);
      log.push(`SKU ${item.sku} (id ${item.productId}): +${rows.length} imagem(ns) na galeria, capa mantida`);
    }
    summary.alteracoes_no_banco = log;
    log.forEach(l => console.log(l));
  }

  summary.produtos = plan.map(strip);
  const reportFile = path.join(REPORT_DIR, `relatorio-${MODE}.json`);
  fs.writeFileSync(reportFile, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ...summary, produtos: `[${plan.length} itens]`, imagens_iguais_em_skus_diferentes: summary.imagens_iguais_em_skus_diferentes.length }, null, 2));
  console.log(`Relatorio: ${reportFile}`);
}

main().catch(err => { console.error('Erro:', err.message || err); process.exit(1); });
