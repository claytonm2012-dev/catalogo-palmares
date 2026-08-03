const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../db/database');
const { upload, uploadToStorage, removeFromStorage } = require('../lib/upload');
const slugify = require('../lib/slugify');
const { getPublicSiteUrl } = require('../lib/site-url');

const productUploads = upload.fields([
  { name: 'main_image_file', maxCount: 1 },
  { name: 'gallery_files', maxCount: 10 }
]);

function ah(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  return res.redirect('/admin/login');
}

router.get('/', (req, res) => {
  res.redirect(req.session && req.session.user ? '/admin/dashboard' : '/admin/login');
});

router.get('/login', (req, res) => {
  if (req.session && req.session.user) return res.redirect('/admin/dashboard');
  res.render('admin/login', { title: 'Login Administrativo' });
});

router.post('/login', ah(async (req, res) => {
  const { email, password } = req.body;
  const user = await db.findOne('users', { email });
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).render('admin/login', { title: 'Login Administrativo', error: 'Credenciais inválidas' });
  }
  req.session.user = { id: user.id, email: user.email, name: user.name, role: user.role };
  res.redirect('/admin/dashboard');
}));

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

router.get('/dashboard', requireAuth, ah(async (req, res) => {
  const [products, activeProducts, categories, brands, launches, allProducts, qrScans] = await Promise.all([
    db.count('products'),
    db.count('products', { status: 'active' }),
    db.count('categories'),
    db.count('brands'),
    db.count('products', { is_launch: 'yes' }),
    db.list('products'),
    db.count('qr_scans')
  ]);
  const stats = {
    products, activeProducts, categories, brands, launches,
    views: allProducts.reduce((sum, item) => sum + (item.view_count || 0), 0),
    qrScans
  };
  res.render('admin/dashboard', { title: 'Dashboard', stats, user: req.session.user });
}));

router.get('/products', requireAuth, ah(async (req, res) => {
  const products = await db.listProducts({}, [{ field: 'id', direction: 'desc' }]);
  res.render('admin/products', { title: 'Produtos', products, user: req.session.user });
}));

router.get('/products/new', requireAuth, ah(async (req, res) => {
  const [categories, brands, collections] = await Promise.all([
    db.listCategories({ status: 'active' }),
    db.listBrands({ status: 'active' }),
    db.listCollections({ status: 'active' })
  ]);
  res.render('admin/product-form', { title: 'Novo Produto', categories, brands, collections, product: null, user: req.session.user });
}));

router.post('/products', requireAuth, productUploads, ah(async (req, res) => {
  const { name, sku, slug, description_short, description, category_id, brand_id, collection_id, material, color, capacity, measures, weight, pieces_quantity, box_quantity, origin, status, is_launch, is_featured } = req.body;
  const finalSlug = slugify(slug || sku);

  const renderNewError = async (error) => {
    const [categories, brands, collections] = await Promise.all([
      db.listCategories({ status: 'active' }), db.listBrands({ status: 'active' }), db.listCollections({ status: 'active' })
    ]);
    return res.status(400).render('admin/product-form', { title: 'Novo Produto', categories, brands, collections, product: null, user: req.session.user, error });
  };

  if (await db.isSkuTaken(sku)) return renderNewError(`SKU "${sku}" já está em uso por outro produto.`);
  if (await db.isSlugTaken(finalSlug)) return renderNewError(`Slug "${finalSlug}" já está em uso por outro produto.`);

  const mainImageFile = req.files && req.files.main_image_file && req.files.main_image_file[0];
  const mainImageUrl = mainImageFile ? await uploadToStorage(mainImageFile) : null;

  const product = await db.createProduct({
    name, sku, slug: finalSlug, description_short, description,
    category_id: category_id || null, brand_id: brand_id || null, collection_id: collection_id || null,
    material, color, capacity, measures, weight, pieces_quantity, box_quantity, origin,
    status: status || 'active', is_launch: is_launch || 'no', is_featured: is_featured || 'no',
    main_image: mainImageUrl
  });

  const galleryFiles = (req.files && req.files.gallery_files) || [];
  let i = 0;
  for (const file of galleryFiles) {
    const url = await uploadToStorage(file);
    await db.create('product_images', { product_id: product.id, url, sort_order: i });
    i += 1;
  }

  // createAuditLog should not fail when no user is in session (preview mode)
  await db.createAuditLog({ user_id: req.session.user?.id || null, user_name: req.session.user?.name || 'preview', action: 'create', entity: 'product', entity_id: product.id, details: `Criou produto ${name}` });
  res.redirect('/admin/products');
}));

