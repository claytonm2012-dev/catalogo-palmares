const express = require('express');
const router = express.Router();
const db = require('../db/database');
const QRCode = require('qrcode');
const { getPublicSiteUrl } = require('../lib/site-url');

function buildProductUrl(slug) {
  return `${getPublicSiteUrl()}/produto/${slug}`;
}

router.get('/', (req, res) => {
  const categories = db.listCategories({ status: 'active' }).map(cat => ({
    ...cat,
    product_count: db.listProducts({ status: 'active', category_id: cat.id }).length
  }));
  const featured = db.listProducts({ status: 'active', is_featured: 'yes' }, [{ field: 'id', direction: 'desc' }], 8);
  const launches = db.listProducts({ status: 'active', is_launch: 'yes' }, [{ field: 'id', direction: 'desc' }], 8);
  const allActive = db.listProducts({ status: 'active' });
  res.render('public/index', {
    title: 'Catálogo Virtual Grupo Palmares',
    categories, featured, launches, state: db.state,
    totals: { products: allActive.length, categories: categories.length }
  });
});

router.get('/produtos', (req, res) => {
  const search = (req.query.q || '').toLowerCase();
  const categoryId = req.query.category || '';
  const brandId = req.query.brand || '';
  const filters = { status: 'active' };
  const products = db.listProducts(filters, [{ field: 'id', direction: 'desc' }]);
  const filtered = products.filter(product => {
    const matchesSearch = !search || [product.name, product.sku, product.description, product.description_short].some(value => (value || '').toLowerCase().includes(search));
    const matchesCategory = !categoryId || product.category_id === Number(categoryId);
    const matchesBrand = !brandId || product.brand_id === Number(brandId);
    return matchesSearch && matchesCategory && matchesBrand;
  });
  const categories = db.listCategories({ status: 'active' });
  const brands = db.listBrands({ status: 'active' });
  res.render('public/products', { title: 'Produtos', products: filtered, categories, brands, query: search });
});

router.get('/produto/:slug', (req, res) => {
  let product = db.getProductBySlug(req.params.slug);
  if (!product) {
    const redirect = db.getRedirectBySlug(req.params.slug);
    const target = redirect ? db.getProductById(redirect.product_id) : null;
    if (target) return res.redirect(301, `/produto/${target.slug}`);
    return res.status(404).render('public/404', { title: 'Produto não encontrado' });
  }
  if (product.status !== 'active') {
    return res.render('public/product-unavailable', { title: product.name, product });
  }
  db.updateProduct(product.id, { view_count: (product.view_count || 0) + 1 });
  db.createProductView(product.id, 'public', 'desktop');
  const images = db.getProductImages(product.id);
  const videos = db.getProductVideos(product.id);
  const documents = db.getProductDocuments(product.id);
  const related = db.getRelatedProducts(product.id);
  const category = db.findOne('categories', { id: Number(product.category_id) }) || null;
  const brand = db.findOne('brands', { id: Number(product.brand_id) }) || null;
  const categories = db.listCategories({ status: 'active' });
  const siblings = db.listProducts({ status: 'active' }, [{ field: 'id', direction: 'asc' }]);
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
});

router.get('/categoria/:slug', (req, res) => {
  const category = db.findOne('categories', { slug: req.params.slug });
  if (!category) return res.status(404).render('public/404', { title: 'Categoria não encontrada' });
  const products = db.listProducts({ status: 'active', category_id: category.id }, [{ field: 'id', direction: 'desc' }]);
  const categories = db.listCategories({ status: 'active' });
  res.render('public/category', { title: category.name, category, products, categories });
});

router.get('/pesquisa', (req, res) => {
  const query = (req.query.q || '').trim().toLowerCase();
  const products = db.listProducts({ status: 'active' }, [{ field: 'id', direction: 'desc' }], 10).filter(product => [product.name, product.sku, product.description].some(value => (value || '').toLowerCase().includes(query)));
  res.json(products);
});

router.get('/qr/:sku.svg', (req, res) => {
  const product = db.getProductBySku(req.params.sku);
  if (!product) return res.status(404).send('Produto não encontrado');
  const url = buildProductUrl(product.slug);
  QRCode.toString(url, { type: 'svg', margin: 2 }, (err, svg) => {
    if (err) return res.status(500).send('Não foi possível gerar QR Code');
    res.set('Content-Type', 'image/svg+xml');
    res.set('Content-Disposition', `attachment; filename="QR-${product.sku}.svg"`);
    res.send(svg);
  });
});

router.get('/qr/:sku', (req, res) => {
  const product = db.getProductBySku(req.params.sku);
  if (!product) return res.status(404).json({ error: 'Produto não encontrado' });
  db.createQrScan(product.id);
  const url = buildProductUrl(product.slug);
  // support two formats: image fetch (accepts image/*) and JSON
  QRCode.toDataURL(url, { margin: 2, width: 350 }, (err, dataUrl) => {
    if (err) return res.status(500).json({ error: 'Não foi possível gerar QR Code' });
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
  });
});

module.exports = router;
