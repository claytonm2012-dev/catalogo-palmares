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

function isWithinDisplayWindow(product) {
  const today = new Date().toISOString().slice(0, 10);
  if (product.display_start_at && product.display_start_at > today) return false;
  if (product.display_end_at && product.display_end_at < today) return false;
  return true;
}

router.get('/', ah(async (req, res) => {
  const activeCategories = await db.listCategories({ status: 'active' });
  const categories = await Promise.all(activeCategories.map(async cat => ({
    ...cat,
    product_count: (await db.listProducts({ status: 'active', category_id: cat.id })).length
  })));
  const featuredAll = await db.listProducts({ status: 'active', is_featured: 'yes' }, [{ field: 'sort_order', direction: 'asc' }, { field: 'id', direction: 'desc' }]);
  const launchesAll = await db.listProducts({ status: 'active', is_launch: 'yes' }, [{ field: 'sort_order', direction: 'asc' }, { field: 'id', direction: 'desc' }]);
  const featured = featuredAll.filter(isWithinDisplayWindow).slice(0, 8);
  const launches = launchesAll.filter(isWithinDisplayWindow).slice(0, 8);
  const allActive = await db.listProducts({ status: 'active' });
  res.render('public/index', {
    title: 'Catálogo Virtual Grupo Palmares',
    categories, featured, launches,
    totals: { products: allActive.length, categories: categories.length }
  });
}));

router.get('/produtos', ah(async (req, res) => {
  const search = (req.query.q || '').toLowerCase();
  const categoryId = req.query.category || '';
  const brandId = req.query.brand || '';
  const filters = { status: 'active' };
  const products = await db.listProducts(filters, [{ field: 'id', direction: 'desc' }]);
  const filtered = products.filter(product => {
    const matchesSearch = !search || [product.name, product.sku, product.description, product.description_short].some(value => (value || '').toLowerCase().includes(search));
    const matchesCategory = !categoryId || product.category_id === Number(categoryId);
    const matchesBrand = !brandId || product.brand_id === Number(brandId);
    return matchesSearch && matchesCategory && matchesBrand;
  });
  const categories = await db.listCategories({ status: 'active' });
  const brands = await db.listBrands({ status: 'active' });
  res.render('public/products', { title: 'Produtos', products: filtered, categories, brands, query: search });
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
    db.listProducts({ status: 'active' }, [{ field: 'id', direction: 'asc' }])
  ]);
  const currentIndex = siblings.findIndex(item => item.id === product.id);
  const prevProduct = currentIndex > 0 ? siblings[currentIndex - 1] : siblings[siblings.length - 1];
  const nextProduct = currentIndex >= 0 && currentIndex < siblings.length - 1 ? siblings[currentIndex + 1] : siblings[0];
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
  const products = await db.listProducts({ status: 'active', category_id: category.id }, [{ field: 'id', direction: 'desc' }]);
  const categories = await db.listCategories({ status: 'active' });
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