router.get('/products/:id/edit', requireAuth, ah(async (req, res) => {
  const product = await db.getProductById(req.params.id);
  if (!product) return res.redirect('/admin/products');
  const [categories, brands, collections, images] = await Promise.all([
    db.listCategories({ status: 'active' }),
    db.listBrands({ status: 'active' }),
    db.listCollections({ status: 'active' }),
    db.getProductImages(product.id)
  ]);
  res.render('admin/product-form', { title: 'Editar Produto', product, categories, brands, collections, images, user: req.session.user });
}));

router.post('/products/:id', requireAuth, productUploads, ah(async (req, res) => {
  const { name, sku, slug, description_short, description, category_id, brand_id, collection_id, material, color, capacity, measures, weight, pieces_quantity, box_quantity, origin, status, is_launch, is_featured } = req.body;
  const current = await db.getProductById(req.params.id);
  if (!current) return res.redirect('/admin/products');
  const finalSlug = slugify(slug || sku);

  const renderEditError = async (error) => {
    const [categories, brands, collections, images] = await Promise.all([
      db.listCategories({ status: 'active' }), db.listBrands({ status: 'active' }), db.listCollections({ status: 'active' }), db.getProductImages(current.id)
    ]);
    return res.status(400).render('admin/product-form', { title: 'Editar Produto', product: current, categories, brands, collections, images, user: req.session.user, error });
  };

  if (await db.isSkuTaken(sku, current.id)) return renderEditError(`SKU "${sku}" já está em uso por outro produto.`);
  if (await db.isSlugTaken(finalSlug, current.id)) return renderEditError(`Slug "${finalSlug}" já está em uso por outro produto — a URL/QR Code de outro produto ficaria ambígua.`);

  const mainImageFile = req.files && req.files.main_image_file && req.files.main_image_file[0];
  const data = {
    name, sku, slug: finalSlug, description_short, description,
    category_id: category_id || null, brand_id: brand_id || null, collection_id: collection_id || null,
    material, color, capacity, measures, weight, pieces_quantity, box_quantity, origin,
    status: status || 'active', is_launch: is_launch || 'no', is_featured: is_featured || 'no'
  };
  if (mainImageFile) {
    const newUrl = await uploadToStorage(mainImageFile);
    if (current.main_image) await removeFromStorage(current.main_image);
    data.main_image = newUrl;
  }
  await db.updateProduct(req.params.id, data);

  const galleryFiles = (req.files && req.files.gallery_files) || [];
  const existingCount = (await db.getProductImages(req.params.id)).length;
  let i = 0;
  for (const file of galleryFiles) {
    const url = await uploadToStorage(file);
    await db.create('product_images', { product_id: Number(req.params.id), url, sort_order: existingCount + i });
    i += 1;
  }
  res.redirect('/admin/products/' + req.params.id + '/edit');
}));

router.post('/products/:id/images/:imageId/delete', requireAuth, ah(async (req, res) => {
  const image = await db.findOne('product_images', { id: Number(req.params.imageId) });
  if (image) await removeFromStorage(image.url);
  await db.remove('product_images', req.params.imageId);
  res.redirect('/admin/products/' + req.params.id + '/edit');
}));

router.post('/products/:id/delete', requireAuth, ah(async (req, res) => {
  const product = await db.getProductById(req.params.id);
  if (product) {
    if (product.main_image) await removeFromStorage(product.main_image);
    const images = await db.getProductImages(product.id);
    for (const img of images) {
      await removeFromStorage(img.url);
      await db.remove('product_images', img.id);
    }
  }
  await db.deleteProduct(req.params.id);
  res.redirect('/admin/products');
}));

router.get('/categories', requireAuth, ah(async (req, res) => {
  const categories = await db.listCategories();
  res.render('admin/categories', { title: 'Categorias', categories, user: req.session.user });
}));

