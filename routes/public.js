const express = require('express');
const router = express.Router();
const db = require('../db/database');
const QRCode = require('qrcode');
const { getPublicSiteUrl } = require('../lib/site-url');

function ah(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

async function buildProductUrl(slug) {
  const base = await getPublicSiteUrl();
  return `${base}/produto/${slug}`;
}

function qrToDataUrl(url, options) {
  return new Promise((resolve, reject) => {
    QRCode.toDataURL(url, options, (err, dataUrl) => (err ? reject(err) : resolve(dataUrl)));
  });
}

function qrToSvg(url, options) {
  return new Promise((resolve, reject) => {
    QRCode.toString(url, options, (err, svg) => (err ? reject(err) : resolve(svg)));
  });
}

// Cache do processo (por instancia serverless "quente"): o QR de um SKU so muda se o
// slug do produto mudar, entao gerar de novo a cada request e desperdicio. Combinado
// com o Cache-Control HTTP abaixo, a grande maioria dos hits nem chega a rodar a
// biblioteca de QR Code de novo.
const qrMemoryCache = new Map();
async function getOrGenerateQr(cacheKey, generator) {
  const cached = qrMemoryCache.get(cacheKey);
  if (cached) return cached;
  const value = await generator();
  qrMemoryCache.set(cacheKey, value);
  return value;
}

function isWithinDisplayWindow(product) {
  const today = new Date().toISOString().slice(0, 10);
  if (product.display_start_at && product.display_start_at > today) return false;
  if (product.display_end_at && product.display_end_at < today) return false;
  return true;
}

router.get('/', ah(async (req, res) => {
  // 5 consultas independentes de uma vez (em vez de 1 por categoria + varias
  // sequenciais): a contagem por categoria agora e uma unica query agregada.
  const [activeCategories, categoryCounts, featuredAll, launchesAll, totalActive] = await Promise.all([
    db.listCategories({ status: 'active' }),
    db.getCategoryProductCounts(),
    db.listProducts({ status: 'active', is_featured: 'yes' }, [{ field: 'sort_order', direction: 'asc' }, { field: 'id', direction: 'desc' }]),
    db.listProducts({ status: 'active', is_launch: 'yes' }, [{ field: 'sort_order', direction: 'asc' }, { field: 'id', direction: 'desc' }]),
    db.count('products', { status: 'active' })
  ]);
  const categories = activeCategories.map(cat => ({ ...cat, product_count: categoryCounts[cat.id] || 0 }));
  const featured = featuredAll.filter(isWithinDisplayWindow).slice(0, 8);
  const launches = launchesAll.filter(isWithinDisplayWindow).slice(0, 8);
  res.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
  res.render('public/index', {
    title: 'Catálogo Virtual Grupo Palmares',
    categories, featured, launches,
    totals: { products: totalActive, categories: categories.length }
  });
}));

router.get('/produtos', ah(async (req, res) => {
  const search = (req.query.q || '').toLowerCase();
  const categoryId = req.query.category || '';
  const brandId = req.query.brand || '';
  const filters = { status: 'active' };
  const [products, categories, brands] = await Promise.all([
    db.listProducts(filters, [{ field: 'id', direction: 'desc' }]),
    db.listCategories({ status: 'active' }),
    db.listBrands({ status: 'active' })
  ]);
  const filtered = products.filter(product => {
    const matchesSearch = !search || [product.name, product.sku, product.description, product.description_short].some(value => (value || '').toLowerCase().includes(search));
    const matchesCategory = !categoryId || product.category_id === Number(categoryId);
    const matchesBrand = !brandId || product.brand_id === Number(brandId);
    return matchesSearch && matchesCategory && matchesBrand;
  });

  const pageSize = 24;
  const totalResults = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalResults / pageSize));
  const currentPage = Math.min(Math.max(1, parseInt(req.query.page, 10) || 1), totalPages);
  const paged = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  res.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
  res.render('public/products', {
    title: 'Produtos', products: paged, categories, brands, query: search,
    pagination: { page: currentPage, totalPages, totalResults },
    filters: { q: search, category: categoryId, brand: brandId }
  });
}));

