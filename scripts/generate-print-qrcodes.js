// QR Codes de impressao (300 DPI) para todos os produtos do catalogo, gerados
// somente na maquina local em QR_CODES_IMPRESSAO/ (ignorada pelo Git). Nao
// escreve no banco nem no site: so le os produtos e monta a URL publica com o
// slug real, do mesmo jeito que routes/public.js (buildProductUrl).
//
//   node scripts/generate-print-qrcodes.js
//
// Saida: PNG_300DPI/{SKU}.png (2000x2000), SVG_VETORIAL/{SKU}.svg,
// ETIQUETAS_300DPI/{SKU}.png e relatorio-validacao.csv. Cada arquivo e relido do
// disco e validado (dimensoes, pHYs 300 DPI, so preto/branco, margem, modulos
// conferidos com a matriz, decodificacao, SVG identico ao PNG, URL no ar).
// Os QR Codes de uma execucao anterior sao movidos para BACKUP_ORIGINAIS/.
// O decodificador jsQR nao e dependencia do projeto: aponte JSQR_PATH para ele.
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const sharp = require('sharp');
const jsQR = require(process.env.JSQR_PATH || 'jsqr');
const db = require('../db/database');
const { getPublicSiteUrl } = require('../lib/site-url');

const ROOT = path.resolve(process.env.QR_OUTPUT_DIR || path.join(__dirname, '..', 'QR_CODES_IMPRESSAO'));
const LIMIT = Number(process.env.QR_LIMIT) || Infinity;
// Testes parciais: QR_ONLY=SKU1,SKU2 gera so esses SKUs.
const ONLY = process.env.QR_ONLY ? new Set(process.env.QR_ONLY.split(",")) : null;
// Lotes de entrega: QR_NO_LABELS=1 gera so PNG+SVG (sem etiqueta com numero) e
// QR_DIR_SUFFIX (ex.: _SEM_NUMEROS) e acrescentado ao nome das pastas.
const NO_LABELS = process.env.QR_NO_LABELS === '1';
const DIR_SUFFIX = process.env.QR_DIR_SUFFIX || '';
const DIRS = { png: `PNG_300DPI${DIR_SUFFIX}`, svg: `SVG_VETORIAL${DIR_SUFFIX}`, ...(NO_LABELS ? {} : { label: 'ETIQUETAS_300DPI' }) };
const BACKUP_DIR = path.join(ROOT, 'BACKUP_ORIGINAIS');
const SIZE = 2000;
const DPI = 300;
const PX_PER_METER = Math.round(DPI / 0.0254);
const MIN_MARGIN_MODULES = 4;
const ECC = 'Q';
const LABEL_HEIGHT = 2500;
const LABEL_FONT_PX = 260;
// SKUs longos (ex.: Codigo_10065) diminuem a fonte para caber com respiro.
const labelFontPx = sku => Math.min(LABEL_FONT_PX, Math.floor(1700 / (String(sku).length * 0.62)));
// Tamanhos de impressao simulados na amostra (cm de lado do QR a 300 DPI).
const PRINT_TEST_CM = [2, 2.5, 3, 5, 10];
const PRINT_SAMPLE = 40;

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const csv = v => { const t = String(v ?? ''); return /[",;\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
const xml = v => String(v).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]);

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

// Geometria inteira: todo modulo tem exatamente `mod` pixels, sem interpolacao;
// a sobra de pixels vai para a margem, que nunca fica abaixo de 4 modulos.
function layout(url) {
  const qr = QRCode.create(url, { errorCorrectionLevel: ECC });
  const n = qr.modules.size;
  const mod = Math.floor(SIZE / (n + 2 * MIN_MARGIN_MODULES));
  const offset = Math.floor((SIZE - n * mod) / 2);
  return { qr, n, mod, offset, version: qr.version, dark: (r, c) => qr.modules.get(r, c) === 1 };
}

function renderPng({ n, mod, offset, dark }) {
  const raw = Buffer.alloc(SIZE * SIZE, 255);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!dark(r, c)) continue;
      for (let y = 0; y < mod; y++) raw.fill(0, (offset + r * mod + y) * SIZE + offset + c * mod, (offset + r * mod + y) * SIZE + offset + (c + 1) * mod);
    }
  }
  return sharp(raw, { raw: { width: SIZE, height: SIZE, channels: 1 } }).png({ compressionLevel: 9 }).withMetadata({ density: DPI }).toBuffer();
}

