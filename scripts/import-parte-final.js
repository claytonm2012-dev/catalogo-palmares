// Importacao em lote a partir de PARTE FINAL, mesmo padrao estrutural de
// import-produtos-parcial.js (pasta-folha = produto, nome da pasta-folha = SKU),
// mas com uma diferenca deliberada: as imagens NAO vao para o Supabase Storage
// (bucket proximo do limite do plano gratuito) — ficam otimizadas (webp, max
// 1600px, qualidade 80) dentro do proprio projeto, em public/produtos/{SKU}/NN.webp,
// e o banco grava a URL relativa (/produtos/{SKU}/NN.webp). Produtos antigos
// continuam com suas URLs do Supabase Storage intactas (lib/image-url.js so
// transforma URLs que apontam pro Storage; URL relativa passa direto).
// Idempotente: pode ser rodado de novo com seguranca — produtos, arquivos e
// registros ja importados sao detectados e pulados, so o que falta e reprocessado.
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { createClient } = require('@supabase/supabase-js');

const SOURCE_DIR = process.env.PARTE_FINAL_SOURCE || 'C:\\Users\\Pichau\\OneDrive\\Desktop\\OneDrive_2026-09-21\\PARTE FINAL';
// NAO usar public/produtos/ direto: colide com a rota /produtos (listagem) — o
// express.static intercepta antes das rotas e faz 301 pra "/produtos/" com barra,
// quebrando a pagina. Fica em public/images/produtos/ (dentro da pasta de imagens
// estaticas ja existente, sem rota nenhuma registrada nesse caminho).
const PUBLIC_PRODUCTS_DIR = path.join(__dirname, '..', 'public', 'images', 'produtos');
const URL_PREFIX = '/images/produtos';
const CONCURRENCY = 4;
const CATEGORY_NAME = 'Catálogo Geral';
const CATEGORY_SLUG = 'catalogo-geral';
const MAX_DIMENSION = 1600;
const WEBP_QUALITY = 80;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

