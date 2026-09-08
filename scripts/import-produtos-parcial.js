// Importacao em lote a partir de PRODUTOS_PARCIAL, onde cada produto e uma pasta-folha
// (sem subpastas) em qualquer nivel de profundidade — diferente de import-bulk-catalog.js,
// que espera pastas de SKU direto na raiz. O nome da pasta-folha e o SKU.
// Idempotente: pode ser rodado de novo com seguranca — produtos e imagens ja importados
// sao detectados e pulados, so o que falta (ou falhou) e reprocessado.
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { createClient } = require('@supabase/supabase-js');

const SOURCE_DIR = process.env.PARCIAL_IMPORT_SOURCE || 'C:\\Users\\Pichau\\Downloads\\PRODUTOS_PARCIAL';
const BUCKET = 'product-images';
const CONCURRENCY = 4;
const CATEGORY_NAME = 'Catálogo Geral';
const CATEGORY_SLUG = 'catalogo-geral';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

function isImageName(filename) {
  return /\.(jpe?g|png|webp)$/i.test(filename);
}

function contentTypeFor(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
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

// Encontra toda pasta-folha (sem subpastas) dentro de rootDir, em qualquer profundidade.
// O nome da pasta-folha e tratado como SKU do produto.
// mixedDirWarnings acumula pastas que tem subpastas E imagens soltas no mesmo nivel —
// essas imagens soltas nao pertencem a nenhuma pasta-folha e seriam perdidas silenciosamente
// se nao fossem reportadas aqui.
function findLeafFolders(rootDir, mixedDirWarnings = []) {
  const leaves = [];
  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const subdirs = entries.filter(e => e.isDirectory());
    if (subdirs.length === 0) {
      leaves.push({ sku: path.basename(dir), folderPath: dir });
      return;
    }
    const looseImages = entries.filter(e => e.isFile() && isImageName(e.name)).map(e => e.name);
    if (looseImages.length) {
      mixedDirWarnings.push({ dir, looseImages });
    }
    for (const sub of subdirs) walk(path.join(dir, sub.name));
  }
  walk(rootDir);
  return leaves;
}

async function ensureCategory() {
  const { data: existing } = await supabase.from('categories').select('id').eq('slug', CATEGORY_SLUG).limit(1);
  if (existing && existing[0]) return existing[0].id;
  const { data: created, error } = await supabase
    .from('categories')
    .insert({ name: CATEGORY_NAME, slug: CATEGORY_SLUG, description: 'Produtos importados em lote a partir de pastas numeradas', sort_order: 99, status: 'active' })
    .select().single();
  if (error) throw error;
  console.log(`[categoria] "${CATEGORY_NAME}" criada (id ${created.id})`);
  return created.id;
}

async function listStorageFiles(prefix) {
  const { data, error } = await supabase.storage.from(BUCKET).list(prefix, { limit: 1000 });
  if (error) return [];
  return (data || []).filter(f => f.name).map(f => f.name);
}

function publicUrlFor(storagePath) {
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
  return data.publicUrl;
}

async function validateImage(localPath) {
  try {
    const buffer = fs.readFileSync(localPath);
    if (!buffer.length) return null;
    await sharp(buffer).metadata(); // lanca erro se nao for uma imagem valida/decodificavel
    return buffer;
  } catch (err) {
    return null;
  }
}

async function evaluateQr(product) {
  const { data: resolved } = await supabase.from('products').select('id,status').eq('slug', product.slug).limit(1);
  const match = resolved && resolved[0];
  let testStatus;
  if (!match) testStatus = 'pagina_inexistente';
  else if (match.id !== product.id) testStatus = 'produto_incorreto';
  else if (match.status !== 'active') testStatus = 'produto_inativo';
  else testStatus = 'funcionando';
  await supabase.from('products').update({ last_qr_test_status: testStatus, last_qr_test_at: new Date().toISOString() }).eq('id', product.id);
  return { ok: testStatus === 'funcionando', testStatus };
}