router.post('/categories', requireAuth, ah(async (req, res) => {
  const { name, slug, description, status } = req.body;
  await db.createCategory({ name, slug: slugify(slug || name), description, status: status || 'active' });
  res.redirect('/admin/categories');
}));

router.post('/categories/:id', requireAuth, ah(async (req, res) => {
  const { name, slug, description, status } = req.body;
  await db.updateCategory(req.params.id, { name, slug: slugify(slug || name), description, status: status || 'active' });
  res.redirect('/admin/categories');
}));

router.post('/categories/:id/delete', requireAuth, ah(async (req, res) => {
  await db.deleteCategory(req.params.id);
  res.redirect('/admin/categories');
}));

router.get('/brands', requireAuth, ah(async (req, res) => {
  const brands = await db.listBrands();
  res.render('admin/brands', { title: 'Marcas', brands, user: req.session.user });
}));

router.post('/brands', requireAuth, ah(async (req, res) => {
  const { name, slug, description, status } = req.body;
  await db.createBrand({ name, slug: slugify(slug || name), description, status: status || 'active' });
  res.redirect('/admin/brands');
}));

router.post('/brands/:id', requireAuth, ah(async (req, res) => {
  const { name, slug, description, status } = req.body;
  await db.updateBrand(req.params.id, { name, slug: slugify(slug || name), description, status: status || 'active' });
  res.redirect('/admin/brands');
}));

router.post('/brands/:id/delete', requireAuth, ah(async (req, res) => {
  await db.deleteBrand(req.params.id);
  res.redirect('/admin/brands');
}));

router.get('/qr-codes', requireAuth, ah(async (req, res) => {
  const products = await db.listProducts({}, [{ field: 'id', direction: 'desc' }]);
  const baseUrl = await getPublicSiteUrl();
  const rows = products.map(product => ({
    ...product,
    publicUrl: `${baseUrl}/produto/${product.slug}`,
    qrFile: `QR-${product.sku}.png`
  }));
  res.render('admin/qr-codes', { title: 'QR Codes', products: rows, baseUrl, usesLocalhost: baseUrl.includes('localhost'), user: req.session.user });
}));

router.get('/qr-codes/export.csv', requireAuth, ah(async (req, res) => {
  const [products, baseUrl, categories] = await Promise.all([
    db.listProducts({}, [{ field: 'id', direction: 'desc' }]),
    getPublicSiteUrl(),
    db.listCategories()
  ]);
  const escapeCsv = (value) => `"${String(value == null ? '' : value).replace(/"/g, '""')}"`;
  const header = ['SKU', 'Nome', 'Categoria', 'URL pública', 'Arquivo QR Code', 'Status'];
  const lines = [header.join(',')];
  for (const product of products) {
    const category = categories.find(c => c.id === product.category_id);
    const resolved = await db.getProductBySlug(product.slug);
    const isValid = !!product.sku && !!product.slug && resolved && resolved.id === product.id;
    lines.push([
      escapeCsv(product.sku),
      escapeCsv(product.name),
      escapeCsv(category ? category.name : ''),
      escapeCsv(`${baseUrl}/produto/${product.slug}`),
      escapeCsv(`QR-${product.sku}.png`),
      escapeCsv(isValid ? 'valido' : 'revisar')
    ].join(','));
  }
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="qr-codes-grupo-palmares.csv"');
  res.send('﻿' + lines.join('\r\n'));
}));

router.get('/qr-codes/:sku/print', requireAuth, ah(async (req, res) => {
  const product = await db.getProductBySku(req.params.sku);
  if (!product) return res.redirect('/admin/qr-codes');
  const baseUrl = await getPublicSiteUrl();
  const publicUrl = `${baseUrl}/produto/${product.slug}`;
  res.render('admin/qr-print', { title: `Imprimir QR — ${product.sku}`, product, publicUrl });
}));

router.get('/qr-codes/:sku/testar', requireAuth, ah(async (req, res) => {
  const product = await db.getProductBySku(req.params.sku);
  if (!product) return res.status(404).json({ ok: false, error: 'SKU não encontrado' });
  const resolved = await db.getProductBySlug(product.slug);
  const baseUrl = await getPublicSiteUrl();
  const publicUrl = `${baseUrl}/produto/${product.slug}`;
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
}));

module.exports = router;