// Mesmas coordenadas em pixel do PNG; tamanho fisico = 2000 px a 300 DPI.
function renderSvg({ n, mod, offset, dark }) {
  const mm = (SIZE / DPI * 25.4).toFixed(4);
  const runs = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!dark(r, c)) continue;
      let end = c;
      while (end + 1 < n && dark(r, end + 1)) end++;
      runs.push(`M${offset + c * mod} ${offset + r * mod}h${(end - c + 1) * mod}v${mod}h-${(end - c + 1) * mod}z`);
      c = end;
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${mm}mm" height="${mm}mm" viewBox="0 0 ${SIZE} ${SIZE}" shape-rendering="crispEdges">\n<rect width="${SIZE}" height="${SIZE}" fill="#FFFFFF"/>\n<path fill="#000000" d="${runs.join('')}"/>\n</svg>\n`;
}

async function renderLabel(qrPng, sku) {
  const font = labelFontPx(sku);
  const text = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${LABEL_HEIGHT - SIZE}">
  <text x="${SIZE / 2}" y="${(LABEL_HEIGHT - SIZE) / 2 + font * 0.36 - 40}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${font}" font-weight="700" fill="#000000">${xml(sku)}</text>
</svg>`);
  return sharp({ create: { width: SIZE, height: LABEL_HEIGHT, channels: 3, background: '#FFFFFF' } })
    .composite([{ input: qrPng, top: 0, left: 0 }, { input: text, top: SIZE, left: 0 }])
    .removeAlpha().toColourspace('b-w').png({ compressionLevel: 9 }).withMetadata({ density: DPI }).toBuffer();
}

// Le o chunk pHYs direto do arquivo: o DPI tem de estar gravado, nao so no nome.
function pngDpi(buf) {
  const at = buf.indexOf('pHYs');
  if (at < 0) return null;
  const x = buf.readUInt32BE(at + 4), y = buf.readUInt32BE(at + 8), unit = buf[at + 12];
  if (unit !== 1) return null;
  return { x: x * 0.0254, y: y * 0.0254 };
}

async function gray(input, opts) {
  const { data, info } = await sharp(input, opts).flatten({ background: '#FFFFFF' }).toColourspace('b-w').raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

function decodeGray({ data, width, height, channels }) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i++, j += channels) { rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = data[j]; rgba[i * 4 + 3] = 255; }
  const result = jsQR(rgba, width, height, { inversionAttempts: 'dontInvert' });
  return result ? result.data : null;
}

async function decodeAt(input, side) {
  const buf = await sharp(input).resize(side, side, { kernel: 'lanczos3' }).toBuffer();
  return decodeGray(await gray(buf));
}

// Confere pixel a pixel: margem branca, so 0/255 e cada modulo com a cor da matriz.
function checkPixels(img, geo) {
  const { data, width } = img;
  const problems = [];
  let nonBinary = 0;
  for (let i = 0; i < data.length; i += img.channels) if (data[i] !== 0 && data[i] !== 255) nonBinary++;
  if (nonBinary) problems.push(`${nonBinary} pixels fora de preto/branco`);
  const end = geo.offset + geo.n * geo.mod;
  let marginDark = 0;
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    if (y >= geo.offset && y < end && x >= geo.offset && x < end) continue;
    if (data[(y * width + x) * img.channels] !== 255) marginDark++;
  }
  if (marginDark) problems.push(`${marginDark} pixels escuros na margem`);
  let wrong = 0;
  for (let r = 0; r < geo.n; r++) for (let c = 0; c < geo.n; c++) {
    const expected = geo.dark(r, c) ? 0 : 255;
    for (const [dy, dx] of [[0, 0], [geo.mod - 1, geo.mod - 1], [geo.mod >> 1, geo.mod >> 1]]) {
      if (data[((geo.offset + r * geo.mod + dy) * width + geo.offset + c * geo.mod + dx) * img.channels] !== expected) { wrong++; break; }
    }
  }
  if (wrong) problems.push(`${wrong} modulos divergentes da matriz`);
  if (geo.offset / geo.mod < MIN_MARGIN_MODULES) problems.push(`margem ${(geo.offset / geo.mod).toFixed(2)} modulos`);
  return problems;
}

// Faixa do SKU na etiqueta: tem de existir texto escuro, centralizado e com a
// altura esperada da fonte, sem encostar no QR nem nas bordas.
function checkLabelText(img, sku) {
  const font = labelFontPx(sku);
  let minX = Infinity, maxX = -1, minY = Infinity, maxY = -1;
  for (let y = SIZE; y < LABEL_HEIGHT; y++) for (let x = 0; x < SIZE; x++) {
    if (img.data[(y * img.width + x) * img.channels] < 128) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  }
  if (maxX < 0) return ['texto do SKU ausente'];
  const problems = [];
  const h = maxY - minY + 1;
  if (h < font * 0.6 || h > font * 1.05) problems.push(`altura do texto ${h}px`);
  if (Math.abs((minX + maxX) / 2 - SIZE / 2) > 20) problems.push('texto descentralizado');
  if (minX < 60 || maxX > SIZE - 60 || minY < SIZE + 40 || maxY > LABEL_HEIGHT - 40) problems.push('texto sem respiro');
  return problems;
}

async function checkUrl(url, sku) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Catalogo-Palmares-QR-QA/2.0' }, redirect: 'manual' });
    const body = await res.text();
    if (res.status !== 200) return `HTTP ${res.status}`;
    if (!body.includes(`<strong>SKU:</strong> ${sku} `)) return 'HTTP 200 mas a pagina nao mostra este SKU';
    return 'OK';
  } catch (err) {
    return `sem conexao: ${err.message}`;
  }
}

function backupPrevious() {
  const previous = fs.readdirSync(ROOT).filter(name => name !== 'BACKUP_ORIGINAIS');
  if (!previous.length) return null;
  const dest = path.join(BACKUP_DIR, new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(dest, { recursive: true });
  const countFiles = dir => fs.readdirSync(dir, { withFileTypes: true }).reduce((s, e) => s + (e.isDirectory() ? countFiles(path.join(dir, e.name)) : 1), 0);
  const before = previous.reduce((s, name) => s + (fs.statSync(path.join(ROOT, name)).isDirectory() ? countFiles(path.join(ROOT, name)) : 1), 0);
  previous.forEach(name => fs.renameSync(path.join(ROOT, name), path.join(dest, name)));
  const after = countFiles(dest);
  if (after !== before) throw new Error(`Backup incompleto: ${after}/${before} arquivos em ${dest}`);
  return { dir: dest, files: after };
}

async function main() {
  fs.mkdirSync(ROOT, { recursive: true });
  const base = await getPublicSiteUrl();
  if (!/^https:\/\//.test(base) || /localhost|127\.0\.0\.1/.test(base)) throw new Error(`URL publica invalida para QR: ${base}`);

  const products = await db.listProducts({}, [{ field: 'id', direction: 'asc' }], null, 'id,name,sku,slug,status');
  const pending = [];
  const bySku = new Map();
  const byFile = new Map();
  for (const p of products) {
    const sku = String(p.sku ?? '').trim();
    const slug = String(p.slug ?? '').trim();
    if (!sku || !slug) { pending.push({ id: p.id, sku, motivo: !sku ? 'sem SKU' : 'sem slug' }); continue; }
    if (/[<>:"\\/|?*\x00-\x1f]|[. ]$/.test(sku)) { pending.push({ id: p.id, sku, motivo: 'SKU invalido como nome de arquivo' }); continue; }
    if (!/^[A-Za-z0-9_-]+$/.test(slug)) { pending.push({ id: p.id, sku, motivo: `slug com caracteres inesperados: ${slug}` }); continue; }
    if (p.status !== 'active') { pending.push({ id: p.id, sku, motivo: `produto ${p.status} (pagina publica indisponivel)` }); continue; }
    // Windows nao diferencia maiusculas: "ab1" e "AB1" seriam o mesmo arquivo.
    const fileKey = sku.toLowerCase();
    if (bySku.has(sku) || byFile.has(fileKey)) { pending.push({ id: p.id, sku, motivo: `conflito de nome com o produto ${(bySku.get(sku) || byFile.get(fileKey)).id}` }); continue; }
    bySku.set(sku, p);
    byFile.set(fileKey, p);
  }
  if (ONLY) pending.splice(0, pending.length, ...pending.filter(p => ONLY.has(p.sku)));
  const conflicted = new Set(pending.filter(x => x.motivo.startsWith('conflito')).map(x => x.sku.toLowerCase()));
  const items = [...bySku.values()].filter(p => !conflicted.has(p.sku.trim().toLowerCase())).map(p => {
    const sku = p.sku.trim();
    return { id: p.id, sku, name: p.name || '', slug: p.slug.trim(), url: `${base}/produto/${p.slug.trim()}`, demo: /^DEMO-/i.test(sku) };
  }).filter(item => !ONLY || ONLY.has(item.sku)).slice(0, LIMIT);

  const backup = backupPrevious();
  if (backup) console.log(`QR Codes anteriores movidos para ${backup.dir} (${backup.files} arquivos).`);
  Object.values(DIRS).forEach(d => fs.mkdirSync(path.join(ROOT, d), { recursive: true }));

  let done = 0;
  const rows = await mapWithConcurrency(items, 4, async item => {
    const rel = { png: `${DIRS.png}/${item.sku}.png`, svg: `${DIRS.svg}/${item.sku}.svg`, label: NO_LABELS ? '' : `${DIRS.label}/${item.sku}.png` };
    const problems = [];
    const row = { ...item, ...rel, dims: '', dpi: '', decode: '', urlCheck: '', version: '' };
    try {
      const geo = layout(item.url);
      row.version = `V${geo.version}-${ECC}, modulo ${geo.mod}px, margem ${(geo.offset / geo.mod).toFixed(1)} modulos`;
      const png = await renderPng(geo);
      fs.writeFileSync(path.join(ROOT, rel.png), png);
      fs.writeFileSync(path.join(ROOT, rel.svg), renderSvg(geo), 'utf8');
      if (!NO_LABELS) fs.writeFileSync(path.join(ROOT, rel.label), await renderLabel(png, item.sku));

      // Tudo abaixo e relido do disco.
      const pngBuf = fs.readFileSync(path.join(ROOT, rel.png));
      const svgBuf = fs.readFileSync(path.join(ROOT, rel.svg));
      const labelBuf = NO_LABELS ? null : fs.readFileSync(path.join(ROOT, rel.label));
      if (!pngBuf.length || !svgBuf.length || (labelBuf && !labelBuf.length)) problems.push('arquivo vazio');
      const meta = await sharp(pngBuf).metadata();
      row.dims = `${meta.width}x${meta.height}`;
      if (meta.width !== SIZE || meta.height !== SIZE) problems.push(`PNG ${row.dims}`);
      if (meta.hasAlpha) problems.push('PNG com transparencia');
      const dpi = pngDpi(pngBuf);
      row.dpi = dpi ? `${dpi.x.toFixed(2)}x${dpi.y.toFixed(2)}` : 'ausente';
      if (!dpi || Math.abs(dpi.x - DPI) > 0.01 || Math.abs(dpi.y - DPI) > 0.01) problems.push(`DPI ${row.dpi}`);
      const pngImg = await gray(pngBuf);
      problems.push(...checkPixels(pngImg, geo));
      const decoded = decodeGray(pngImg);
      row.decodedUrl = decoded || '';
      row.decode = decoded === item.url ? 'OK' : `FALHA: ${decoded}`;
      if (decoded !== item.url) problems.push('decodificacao do PNG');

      // O arquivo declara o tamanho fisico em mm; para comparar com o PNG pixel a
      // pixel, rasteriza uma copia em memoria com 2000 px de lado (escala 1:1).
      const svgText = svgBuf.toString('utf8');
      const mm = `${(SIZE / DPI * 25.4).toFixed(4)}mm`;
      if (!svgText.includes(`width="${mm}" height="${mm}" viewBox="0 0 ${SIZE} ${SIZE}"`)) problems.push('SVG sem tamanho fisico de 300 DPI');
      const svgImg = await gray(Buffer.from(svgText.split(`"${mm}"`).join(`"${SIZE}"`)), { density: 72 });
      if (svgImg.width !== SIZE || svgImg.height !== SIZE) problems.push(`SVG rasterizado ${svgImg.width}x${svgImg.height}`);
      else {
        let diff = 0;
        for (let i = 0; i < SIZE * SIZE; i++) if ((svgImg.data[i * svgImg.channels] < 128) !== (pngImg.data[i] < 128)) diff++;
        if (diff) problems.push(`SVG difere do PNG em ${diff} pixels`);
      }
      if (decodeGray(svgImg) !== item.url) problems.push('decodificacao do SVG');

      if (labelBuf) {
      const labelMeta = await sharp(labelBuf).metadata();
      const labelDpi = pngDpi(labelBuf);
      if (labelMeta.width !== SIZE || labelMeta.height !== LABEL_HEIGHT) problems.push(`etiqueta ${labelMeta.width}x${labelMeta.height}`);
      if (labelMeta.hasAlpha) problems.push('etiqueta com transparencia');
      if (!labelDpi || Math.abs(labelDpi.x - DPI) > 0.01 || Math.abs(labelDpi.y - DPI) > 0.01) problems.push('DPI da etiqueta');
      const labelImg = await gray(labelBuf);
      let qrDiff = 0;
      for (let i = 0; i < SIZE * SIZE; i++) if (labelImg.data[i * labelImg.channels] !== pngImg.data[i]) qrDiff++;
      if (qrDiff) problems.push(`QR da etiqueta difere do PNG em ${qrDiff} pixels`);
      problems.push(...checkLabelText(labelImg, item.sku));
      if (decodeGray(labelImg) !== item.url) problems.push('decodificacao da etiqueta');
      }
      row.sha256 = sha256(pngBuf);
    } catch (err) {
      problems.push(`erro: ${err.message}`);
    }
    row.problems = problems;
    if (++done % 200 === 0 || done === items.length) console.log(`Gerados e validados: ${done}/${items.length}`);
    return row;
  });

  // Duplicatas: dois SKUs nunca podem gerar o mesmo arquivo nem a mesma URL.
  const seen = new Map();
  for (const row of rows) {
    for (const key of [`sha:${row.sha256}`, `url:${row.url}`]) {
      if (seen.has(key)) { row.problems.push(`duplicado de ${seen.get(key)}`); }
      else seen.set(key, row.sku);
    }
  }

  // Simulacao de impressao em tamanhos menores (reducao com filtro, como a impressora faria).
  const sample = [...rows.filter(r => r.demo), ...rows.filter(r => !r.demo).sort((a, b) => b.url.length - a.url.length).slice(0, 10)];
  for (let i = 0; sample.length < PRINT_SAMPLE && i < rows.length; i += Math.ceil(rows.length / PRINT_SAMPLE)) if (!sample.includes(rows[i])) sample.push(rows[i]);
  const printTests = [];
  for (const row of sample) {
    const buf = fs.readFileSync(path.join(ROOT, row.png));
    for (const cm of PRINT_TEST_CM) {
      const side = Math.round(cm / 2.54 * DPI);
      const ok = (await decodeAt(buf, side)) === row.url;
      printTests.push({ sku: row.sku, cm, px: side, ok });
      if (!ok) row.problems.push(`nao decodifica impresso com ${cm} cm`);
    }
  }

  // URLs publicas: todas, 3 por vez, para nao sobrecarregar o site.
  let checked = 0;
  await mapWithConcurrency(rows, 3, async row => {
    row.urlCheck = await checkUrl(row.url, row.sku);
    if (row.urlCheck !== 'OK') row.problems.push(`URL: ${row.urlCheck}`);
    if (++checked % 300 === 0) console.log(`URLs verificadas: ${checked}/${rows.length}`);
  });

  rows.forEach(r => { r.status = r.problems.length ? 'REPROVADO' : 'APROVADO'; });
  const header = ['SKU', 'Nome do produto', 'Slug real', 'URL publica', 'PNG', 'SVG', 'Etiqueta', 'Dimensoes', 'DPI', 'Decodificacao', 'URL decodificada', 'Verificacao da URL', 'Status final', 'Detalhes'];
  const lines = rows.map(r => [r.sku, r.name, r.slug, r.url, r.png, r.svg, r.label, r.dims, r.dpi, r.decode, r.decodedUrl, r.urlCheck, r.status,
    [r.version, r.demo ? 'produto de demonstracao (SKU DEMO)' : '', ...r.problems].filter(Boolean).join(' | ')]);
  pending.forEach(p => lines.push([p.sku, '', '', '', '', '', '', '', '', '', '', '', 'PENDENTE', `produto id ${p.id}: ${p.motivo}`]));
  fs.writeFileSync(path.join(ROOT, 'relatorio-validacao.csv'), '﻿' + [header, ...lines].map(l => l.map(csv).join(';')).join('\r\n') + '\r\n', 'utf8');

  const summary = {
    generated_at: new Date().toISOString(), base_url: base, products: products.length, skus: items.length, pending,
    png: rows.filter(r => !r.problems.some(p => /^PNG|arquivo vazio|erro/.test(p))).length,
    approved: rows.filter(r => r.status === 'APROVADO').length,
    decoded_ok: rows.filter(r => r.decode === 'OK').length,
    dpi_ok: rows.filter(r => !r.problems.some(p => /DPI/.test(p)) && r.dpi !== 'ausente').length,
    url_ok: rows.filter(r => r.urlCheck === 'OK').length,
    demo: rows.filter(r => r.demo).map(r => r.sku),
    print_tests: { sample: sample.length, sizes_cm: PRINT_TEST_CM, passed: printTests.filter(t => t.ok).length, total: printTests.length, failed: printTests.filter(t => !t.ok) },
    rejected: rows.filter(r => r.status !== 'APROVADO').map(r => ({ sku: r.sku, problems: r.problems })),
    backup
  };
  fs.writeFileSync(path.join(ROOT, 'resumo-validacao.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify({ ...summary, pending: pending.length, demo: summary.demo.length, print_tests: { ...summary.print_tests, failed: summary.print_tests.failed.length } }, null, 2));
  if (summary.rejected.length || pending.length) process.exitCode = 2;
}

main().catch(err => { console.error(err); process.exit(1); });