router.get('/produto/:slug', ah(async (req, res) => {
  let product = await db.getProductBySlug(req.params.slug);
  if (!product) {
    const redirect = await db.getRedirectBySlug(req.params.slug);
    const target = redirect ? await db.getProductById(redirect.product_id) : null;
    if (target) return res.redirect(301, `/produto/${target.slug}`);
    return res.status(404).render('public/404', { title: 'Produto não encontrado' });
  }
  if (product.status !== 'active') {
    return res.render('public/product-unavailable', { title: product.name, product });
  }
  await db.updateProduct(product.id, { view_count: (product.view_count || 0) + 1 });
  await db.createProductView(product.id, 'public', 'desktop');
  const [images, videos, documents, related, category, brand, categories, siblings] = await Promise.all([
    db.getProductImages(product.id),
    db.getProductVideos(product.id),
    db.getProductDocuments(product.id),
    db.getRelatedProducts(product.id),
    db.findOne('categories', { id: Number(product.category_id) }),
    db.findOne('brands', { id: Number(product.brand_id) }),
    db.listCategories({ status: 'active' }),
    db.getProductNavList()
  ]);
  const currentIndex = siblings.findIndex(item => item.id === product.id);
  const prevProduct = currentIndex > 0 ? siblings[currentIndex - 1] : siblings[siblings.length - 1];
  const nextProduct = currentIndex >= 0 && currentIndex < siblings.length - 1 ? siblings[currentIndex + 1] : siblings[0];
  res.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
  res.render('public/product', {
    title: product.name,
    product: { ...product, category_name: category?.name || '—', category_slug: category?.slug || 'diversos', brand_name: brand?.name || '—' },
    images, videos, documents, related, categories,
    prevProduct: prevProduct && prevProduct.id !== product.id ? prevProduct : null,
    nextProduct: nextProduct && nextProduct.id !== product.id ? nextProduct : null
  });
}));

router.get('/categoria/:slug', ah(async (req, res) => {
  const category = await db.findOne('categories', { slug: req.params.slug });
  if (!category) return res.status(404).render('public/404', { title: 'Categoria não encontrada' });
  const [products, categories] = await Promise.all([
    db.listProducts({ status: 'active', category_id: category.id }, [{ field: 'id', direction: 'desc' }]),
    db.listCategories({ status: 'active' })
  ]);
  res.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
  res.render('public/category', { title: category.name, category, products, categories });
}));

router.get('/pesquisa', ah(async (req, res) => {
  const query = (req.query.q || '').trim().toLowerCase();
  const products = (await db.listProducts({ status: 'active' }, [{ field: 'id', direction: 'desc' }], 10))
    .filter(product => [product.name, product.sku, product.description].some(value => (value || '').toLowerCase().includes(query)));
  res.json(products);
}));

router.get('/qr/:sku.svg', ah(async (req, res) => {
  const product = await db.getProductBySku(req.params.sku);
  if (!product) return res.status(404).send('Produto não encontrado');
  const url = await buildProductUrl(product.slug);
  const svg = await qrToSvg(url, { type: 'svg', margin: 2 });
  res.set('Content-Type', 'image/svg+xml');
  res.set('Content-Disposition', `attachment; filename="QR-${product.sku}.svg"`);
  res.send(svg);
}));

router.get('/qr/:sku', ah(async (req, res) => {
  const product = await db.getProductBySku(req.params.sku);
  if (!product) return res.status(404).json({ error: 'Produto não encontrado' });
  await db.createQrScan(product.id);
  const url = await buildProductUrl(product.slug);
  const dataUrl = await qrToDataUrl(url, { margin: 2, width: 350 });
  const wantsImage = (req.headers.accept && req.headers.accept.indexOf('image') !== -1) || req.query.download || req.query.format === 'png';
  if (wantsImage) {
    const matches = dataUrl.match(/^data:(image\/png);base64,(.+)$/);
    if (!matches) return res.status(500).send('invalid');
    const img = Buffer.from(matches[2], 'base64');
    res.set('Content-Type', 'image/png');
    if (req.query.download) res.set('Content-Disposition', `attachment; filename="QR-${product.sku}.png"`);
    return res.send(img);
  }
  res.json({ url, qrCode: dataUrl, sku: product.sku, slug: product.slug });
}));

module.exports = router;