function isImageName(filename) {
  return /\.(jpe?g|png|webp)$/i.test(filename);
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
// O nome da pasta-folha e tratado como SKU do produto — mesma logica de
// import-produtos-parcial.js (PAGINA N e so organizacao intermediaria, nao e SKU).
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
    if (looseImages.length) mixedDirWarnings.push({ dir, looseImages });
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

// Le, valida e otimiza uma imagem (resize <=1600px no maior lado, converte pra webp
// qualidade 80). Retorna null se o arquivo nao for uma imagem decodificavel.
async function optimizeImage(localPath) {
  try {
    const buffer = fs.readFileSync(localPath);
    if (!buffer.length) return null;
    let img = sharp(buffer, { failOn: 'none' });
    const meta = await img.metadata();
    if (!meta || !meta.width || !meta.height) return null;
    if (meta.width > MAX_DIMENSION || meta.height > MAX_DIMENSION) {
      img = img.resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside', withoutEnlargement: true });
    }
    const out = await img.webp({ quality: WEBP_QUALITY }).toBuffer();
    return { originalBytes: buffer.length, optimizedBytes: out.length, buffer: out };
  } catch (err) {
    return null;
  }
}

async function processLeaf(leaf, categoryId, report, existingProductsBySku) {
  const { sku, folderPath } = leaf;
  const slug = `produto-${sku}`;
  const name = `Produto ${sku}`;
  const relFolder = path.relative(SOURCE_DIR, folderPath);
  const productDir = path.join(PUBLIC_PRODUCTS_DIR, sku);
  const detail = { sku, slug, imagem_principal: null, quantidade_imagens: 0, status: null, motivo_erro: null };

  // SKU ja existe no banco: registra como "ja existente" e para por ai — nao mexe em
  // main_image, nao adiciona imagens na galeria, nao grava nada em disco. O produto ja
  // tem seu proprio conjunto de imagens (normalmente no Supabase Storage) e a regra e
  // nao alterar produto existente sem necessidade.
  if (existingProductsBySku.has(sku)) {
    const product = existingProductsBySku.get(sku);
    report.existing.push(sku);
    detail.status = 'ja_existente';
    detail.imagem_principal = product.main_image || null;
    report.details.push(detail);
    console.log(`[JA EXISTE] SKU ${sku} (${relFolder}) — produto nao alterado`);
    return;
  }

  try {
    const rawFiles = fs.readdirSync(folderPath, { withFileTypes: true })
      .filter(d => d.isFile() && isImageName(d.name))
      .map(d => d.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    report.imagesFound += rawFiles.length;

    // Otimiza cada arquivo (valida de verdade via sharp, nao so pela extensao). Idempotente:
    // se o destino ja existe (rerun), pula a re-otimizacao mas mantem no resultado.
    fs.mkdirSync(productDir, { recursive: true });
    const results = [];
    for (let i = 0; i < rawFiles.length; i++) {
      const filename = rawFiles[i];
      const destName = `${String(i + 1).padStart(2, '0')}.webp`;
      const destPath = path.join(productDir, destName);
      const destUrl = `${URL_PREFIX}/${sku}/${destName}`;
      if (fs.existsSync(destPath)) {
        results.push({ destUrl, isNew: false });
        continue;
      }
      const optimized = await optimizeImage(path.join(folderPath, filename));
      if (!optimized) {
        report.ignoredNonImages.push(`${relFolder}/${filename}`);
        continue;
      }
      fs.writeFileSync(destPath, optimized.buffer);
      report.totalOriginalBytes += optimized.originalBytes;
      report.totalOptimizedBytes += optimized.optimizedBytes;
      report.imagesOptimized++;
      results.push({ destUrl, isNew: true });
    }

    if (!results.length) {
      report.noImages.push(sku);
      detail.status = 'erro';
      detail.motivo_erro = 'nenhuma imagem valida encontrada na pasta';
      report.details.push(detail);
      console.log(`[SEM IMAGEM VALIDA] SKU ${sku} (${relFolder})`);
      return;
    }

    detail.quantidade_imagens = results.length;
    detail.imagem_principal = results[0].destUrl;

    // SKU novo (existentes ja retornaram mais acima, sem tocar em nada) — cria o produto
    // com a capa e insere a galeria a partir do zero.
    const { data: created, error } = await supabase.from('products').insert({
      name, sku, slug, category_id: categoryId, status: 'active', is_launch: 'no', is_featured: 'no',
      main_image: results[0].destUrl
    }).select().single();
    if (error) throw error;
    const product = created;
    report.created.push(sku);

    let sortOrder = 0;
    for (const item of results) {
      if (item.destUrl === product.main_image) continue;
      await supabase.from('product_images').insert({ product_id: product.id, url: item.destUrl, sort_order: sortOrder });
      sortOrder++;
    }

    const qrResult = await evaluateQr(product);
    if (qrResult.ok) report.qrOk.push(sku); else report.qrFailed.push({ sku, status: qrResult.testStatus });

    detail.status = 'importado';
    report.details.push(detail);

    const newCount = results.filter(r => r.isNew).length;
    console.log(`[OK] SKU ${sku} (${relFolder}) — criado | ${newCount} imagem(ns) nova(s), ${results.length - newCount} ja existente(s) | QR: ${qrResult.testStatus}`);
  } catch (err) {
    detail.status = 'erro';
    detail.motivo_erro = err.message || String(err);
    report.details.push(detail);
    report.errors.push({ sku, folder: relFolder, message: err.message || String(err) });
    console.log(`[ERRO] SKU ${sku} (${relFolder}): ${err.message || err}`);
  }
}

async function main() {
  if (!fs.existsSync(SOURCE_DIR)) {
    throw new Error(`Diretorio de origem nao encontrado: ${SOURCE_DIR}`);
  }
  fs.mkdirSync(PUBLIC_PRODUCTS_DIR, { recursive: true });

  const mixedDirWarnings = [];
  let leaves = findLeafFolders(SOURCE_DIR, mixedDirWarnings);
  console.log(`Pastas-folha (produtos) encontradas em "${SOURCE_DIR}": ${leaves.length}`);

  if (mixedDirWarnings.length) {
    console.log('\n[ATENCAO] Pastas com imagens soltas junto de subpastas — essas imagens NAO sao importadas:');
    for (const { dir, looseImages } of mixedDirWarnings) console.log(`  ${dir}: ${looseImages.join(', ')}`);
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
    console.log('\n[ATENCAO] SKUs com mais de uma pasta-folha — REMOVIDOS do processamento:');
    for (const [sku, folders] of duplicateSkus) console.log(`  SKU ${sku}: ${folders.join(' | ')}`);
    leaves = leaves.filter(l => !duplicateSkus.has(l.sku));
  }

  if (process.env.PARTE_FINAL_LIMIT) {
    leaves = leaves.slice(0, parseInt(process.env.PARTE_FINAL_LIMIT, 10));
    console.log(`(modo teste: processando so as primeiras ${leaves.length} pastas)`);
  }

  const categoryId = await ensureCategory();

  const allSkus = leaves.map(l => l.sku);
  const report = {
    totalFolders: leaves.length,
    created: [], existing: [], details: [],
    imagesFound: 0, imagesOptimized: 0,
    totalOriginalBytes: 0, totalOptimizedBytes: 0,
    qrOk: [], qrFailed: [], noImages: [], ignoredNonImages: [], errors: [],
    duplicateSkus: Array.from(duplicateSkus.entries()).map(([sku, folders]) => ({ sku, folders })),
    mixedDirWarnings
  };

  const { data: existingRows } = await supabase.from('products').select('*').in('sku', allSkus);
  const existingProductsBySku = new Map((existingRows || []).map(p => [p.sku, p]));
  console.log(`Produtos ja existentes no banco (dentre os SKUs encontrados): ${existingProductsBySku.size}`);

  let done = 0;
  await mapWithConcurrency(leaves, CONCURRENCY, async (leaf) => {
    await processLeaf(leaf, categoryId, report, existingProductsBySku);
    done++;
    if (done % 25 === 0 || done === leaves.length) console.log(`--- progresso: ${done}/${leaves.length} ---`);
  });

  const { data: allSkuRows } = await supabase.from('products').select('sku').in('sku', allSkus);
  const skusInDb = new Set((allSkuRows || []).map(r => r.sku));
  const missingFromDb = allSkus.filter(sku => !skusInDb.has(sku));

  const summary = {
    pastas_analisadas: report.totalFolders,
    produtos_identificados: report.totalFolders,
    produtos_importados: report.created.length,
    produtos_ja_existentes: report.existing.length,
    produtos_com_erro: report.errors.length,
    imagens_encontradas: report.imagesFound,
    imagens_otimizadas: report.imagesOptimized,
    tamanho_original_mb: Number((report.totalOriginalBytes / (1024 * 1024)).toFixed(2)),
    tamanho_final_mb: Number((report.totalOptimizedBytes / (1024 * 1024)).toFixed(2)),
    skus_com_pasta_duplicada_ignorados: report.duplicateSkus,
    imagens_soltas_ignoradas: report.mixedDirWarnings,
    qr_codes_ok: report.qrOk.length,
    qr_codes_com_problema: report.qrFailed,
    skus_sem_imagem_valida: report.noImages,
    arquivos_ignorados_por_nao_serem_imagem: report.ignoredNonImages.length,
    erros: report.errors,
    skus_sem_produto_no_banco_apos_importacao: missingFromDb,
    produtos: report.details
  };

  console.log('\n=== RELATORIO FINAL ===');
  console.log(JSON.stringify({ ...summary, produtos: `[${summary.produtos.length} itens — ver arquivo]` }, null, 2));

  fs.writeFileSync(path.join(__dirname, '..', 'import-parte-final-report.json'), JSON.stringify(summary, null, 2));
  console.log('\nRelatorio salvo em import-parte-final-report.json');
}

main().catch(err => { console.error('Erro fatal na importacao:', err); process.exit(1); });
