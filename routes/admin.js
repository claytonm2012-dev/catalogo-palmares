const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const db = require('../db/database');
const upload = require('../lib/upload');
const slugify = require('../lib/slugify');
const { getPublicSiteUrl } = require('../lib/site-url');

const productUploads = upload.fields([
  { name: 'main_image_file', maxCount: 1 },
  { name: 'gallery_files', maxCount: 10 }
]);

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  return res.redirect('/admin/login');
}

function removeUploadedFile(publicPath) {
  if (!publicPath || !publicPath.startsWith('/uploads/')) return;
  const filePath = path.join(__dirname, '..', 'public', publicPath);
  fs.unlink(filePath, () => {});
}

router.get('/', (req, res) => {
  res.redirect(req.session && req.session.user ? '/admin/dashboard' : '/admin/login');
});

router.get('/login', (req, res) => {
  if (req.session && req.session.user) return res.redirect('/admin/dashboard');
  res.render('admin/login', { title: 'Login Administrativo' });
});

router.post('/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.findOne('users', { email });
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).render('admin/login', { title: 'Login Administrativo', error: 'Credenciais inválidas' });
  }
  req.session.user = { id: user.id, email: user.email, name: user.name, role: user.role };
  res.redirect('/admin/dashboard');
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

router.get('/dashboard', requireAuth, (req, res) => {
  const stats = {
    products: db.count('products'),
    activeProducts: db.count('products', { status: 'active' }),
    categories: db.count('categories'),
    brands: db.count('brands'),
    launches: db.count('products', { is_launch: 'yes' }),
    views: db.list('products').reduce((sum, item) => sum + (item.view_count || 0), 0),
    qrScans: db.count('qr_scans')
  };
  res.render('admin/dashboard', { title: 'Dashboard', stats, user: req.session.user });
});

router.get('/products', requireAuth, (req, res) => {
  const products = db.listProducts({}, [{ field: 'id', direction: 'desc' }]);
  res.render('admin/products', { title: 'Produtos', products, user: req.session.user });
});

router.get('/products/new', requireAuth, (req, res) => {
  const categories = db.listCategories({ status: 'active' });
  const brands = db.listBrands({ status: 'active' });
  const collections = db.listCollections({ status: 'active' });
  res.render('admin/product-form', { title: 'Novo Produto', categories, brands, collections, product: null, user: req.session.user });
});

router.post('/products', requireAuth, productUploads, (req, res) => {
  const { name, sku, slug, description_short, description, category_id, brand_id, collection_id, material, color, capacity, measures, weight, pieces_quantity, box_quantity, origin, status, is_launch, is_featured } = req.body;
  const finalSlug = slugify(slug || sku);
  if (db.isSkuTaken(sku)) return res.status(400).render('admin/product-form', { title: 'Novo Produto', categories: db.listCategories({ status: 'active' }), brands: db.listBrands({ status: 'active' }), collections: db.listCollections({ status: 'active' }), product: null, user: req.session.user, error: `SKU "${sku}" já está em uso por outro produto.` });
  if (db.isSlugTaken(finalSlug)) return res.status(400).render('admin/product-form', { title: 'Novo Produto', categories: db.listCategories({ status: 'active' }), brands: db.listBrands({ status: 'active' }), collections: db.listCollections({ status: 'active' }), product: null, user: req.session.user, error: `Slug "${finalSlug}" já está em uso por outro produto.` });
  const mainImageFile = req.files && req.files.main_image_file && req.files.main_image_file[0];
  const product = db.createProduct({
    name, sku, slug: finalSlug, description_short, description,
    category_id: category_id || null, brand_id: brand_id || null, collection_id: collection_id || null,
    material, color, capacity, measures, weight, pieces_quantity, box_quantity, origin,
    status: status || 'active', is_launch: is_launch || 'no', is_featured: is_featured || 'no',
    main_image: mainImageFile ? `/uploads/${mainImageFile.filename}` : null
  });
  const galleryFiles = (req.files && req.files.gallery_files) || [];
  galleryFiles.forEach((file, i) => {
    db.create('product_images', { product_id: product.id, url: `/uploads/${file.filename}`, sort_order: i });
  });
  // createAuditLog should not fail when no user is in session (preview mode)
  db.createAuditLog({ user_id: req.session.user?.id || null, user_name: req.session.user?.name || 'preview', action: 'create', entity: 'product', entity_id: product.id, details: `Criou produto ${name}` });
  res.redirect('/admin/products');
});