async function processLeaf(leaf, categoryId, report, existingProductsBySku) {
  const { sku, folderPath } = leaf;
  const slug = `produto-${sku}`;
  const name = `Produto ${sku}`;
  const relFolder = path.relative(SOURCE_DIR, folderPath);

  try {
    const rawFiles = fs.readdirSync(folderPath, { withFileTypes: true })
      .filter(d => d.isFile() && isImageName(d.name))
      .map(d => d.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    // valida cada arquivo de verdade (nao so pela extensao) e ignora o que nao for imagem
    const validFiles = [];
    for (const filename of rawFiles) {
      const buffer = await validateImage(path.join(folderPath, filename));
      if (buffer) validFiles.push(filename);
      else report.ignoredNonImages.push(`${relFolder}/${filename}`);
    }

    if (!validFiles.length) {
      report.noImages.push(sku);
      console.log(`[SEM IMAGEM VALIDA] SKU ${sku} (${relFolder})`);
      return;
    }

    // produto existente ja veio de uma unica busca em lote antes do loop (nao consulta o
    // banco por SKU aqui dentro) — so revalida contra o banco no momento de criar, pra
    // pegar o registro completo com id gerado.
    let product = existingProductsBySku.get(sku) || null;
    let isNew = false;

    if (!product) {
      const { data: created, error } = await supabase.from('products').insert({
        name, sku, slug, category_id: categoryId, status: 'active'
      }).select().single();
      if (error) throw error;
      product = created;
      isNew = true;
      report.created.push(sku);
    } else {
      report.existing.push(sku);
    }

    const existingStorageNames = await listStorageFiles(`products/${sku}`);
    const uploadedUrls = [];
    for (const filename of validFiles) {
      const storagePath = `products/${sku}/${filename}`;
      if (existingStorageNames.includes(filename)) {
        uploadedUrls.push({ filename, url: publicUrlFor(storagePath), isNewUpload: false });
        report.imagesSkipped++;
        continue;
      }
      const buffer = fs.readFileSync(path.join(folderPath, filename));
      const { error } = await supabase.storage.from(BUCKET)
        .upload(storagePath, buffer, { contentType: contentTypeFor(filename), cacheControl: '31536000', upsert: false });
      if (error) throw new Error(`upload ${storagePath}: ${error.message}`);
      uploadedUrls.push({ filename, url: publicUrlFor(storagePath), isNewUpload: true });
      report.imagesUploaded++;
    }

    // capa: so define se o produto ainda nao tiver uma (preserva dado valido existente)
    if (!product.main_image && uploadedUrls.length) {
      const cover = uploadedUrls[0].url;
      await supabase.from('products').update({ main_image: cover }).eq('id', product.id);
      product.main_image = cover;
    }

    // galeria: cria linha em product_images so para o que ainda nao esta cadastrado
    const { data: existingImageRows } = await supabase.from('product_images').select('url').eq('product_id', product.id);
    const existingImageUrls = new Set((existingImageRows || []).map(r => r.url));
    let sortOrder = (existingImageRows || []).length;
    for (const item of uploadedUrls) {
      if (item.url === product.main_image) continue;
      if (existingImageUrls.has(item.url)) continue;
      await supabase.from('product_images').insert({ product_id: product.id, url: item.url, sort_order: sortOrder });
      sortOrder++;
    }

    const qrResult = await evaluateQr(product);
    if (qrResult.ok) report.qrOk.push(sku); else report.qrFailed.push({ sku, status: qrResult.testStatus });

    const newUploadsCount = uploadedUrls.filter(u => u.isNewUpload).length;
    console.log(`[OK] SKU ${sku} (${relFolder}) — ${isNew ? 'criado' : 'ja existia'} | ${newUploadsCount} imagem(ns) nova(s), ${uploadedUrls.length - newUploadsCount} ja existente(s) | QR: ${qrResult.testStatus}`);
  } catch (err) {
    report.errors.push({ sku, folder: relFolder, message: err.message || String(err) });
    console.log(`[ERRO] SKU ${sku} (${relFolder}): ${err.message || err}`);
  }
}

async function main() {
  if (!fs.existsSync(SOURCE_DIR)) {
    throw new Error(`Diretorio de origem nao encontrado: ${SOURCE_DIR}`);
  }

  const mixedDirWarnings = [];
  let leaves = findLeafFolders(SOURCE_DIR, mixedDirWarnings);
  console.log(`Pastas-folha (produtos) encontradas em "${SOURCE_DIR}": ${leaves.length}`);

  // rootDir sem nenhuma subpasta e tratado como uma unica pasta-folha (SKU = nome do
  // proprio rootDir) — na pratica normalmente indica que PARCIAL_IMPORT_SOURCE aponta
  // para um nivel errado da arvore. So um aviso: nao interrompe, pode ser intencional
  // (ex.: testar com uma unica pasta de produto).
  if (leaves.length === 1 && leaves[0].folderPath === SOURCE_DIR) {
    console.log(`\n[ATENCAO] "${SOURCE_DIR}" nao tem subpastas — sera importado como um UNICO produto (SKU "${leaves[0].sku}"). Se a intencao era importar varios produtos, confira se PARCIAL_IMPORT_SOURCE aponta para o nivel certo da arvore de pastas.`);
  }

  // Pastas que tem subpastas E imagens soltas no mesmo nivel: essas imagens soltas nao
  // pertencem a nenhuma pasta-folha e ficariam de fora da importacao sem nenhum aviso.
  if (mixedDirWarnings.length) {
    console.log('\n[ATENCAO] Pastas com imagens soltas junto de subpastas — essas imagens NAO sao importadas (nao pertencem a nenhuma pasta-folha/SKU):');
    for (const { dir, looseImages } of mixedDirWarnings) {
      console.log(`  ${dir}: ${looseImages.join(', ')}`);
    }
  }

  // Duas pastas-folha diferentes com o mesmo nome de SKU nao podem ser processadas —
  // misturaria imagens de origem incerta no mesmo produto. Aborta e reporta em vez de adivinhar.
  const bySku = new Map();
  const duplicateSkus = new Map();
  for (const leaf of leaves) {
    if (bySku.has(leaf.sku)) {
      if (!duplicateSkus.has(leaf.sku)) duplicateSkus.set(leaf.sku, [bySku.get(leaf.sku)]);
      duplicateSkus.get(leaf.sku).push(leaf.folderPath);
    } else {
      bySku.set(leaf.sku, leaf.folderPath);
    }
  }
  if (duplicateSkus.size) {
    console.log('\n[ATENCAO] SKUs com mais de uma pasta-folha — REMOVIDOS do processamento para evitar mistura de imagens:');
    for (const [sku, folders] of duplicateSkus) {
      console.log(`  SKU ${sku}: ${folders.join(' | ')}`);
    }
    leaves = leaves.filter(l => !duplicateSkus.has(l.sku));
  }

  if (process.env.PARCIAL_IMPORT_LIMIT) {
    leaves = leaves.slice(0, parseInt(process.env.PARCIAL_IMPORT_LIMIT, 10));
    console.log(`(modo teste: processando so as primeiras ${leaves.length} pastas)`);
  }

  const categoryId = await ensureCategory();

  const allSkus = leaves.map(l => l.sku);
  const report = {
    totalFolders: leaves.length,
    created: [], existing: [], imagesUploaded: 0, imagesSkipped: 0,
    qrOk: [], qrFailed: [], noImages: [], ignoredNonImages: [], errors: [],
    duplicateSkus: Array.from(duplicateSkus.entries()).map(([sku, folders]) => ({ sku, folders })),
    mixedDirWarnings
  };

  // Busca todos os SKUs existentes de uma vez (1 query) em vez de 1 query por pasta dentro
  // do loop.
  const { data: existingRows } = await supabase.from('products').select('*').in('sku', allSkus);
  const existingProductsBySku = new Map((existingRows || []).map(p => [p.sku, p]));
  console.log(`Produtos ja existentes no banco (dentre os SKUs encontrados): ${existingProductsBySku.size}`);

  let done = 0;
  await mapWithConcurrency(leaves, CONCURRENCY, async (leaf) => {
    await processLeaf(leaf, categoryId, report, existingProductsBySku);
    done++;
    if (done % 10 === 0 || done === leaves.length) {
      console.log(`--- progresso: ${done}/${leaves.length} ---`);
    }
  });

  // Comparacao final: SKUs encontrados no disco x SKUs no banco
  const { data: allSkuRows } = await supabase.from('products').select('sku').in('sku', allSkus);
  const skusInDb = new Set((allSkuRows || []).map(r => r.sku));
  const missingFromDb = allSkus.filter(sku => !skusInDb.has(sku));

  const summary = {
    pastas_folha_encontradas: report.totalFolders,
    skus_com_pasta_duplicada_ignorados: report.duplicateSkus,
    imagens_soltas_ignoradas_por_pasta_ter_subpastas: report.mixedDirWarnings,
    pastas_processadas: report.totalFolders - report.errors.length,
    produtos_criados: report.created.length,
    produtos_ja_existentes: report.existing.length,
    imagens_enviadas: report.imagesUploaded,
    imagens_ja_existentes_ignoradas: report.imagesSkipped,
    arquivos_ignorados_por_nao_serem_imagem: report.ignoredNonImages.length,
    qr_codes_ok: report.qrOk.length,
    qr_codes_com_problema: report.qrFailed,
    skus_sem_imagem_valida: report.noImages,
    erros: report.errors,
    skus_sem_produto_no_banco_apos_importacao: missingFromDb
  };

  console.log('\n=== RELATORIO FINAL ===');
  console.log(JSON.stringify(summary, null, 2));

  fs.writeFileSync(path.join(__dirname, '..', 'import-produtos-parcial-report.json'), JSON.stringify(summary, null, 2));
  console.log('\nRelatorio salvo em import-produtos-parcial-report.json');
}

main().catch(err => { console.error('Erro fatal na importacao:', err); process.exit(1); });
