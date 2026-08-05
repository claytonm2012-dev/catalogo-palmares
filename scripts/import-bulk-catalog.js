// Importacao em lote do catalogo a partir de pastas numeradas (uma pasta = um produto).
// Idempotente: pode ser rodado de novo com seguranca — produtos e imagens ja importados
// sao detectados e pulados, so o que falta (ou falhou) e reprocessado. Isso tambem serve
// como o mecanismo de "repetir somente os itens com falha": basta rodar de novo.
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { createClient } = require('@supabase/supabase-js');

const SOURCE_DIR = process.env.BULK_IMPORT_SOURCE || 'C:\\Users\\Pichau\\Downloads\\imagens catalogo 2026\\imagens catalogo 2026';
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

async function processFolder(code, categoryId, report, existingProductsBySku) {
  const folderPath = path.join(SOURCE_DIR, code);
  const sku = code;
  const slug = `produto-${code}`;
  const name = `Produto ${code}`;

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
      else report.ignoredNonImages.push(`${code}/${filename}`);
    }

    if (!validFiles.length) {
      report.noImages.push(code);
      console.log(`[SEM IMAGEM VALIDA] pasta ${code}`);
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
      report.created.push(code);
    } else {
      report.existing.push(code);
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
    if (qrResult.ok) report.qrOk.push(code); else report.qrFailed.push({ code, status: qrResult.testStatus });

    const newUploadsCount = uploadedUrls.filter(u => u.isNewUpload).length;
    console.log(`[OK] ${code} — ${isNew ? 'criado' : 'ja existia'} | ${newUploadsCount} imagem(ns) nova(s), ${uploadedUrls.length - newUploadsCount} ja existente(s) | QR: ${qrResult.testStatus}`);
  } catch (err) {
    report.errors.push({ code, message: err.message || String(err) });
    console.log(`[ERRO] ${code}: ${err.message || err}`);
  }
}

async function main() {
  if (!fs.existsSync(SOURCE_DIR)) {
    throw new Error(`Diretorio de origem nao encontrado: ${SOURCE_DIR}`);
  }
  let allFolders = fs.readdirSync(SOURCE_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  console.log(`Pastas encontradas em "${SOURCE_DIR}": ${allFolders.length}`);

  if (process.env.BULK_IMPORT_LIMIT) {
    allFolders = allFolders.slice(0, parseInt(process.env.BULK_IMPORT_LIMIT, 10));
    console.log(`(modo teste: processando so as primeiras ${allFolders.length} pastas)`);
  }

  const categoryId = await ensureCategory();

  const report = {
    totalFolders: allFolders.length,
    created: [], existing: [], imagesUploaded: 0, imagesSkipped: 0,
    qrOk: [], qrFailed: [], noImages: [], ignoredNonImages: [], errors: []
  };

  // Busca todos os SKUs existentes de uma vez (1 query) em vez de 1 query por pasta dentro
  // do loop — com 113+ pastas isso evita centenas de idas ao banco so pra checar duplicidade.
  const { data: existingRows } = await supabase.from('products').select('*').in('sku', allFolders);
  const existingProductsBySku = new Map((existingRows || []).map(p => [p.sku, p]));
  console.log(`Produtos ja existentes no banco (dentre as pastas encontradas): ${existingProductsBySku.size}`);

  let done = 0;
  await mapWithConcurrency(allFolders, CONCURRENCY, async (code) => {
    await processFolder(code, categoryId, report, existingProductsBySku);
    done++;
    if (done % 10 === 0 || done === allFolders.length) {
      console.log(`--- progresso: ${done}/${allFolders.length} ---`);
    }
  });

  // Comparacao final: pastas do disco x SKUs no banco
  const { data: allSkuRows } = await supabase.from('products').select('sku').in('sku', allFolders);
  const skusInDb = new Set((allSkuRows || []).map(r => r.sku));
  const missingFromDb = allFolders.filter(code => !skusInDb.has(code));

  const summary = {
    pastas_encontradas: report.totalFolders,
    pastas_processadas: report.totalFolders - report.errors.length,
    produtos_criados: report.created.length,
    produtos_ja_existentes: report.existing.length,
    imagens_enviadas: report.imagesUploaded,
    imagens_ja_existentes_ignoradas: report.imagesSkipped,
    arquivos_ignorados_por_nao_serem_imagem: report.ignoredNonImages.length,
    qr_codes_ok: report.qrOk.length,
    qr_codes_com_problema: report.qrFailed,
    pastas_sem_imagem_valida: report.noImages,
    erros: report.errors,
    pastas_sem_produto_no_banco_apos_importacao: missingFromDb
  };

  console.log('\n=== RELATORIO FINAL ===');
  console.log(JSON.stringify(summary, null, 2));

  fs.writeFileSync(path.join(__dirname, '..', 'import-report.json'), JSON.stringify(summary, null, 2));
  console.log('\nRelatorio salvo em import-report.json');
}

main().catch(err => { console.error('Erro fatal na importacao:', err); process.exit(1); });