router.get('/products/:id/edit', requireAuth, (req, res) => {
  const product = db.getProductById(req.params.id);
  if (!product) return res.redirect('/admin/products');
  const categories = db.listCategories({ status: 'active' });
  const brands = db.listBrands({ status: 'active' });
  const collections = db.listCollections({ status: 'active' });
  const images = db.getProductImages(product.id);
  res.render('admin/product-form', { title: 'Editar Produto', product, categories, brands, collections, images, user: req.session.user });
});

router.post('/products/:id', requireAuth, productUploads, (req, res) => {
  const { name, sku, slug, description_short, description, category_id, brand_id, collection_id, material, color, capacity, measures, weight, pieces_quantity, box_quantity, origin, status, is_launch, is_featured } = req.body;
  const current = db.getProductById(req.params.id);
  if (!current) return res.redirect('/admin/products');
  const finalSlug = slugify(slug || sku);
  const renderEditError = (error) => {
    const categories = db.listCategories({ status: 'active' });
    const brands = db.listBrands({ status: 'active' });
    const collections = db.listCollections({ status: 'active' });
    const images = db.getProductImages(current.id);
    return res.status(400).render('admin/product-form', { title: 'Editar Produto', product: current, categories, brands, collections, images, user: req.session.user, error });
  };
  if (db.isSkuTaken(sku, current.id)) return renderEditError(`SKU "${sku}" já está em uso por outro produto.`);
  if (db.isSlugTaken(finalSlug, current.id)) return renderEditError(`Slug "${finalSlug}" já está em uso por outro produto — a URL/QR Code de outro produto ficaria ambígua.`);
  const mainImageFile = req.files && req.files.main_image_file && req.files.main_image_file[0];
  const data = {
    name, sku, slug: finalSlug, description_short, description,
    category_id: category_id || null, brand_id: brand_id || null, collection_id: collection_id || null,
    material, color, capacity, measures, weight, pieces_quantity, box_quantity, origin,
    status: status || 'active', is_launch: is_launch || 'no', is_featured: is_featured || 'no'
  };
  if (mainImageFile) {
    if (current) removeUploadedFile(current.main_image);
    data.main_image = `/uploads/${mainImageFile.filename}`;
  }
  db.updateProduct(req.params.id, data);
  const galleryFiles = (req.files && req.files.gallery_files) || [];
  const existingCount = db.getProductImages(req.params.id).length;
  galleryFiles.forEach((file, i) => {
    db.create('product_images', { product_id: Number(req.params.id), url: `/uploads/${file.filename}`, sort_order: existingCount + i });
  });
  res.redirect('/admin/products/' + req.params.id + '/edit');
});

router.post('/products/:id/images/:imageId/delete', requireAuth, (req, res) => {
  const image = db.findOne('product_images', { id: Number(req.params.imageId) });
  if (image) removeUploadedFile(image.url);
  db.remove('product_images', req.params.imageId);
  res.redirect('/admin/products/' + req.params.id + '/edit');
});

router.post('/products/:id/delete', requireAuth, (req, res) => {
  const product = db.getProductById(req.params.id);
  if (product) {
    removeUploadedFile(product.main_image);
    db.getProductImages(product.id).forEach(img => removeUploadedFile(img.url));
    db.list('product_images', { product_id: product.id }).forEach(img => db.remove('product_images', img.id));
  }
  db.deleteProduct(req.params.id);
  res.redirect('/admin/products');
});

router.get('/categories', requireAuth, (req, res) => {
  const categories = db.listCategories();
  res.render('admin/categories', { title: 'Categorias', categories, user: req.session.user });
});

router.post('/categories', requireAuth, (req, res) => {
  const { name, slug, description, status } = req.body;
  db.createCategory({ name, slug, description, status: status || 'active' });
  res.redirect('/admin/categories');
});

router.post('/categories/:id', requireAuth, (req, res) => {
  const { name, slug, description, status } = req.body;
  db.updateCategory(req.params.id, { name, slug, description, status: status || 'active' });
  res.redirect('/admin/categories');
});

router.post('/categories/:id/delete', requireAuth, (req, res) => {
  db.deleteCategory(req.params.id);
  res.redirect('/admin/categories');
});

router.get('/brands', requireAuth, (req, res) => {
  const brands = db.listBrands();
  res.render('admin/brands', { title: 'Marcas', brands, user: req.session.user });
});

router.post('/brands', requireAuth, (req, res) => {
  const { name, slug, description, status } = req.body;
  db.createBrand({ name, slug, description, status: status || 'active' });
  res.redirect('/admin/brands');
});

router.post('/brands/:id', requireAuth, (req, res) => {
  const { name, slug, description, status } = req.body;
  db.updateBrand(req.params.id, { name, slug, description, status: status || 'active' });
  res.redirect('/admin/brands');
});

router.post('/brands/:id/delete', requireAuth, (req, res) => {
  db.deleteBrand(req.params.id);
  res.redirect('/admin/brands');
});

router.get('/qr-codes', requireAuth, (req, res) => {
  const products = db.listProducts({}, [{ field: 'id', direction: 'desc' }]);
  const baseUrl = getPublicSiteUrl();
  const rows = products.map(product => ({
    ...product,
    publicUrl: `${baseUrl}/produto/${product.slug}`,
    qrFile: `QR-${product.sku}.png`
  }));
  res.render('admin/qr-codes', { title: 'QR Codes', products: rows, baseUrl, usesLocalhost: baseUrl.includes('localhost'), user: req.session.user });
});

router.get('/qr-codes/export.csv', requireAuth, (req, res) => {
  const products = db.listProducts({}, [{ field: 'id', direction: 'desc' }]);
  const baseUrl = getPublicSiteUrl();
  const categories = db.listCategories();
  const escapeCsv = (value) => `"${String(value == null ? '' : value).replace(/"/g, '""')}"`;
  const header = ['SKU', 'Nome', 'Categoria', 'URL pública', 'Arquivo QR Code', 'Status'];
  const lines = [header.join(',')];
  products.forEach(product => {
    const category = categories.find(c => c.id === product.category_id);
    const resolved = db.getProductBySlug(product.slug);
    const isValid = !!product.sku && !!product.slug && resolved && resolved.id === product.id;
    lines.push([
      escapeCsv(product.sku),
      escapeCsv(product.name),
      escapeCsv(category ? category.name : ''),
      escapeCsv(`${baseUrl}/produto/${product.slug}`),
      escapeCsv(`QR-${product.sku}.png`),
      escapeCsv(isValid ? 'valido' : 'revisar')
    ].join(','));
  });
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="qr-codes-grupo-palmares.csv"');
  res.send('﻿' + lines.join('\r\n'));
});

router.get('/qr-codes/:sku/print', requireAuth, (req, res) => {
  const product = db.getProductBySku(req.params.sku);
  if (!product) return res.redirect('/admin/qr-codes');
  const publicUrl = `${getPublicSiteUrl()}/produto/${product.slug}`;
  res.render('admin/qr-print', { title: `Imprimir QR — ${product.sku}`, product, publicUrl });
});

router.get('/qr-codes/:sku/testar', requireAuth, (req, res) => {
  const product = db.getProductBySku(req.params.sku);
  if (!product) return res.status(404).json({ ok: false, error: 'SKU não encontrado' });
  const resolved = db.getProductBySlug(product.slug);
  const publicUrl = `${getPublicSiteUrl()}/produto/${product.slug}`;
  const resolvedSameProduct = !!resolved && resolved.id === product.id;
  const usesLocalhost = publicUrl.includes('localhost');
  res.json({
    ok: resolvedSameProduct && !usesLocalhost && product.status === 'active',
    sku: product.sku,
    slug: product.slug,
    status: product.status,
    publicUrl,
    usesLocalhost,
    resolvedSameProduct
  });
});

module.exports = router;
