const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { upload, productMediaUpload, uploadToStorage, removeFromStorage } = require('../lib/upload');
const slugify = require('../lib/slugify');
const { getPublicSiteUrl } = require('../lib/site-url');
const { authClient } = require('../lib/supabase-auth');
const { parseCookies, setAuthCookies, clearAuthCookies, getAdminFromRequest, ACCESS_COOKIE, REFRESH_COOKIE } = require('../lib/admin-session');

const productUploads = productMediaUpload.fields([
  { name: 'main_image_file', maxCount: 1 },
  { name: 'gallery_files', maxCount: 10 },
  { name: 'video_file', maxCount: 1 },
  { name: 'document_file', maxCount: 1 }
]);

function ah(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

// Nada no painel administrativo pode ser cacheado publicamente (dados privados,
// autenticacao, formularios com estado). Explicito em vez de depender do default.
router.use((req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  next();
});

// Le e valida a sessao do Supabase Auth (com renovacao automatica via refresh token) e
// so libera acesso se o e-mail corresponder a um perfil com role "admin" em `users`.
function requireAuth(req, res, next) {
  getAdminFromRequest(req, res)
    .then(admin => {
      if (!admin) return res.redirect('/admin/login');
      req.adminUser = admin;
      next();
    })
    .catch(next);
}

function toNullable(value) {
  return value === undefined || value === '' ? null : value;
}

async function logAction(req, action, entity, entityId, details) {
  await db.createAuditLog({
    user_id: req.adminUser?.id || null,
    user_name: req.adminUser?.name || 'preview',
    action, entity, entity_id: entityId, details
  });
}

router.get('/', ah(async (req, res) => {
  const admin = await getAdminFromRequest(req, res);
  res.redirect(admin ? '/admin/dashboard' : '/admin/login');
}));

router.get('/login', ah(async (req, res) => {
  const admin = await getAdminFromRequest(req, res);
  if (admin) return res.redirect('/admin/dashboard');
  res.render('admin/login', { title: 'Login Administrativo' });
}));

router.post('/login', ah(async (req, res) => {
  const { email, password } = req.body;
  const { data, error } = await authClient.auth.signInWithPassword({ email, password });
  if (error || !data || !data.session) {
    return res.status(401).render('admin/login', { title: 'Login Administrativo', error: 'Credenciais inválidas' });
  }
  const profile = await db.findOne('users', { email });
  if (!profile || profile.role !== 'admin') {
    return res.status(403).render('admin/login', { title: 'Login Administrativo', error: 'Este usuário não tem permissão de administrador.' });
  }
  setAuthCookies(res, data.session);
  res.redirect('/admin/dashboard');
}));

router.get('/logout', ah(async (req, res) => {
  const cookies = parseCookies(req);
  const accessToken = cookies[ACCESS_COOKIE];
  const refreshToken = cookies[REFRESH_COOKIE];
  if (accessToken && refreshToken) {
    try {
      await authClient.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
      await authClient.auth.signOut();
    } catch (err) { /* best-effort revoke — cookies are cleared regardless */ }
  }
  clearAuthCookies(res);
  res.redirect('/admin/login');
}));

router.get('/dashboard', requireAuth, ah(async (req, res) => {
  const [
    products, activeProducts, categories, brands, launches, featuredCount, allProducts, qrScans, recentProducts, recentLogs
  ] = await Promise.all([
    db.count('products'),
    db.count('products', { status: 'active' }),
    db.count('categories'),
    db.count('brands'),
    db.count('products', { is_launch: 'yes' }),
    db.count('products', { is_featured: 'yes' }),
    db.list('products', {}, [], null, 'id,name,view_count,main_image,last_qr_test_status'),
    db.count('qr_scans'),
    db.listProducts({}, [{ field: 'id', direction: 'desc' }], 5),
    db.list('audit_logs', {}, [{ field: 'id', direction: 'desc' }], 8)
  ]);
  const qrTested = allProducts.filter(p => p.last_qr_test_status).length;
  const qrErrors = allProducts.filter(p => p.last_qr_test_status && p.last_qr_test_status !== 'funcionando').length;
  const mostViewed = [...allProducts].sort((a, b) => (b.view_count || 0) - (a.view_count || 0)).slice(0, 5);
  const brokenImages = allProducts.filter(p => !p.main_image);
  const stats = {
    products, activeProducts, inactiveProducts: products - activeProducts, categories, brands, launches,
    featured: featuredCount,
    views: allProducts.reduce((sum, item) => sum + (item.view_count || 0), 0),
    qrScans, qrTested, qrErrors
  };
  res.render('admin/dashboard', {
    title: 'Dashboard', active: 'dashboard', stats, user: req.adminUser,
    recentProducts, mostViewed, recentLogs, brokenImages
  });
}));

router.get('/products', requireAuth, ah(async (req, res) => {
  const { q, category, brand, status, featured, launch, page } = req.query;
  const [allProducts, categories, brands] = await Promise.all([
    db.listProducts({}, [{ field: 'id', direction: 'desc' }]),
    db.listCategories(),
    db.listBrands()
  ]);
  const search = (q || '').trim().toLowerCase();
  let filtered = allProducts.filter(p => {
    const matchesSearch = !search || [p.name, p.sku, p.slug].some(v => (v || '').toLowerCase().includes(search));
    const matchesCategory = !category || String(p.category_id) === String(category);
    const matchesBrand = !brand || String(p.brand_id) === String(brand);
    const matchesStatus = !status || p.status === status;
    const matchesFeatured = !featured || p.is_featured === featured;
    const matchesLaunch = !launch || p.is_launch === launch;
    return matchesSearch && matchesCategory && matchesBrand && matchesStatus && matchesFeatured && matchesLaunch;
  });

  const pageSize = 20;
  const currentPage = Math.max(1, parseInt(page, 10) || 1);
  const totalResults = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalResults / pageSize));
  const pageSafe = Math.min(currentPage, totalPages);
  const products = filtered.slice((pageSafe - 1) * pageSize, pageSafe * pageSize);

  res.render('admin/products', {
    title: 'Produtos', active: 'products', products, categories, brands, user: req.adminUser,
    filters: { q: q || '', category: category || '', brand: brand || '', status: status || '', featured: featured || '', launch: launch || '' },
    pagination: { page: pageSafe, totalPages, totalResults, pageSize }
  });
}));

router.get('/products/new', requireAuth, ah(async (req, res) => {
  const [categories, brands, collections] = await Promise.all([
    db.listCategories({ status: 'active' }),
    db.listBrands({ status: 'active' }),
    db.listCollections({ status: 'active' })
  ]);
  res.render('admin/product-form', { title: 'Novo Produto', active: 'products', categories, brands, collections, product: null, user: req.adminUser });
}));

function buildProductData(body) {
  const { name, sku, slug, description_short, description, category_id, brand_id, collection_id, material, color, capacity, measures, weight, pieces_quantity, box_quantity, origin, status, is_launch, is_featured, whatsapp_message, display_start_at, display_end_at, sort_order } = body;
  return {
    name, sku, slug: slugify(slug || sku), description_short, description,
    category_id: category_id || null, brand_id: brand_id || null, collection_id: collection_id || null,
    material, color, capacity, measures, weight, pieces_quantity, box_quantity, origin,
    status: status || 'active', is_launch: is_launch || 'no', is_featured: is_featured || 'no',
    whatsapp_message: toNullable(whatsapp_message),
    display_start_at: toNullable(display_start_at),
    display_end_at: toNullable(display_end_at),
    sort_order: parseInt(sort_order, 10) || 0
  };
}

router.post('/products', requireAuth, productUploads, ah(async (req, res) => {
  const data = buildProductData(req.body);

  const renderNewError = async (error) => {
    const [categories, brands, collections] = await Promise.all([
      db.listCategories({ status: 'active' }), db.listBrands({ status: 'active' }), db.listCollections({ status: 'active' })
    ]);
    return res.status(400).render('admin/product-form', { title: 'Novo Produto', active: 'products', categories, brands, collections, product: null, user: req.adminUser, error });
  };

  if (await db.isSkuTaken(data.sku)) return renderNewError(`SKU "${data.sku}" já está em uso por outro produto.`);
  if (await db.isSlugTaken(data.slug)) return renderNewError(`Slug "${data.slug}" já está em uso por outro produto.`);

  const mainImageFile = req.files && req.files.main_image_file && req.files.main_image_file[0];
  data.main_image = mainImageFile ? await uploadToStorage(mainImageFile, 'products/images') : null;

  const product = await db.createProduct(data);

  const galleryFiles = (req.files && req.files.gallery_files) || [];
  let i = 0;
  for (const file of galleryFiles) {
    const url = await uploadToStorage(file, 'products/images');
    await db.create('product_images', { product_id: product.id, url, sort_order: i });
    i += 1;
  }

  const videoFile = req.files && req.files.video_file && req.files.video_file[0];
  if (videoFile) {
    const url = await uploadToStorage(videoFile, 'products/videos');
    await db.create('product_videos', { product_id: product.id, url, sort_order: 0 });
  } else if (req.body.video_url) {
    await db.create('product_videos', { product_id: product.id, url: req.body.video_url, sort_order: 0 });
  }

  const documentFile = req.files && req.files.document_file && req.files.document_file[0];
  if (documentFile) {
    const url = await uploadToStorage(documentFile, 'products/documents');
    await db.create('product_documents', { product_id: product.id, url, name: req.body.document_name || documentFile.originalname, doc_type: req.body.document_type || 'documento' });
  }

  await logAction(req, 'create', 'product', product.id, `Criou produto ${data.name}`);
  res.redirect('/admin/products');
}));

router.get('/products/:id/edit', requireAuth, ah(async (req, res) => {
  const product = await db.getProductById(req.params.id);
  if (!product) return res.redirect('/admin/products');
  const [categories, brands, collections, images, videos, documents] = await Promise.all([
    db.listCategories({ status: 'active' }),
    db.listBrands({ status: 'active' }),
    db.listCollections({ status: 'active' }),
    db.getProductImages(product.id),
    db.getProductVideos(product.id),
    db.getProductDocuments(product.id)
  ]);
  res.render('admin/product-form', { title: 'Editar Produto', active: 'products', product, categories, brands, collections, images, videos, documents, user: req.adminUser });
}));

router.post('/products/:id', requireAuth, productUploads, ah(async (req, res) => {
  const current = await db.getProductById(req.params.id);
  if (!current) return res.redirect('/admin/products');
  const data = buildProductData(req.body);

  const renderEditError = async (error) => {
    const [categories, brands, collections, images, videos, documents] = await Promise.all([
      db.listCategories({ status: 'active' }), db.listBrands({ status: 'active' }), db.listCollections({ status: 'active' }),
      db.getProductImages(current.id), db.getProductVideos(current.id), db.getProductDocuments(current.id)
    ]);
    return res.status(400).render('admin/product-form', { title: 'Editar Produto', active: 'products', product: current, categories, brands, collections, images, videos, documents, user: req.adminUser, error });
  };

  if (await db.isSkuTaken(data.sku, current.id)) return renderEditError(`SKU "${data.sku}" já está em uso por outro produto.`);
  if (await db.isSlugTaken(data.slug, current.id)) return renderEditError(`Slug "${data.slug}" já está em uso por outro produto — a URL/QR Code de outro produto ficaria ambígua.`);

  const mainImageFile = req.files && req.files.main_image_file && req.files.main_image_file[0];
  if (mainImageFile) {
    const newUrl = await uploadToStorage(mainImageFile, 'products/images');
    if (current.main_image) await removeFromStorage(current.main_image);
    data.main_image = newUrl;
  }
  await db.updateProduct(req.params.id, data);

  const galleryFiles = (req.files && req.files.gallery_files) || [];
  const existingCount = (await db.getProductImages(req.params.id)).length;
  let i = 0;
  for (const file of galleryFiles) {
    const url = await uploadToStorage(file, 'products/images');
    await db.create('product_images', { product_id: Number(req.params.id), url, sort_order: existingCount + i });
    i += 1;
  }

  const videoFile = req.files && req.files.video_file && req.files.video_file[0];
  if (videoFile) {
    const url = await uploadToStorage(videoFile, 'products/videos');
    await db.create('product_videos', { product_id: current.id, url, sort_order: 0 });
  } else if (req.body.video_url) {
    await db.create('product_videos', { product_id: current.id, url: req.body.video_url, sort_order: 0 });
  }

  const documentFile = req.files && req.files.document_file && req.files.document_file[0];
  if (documentFile) {
    const url = await uploadToStorage(documentFile, 'products/documents');
    await db.create('product_documents', { product_id: current.id, url, name: req.body.document_name || documentFile.originalname, doc_type: req.body.document_type || 'documento' });
  }

  await logAction(req, 'update', 'product', current.id, `Editou produto ${data.name}`);
  res.redirect('/admin/products/' + req.params.id + '/edit');
}));

router.post('/products/:id/duplicate', requireAuth, ah(async (req, res) => {
  const original = await db.getProductById(req.params.id);
  if (!original) return res.redirect('/admin/products');
  const suffix = Date.now().toString().slice(-5);
  const newSku = `${original.sku}-COPIA-${suffix}`;
  const newSlug = slugify(`${original.slug}-copia-${suffix}`);
  const copy = { ...original };
  delete copy.id; delete copy.created_at; delete copy.updated_at;
  copy.sku = newSku;
  copy.slug = newSlug;
  copy.name = `${original.name} (cópia)`;
  copy.status = 'inactive';
  copy.view_count = 0;
  copy.last_qr_test_status = null;
  copy.last_qr_test_at = null;
  const created = await db.createProduct(copy);

  const images = await db.getProductImages(original.id);
  for (const img of images) {
    await db.create('product_images', { product_id: created.id, url: img.url, sort_order: img.sort_order });
  }

  await logAction(req, 'duplicate', 'product', created.id, `Duplicou produto ${original.name} (origem #${original.id})`);
  res.redirect('/admin/products/' + created.id + '/edit');
}));

router.post('/products/:id/images/:imageId/delete', requireAuth, ah(async (req, res) => {
  const image = await db.findOne('product_images', { id: Number(req.params.imageId) });
  if (image) await removeFromStorage(image.url);
  await db.remove('product_images', req.params.imageId);
  res.redirect('/admin/products/' + req.params.id + '/edit');
}));

router.post('/products/:id/images/:imageId/move', requireAuth, ah(async (req, res) => {
  await db.reorderProductImage(req.params.imageId, req.body.direction === 'up' ? 'up' : 'down');
  res.redirect('/admin/products/' + req.params.id + '/edit');
}));

router.post('/products/:id/videos/:videoId/delete', requireAuth, ah(async (req, res) => {
  const video = await db.findOne('product_videos', { id: Number(req.params.videoId) });
  if (video) await removeFromStorage(video.url);
  await db.remove('product_videos', req.params.videoId);
  res.redirect('/admin/products/' + req.params.id + '/edit');
}));

router.post('/products/:id/documents/:documentId/delete', requireAuth, ah(async (req, res) => {
  const document = await db.findOne('product_documents', { id: Number(req.params.documentId) });
  if (document) await removeFromStorage(document.url);
  await db.remove('product_documents', req.params.documentId);
  res.redirect('/admin/products/' + req.params.id + '/edit');
}));

router.post('/products/:id/delete', requireAuth, ah(async (req, res) => {
  const product = await db.getProductById(req.params.id);
  if (product) {
    if (product.main_image) await removeFromStorage(product.main_image);
    const [images, videos, documents] = await Promise.all([
      db.getProductImages(product.id), db.getProductVideos(product.id), db.getProductDocuments(product.id)
    ]);
    for (const img of images) { await removeFromStorage(img.url); await db.remove('product_images', img.id); }
    for (const vid of videos) { await removeFromStorage(vid.url); await db.remove('product_videos', vid.id); }
    for (const doc of documents) { await removeFromStorage(doc.url); await db.remove('product_documents', doc.id); }
    await logAction(req, 'delete', 'product', product.id, `Excluiu produto ${product.name}`);
  }
  await db.deleteProduct(req.params.id);
  res.redirect('/admin/products');
}));

router.get('/categories', requireAuth, ah(async (req, res) => {
  const categories = await db.listCategories();
  const withCounts = await Promise.all(categories.map(async cat => ({ ...cat, product_count: await db.countProductsByCategory(cat.id) })));
  res.render('admin/categories', { title: 'Categorias', active: 'categories', categories: withCounts, user: req.adminUser });
}));

router.post('/categories', requireAuth, upload.single('image'), ah(async (req, res) => {
  const { name, slug, description, status } = req.body;
  const image = req.file ? await uploadToStorage(req.file, 'categories') : null;
  const category = await db.createCategory({ name, slug: slugify(slug || name), description, status: status || 'active', image });
  await logAction(req, 'create', 'category', category.id, `Criou categoria ${name}`);
  res.redirect('/admin/categories');
}));

router.post('/categories/:id', requireAuth, upload.single('image'), ah(async (req, res) => {
  const { name, slug, description, status } = req.body;
  const data = { name, slug: slugify(slug || name), description, status: status || 'active' };
  if (req.file) {
    const current = await db.findOne('categories', { id: Number(req.params.id) });
    data.image = await uploadToStorage(req.file, 'categories');
    if (current && current.image) await removeFromStorage(current.image);
  }
  await db.updateCategory(req.params.id, data);
  await logAction(req, 'update', 'category', Number(req.params.id), `Editou categoria ${name}`);
  res.redirect('/admin/categories');
}));

router.post('/categories/:id/delete', requireAuth, ah(async (req, res) => {
  const productCount = await db.countProductsByCategory(req.params.id);
  if (productCount > 0 && req.body.confirmed !== '1') {
    const categories = await db.listCategories();
    const withCounts = await Promise.all(categories.map(async cat => ({ ...cat, product_count: await db.countProductsByCategory(cat.id) })));
    return res.status(400).render('admin/categories', {
      title: 'Categorias', active: 'categories', categories: withCounts, user: req.adminUser,
      error: `Esta categoria tem ${productCount} produto(s) vinculado(s). Mova os produtos para outra categoria antes de excluir, ou confirme a exclusão mesmo assim (os produtos ficarão sem categoria).`
    });
  }
  const category = await db.findOne('categories', { id: Number(req.params.id) });
  if (category && category.image) await removeFromStorage(category.image);
  await db.deleteCategory(req.params.id);
  await logAction(req, 'delete', 'category', Number(req.params.id), `Excluiu categoria (${productCount} produtos afetados)`);
  res.redirect('/admin/categories');
}));

router.get('/brands', requireAuth, ah(async (req, res) => {
  const brands = await db.listBrands();
  const withCounts = await Promise.all(brands.map(async brand => ({ ...brand, product_count: await db.countProductsByBrand(brand.id) })));
  res.render('admin/brands', { title: 'Marcas', active: 'brands', brands: withCounts, user: req.adminUser });
}));

router.post('/brands', requireAuth, upload.single('logo'), ah(async (req, res) => {
  const { name, slug, description, status, website } = req.body;
  const logo = req.file ? await uploadToStorage(req.file, 'brands') : null;
  const brand = await db.createBrand({ name, slug: slugify(slug || name), description, status: status || 'active', website: toNullable(website), logo });
  await logAction(req, 'create', 'brand', brand.id, `Criou marca ${name}`);
  res.redirect('/admin/brands');
}));

router.post('/brands/:id', requireAuth, upload.single('logo'), ah(async (req, res) => {
  const { name, slug, description, status, website } = req.body;
  const data = { name, slug: slugify(slug || name), description, status: status || 'active', website: toNullable(website) };
  if (req.file) {
    const current = await db.findOne('brands', { id: Number(req.params.id) });
    data.logo = await uploadToStorage(req.file, 'brands');
    if (current && current.logo) await removeFromStorage(current.logo);
  }
  await db.updateBrand(req.params.id, data);
  await logAction(req, 'update', 'brand', Number(req.params.id), `Editou marca ${name}`);
  res.redirect('/admin/brands');
}));

router.post('/brands/:id/delete', requireAuth, ah(async (req, res) => {
  const productCount = await db.countProductsByBrand(req.params.id);
  if (productCount > 0 && req.body.confirmed !== '1') {
    const brands = await db.listBrands();
    const withCounts = await Promise.all(brands.map(async brand => ({ ...brand, product_count: await db.countProductsByBrand(brand.id) })));
    return res.status(400).render('admin/brands', {
      title: 'Marcas', active: 'brands', brands: withCounts, user: req.adminUser,
      error: `Esta marca tem ${productCount} produto(s) vinculado(s). Mova os produtos para outra marca antes de excluir, ou confirme a exclusão mesmo assim (os produtos ficarão sem marca).`
    });
  }
  const brand = await db.findOne('brands', { id: Number(req.params.id) });
  if (brand && brand.logo) await removeFromStorage(brand.logo);
  await db.deleteBrand(req.params.id);
  await logAction(req, 'delete', 'brand', Number(req.params.id), `Excluiu marca (${productCount} produtos afetados)`);
  res.redirect('/admin/brands');
}));

const SETTINGS_LABELS = {
  site_title: 'Título do site',
  site_url: 'URL institucional',
  catalog_url: 'Domínio público do catálogo (usado nos QR Codes)',
  whatsapp: 'WhatsApp',
  phone: 'Telefone',
  email: 'E-mail de contato',
  instagram_url: 'Link do Instagram',
  facebook_url: 'Link do Facebook',
  institutional_years: 'Anos de tradição (número exibido no site)',
  hero_fallback_title: 'Título do Hero (quando não há produto em destaque)',
  hero_fallback_subtitle: 'Subtítulo do Hero (quando não há produto em destaque)'
};

router.get('/settings', requireAuth, ah(async (req, res) => {
  const map = await db.getSettingsMap();
  const rows = Object.keys(SETTINGS_LABELS).map(key => ({ key, label: SETTINGS_LABELS[key], value: map[key] || '' }));
  res.render('admin/settings', { title: 'Configurações do site', active: 'settings', rows, user: req.adminUser });
}));

router.post('/settings', requireAuth, ah(async (req, res) => {
  for (const key of Object.keys(SETTINGS_LABELS)) {
    if (req.body[key] !== undefined) await db.upsertSetting(key, req.body[key]);
  }
  await logAction(req, 'update', 'settings', null, 'Atualizou configurações do site');
  res.redirect('/admin/settings');
}));

router.get('/logs', requireAuth, ah(async (req, res) => {
  const logs = await db.list('audit_logs', {}, [{ field: 'id', direction: 'desc' }], 200);
  res.render('admin/logs', { title: 'Histórico de ações', active: 'logs', logs, user: req.adminUser });
}));

router.get('/qr-codes', requireAuth, ah(async (req, res) => {
  const products = await db.listProducts({}, [{ field: 'id', direction: 'desc' }]);
  const baseUrl = await getPublicSiteUrl();
  const rows = products.map(product => ({
    ...product,
    publicUrl: `${baseUrl}/produto/${product.slug}`,
    qrFile: `QR-${product.sku}.png`
  }));
  res.render('admin/qr-codes', { title: 'QR Codes', active: 'qr-codes', products: rows, baseUrl, usesLocalhost: baseUrl.includes('localhost'), user: req.adminUser });
}));

router.get('/qr-codes/export.csv', requireAuth, ah(async (req, res) => {
  const [products, baseUrl, categories] = await Promise.all([
    db.listProducts({}, [{ field: 'id', direction: 'desc' }]),
    getPublicSiteUrl(),
    db.listCategories()
  ]);
  const escapeCsv = (value) => `"${String(value == null ? '' : value).replace(/"/g, '""')}"`;
  const header = ['SKU', 'Nome', 'Categoria', 'URL pública', 'Arquivo QR Code', 'Status', 'Último teste'];
  const lines = [header.join(',')];
  // slug e unico no banco (constraint), entao validar contra a lista ja carregada
  // equivale a validar contra o banco de novo — sem precisar de 1 query por produto.
  const bySlug = new Map(products.map(p => [p.slug, p]));
  for (const product of products) {
    const category = categories.find(c => c.id === product.category_id);
    const resolved = bySlug.get(product.slug);
    const isValid = !!product.sku && !!product.slug && resolved && resolved.id === product.id;
    lines.push([
      escapeCsv(product.sku),
      escapeCsv(product.name),
      escapeCsv(category ? category.name : ''),
      escapeCsv(`${baseUrl}/produto/${product.slug}`),
      escapeCsv(`QR-${product.sku}.png`),
      escapeCsv(isValid ? 'valido' : 'revisar'),
      escapeCsv(product.last_qr_test_at || '')
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

async function evaluateQrTest(product) {
  const resolved = await db.getProductBySlug(product.slug);
  const baseUrl = await getPublicSiteUrl();
  const publicUrl = `${baseUrl}/produto/${product.slug}`;
  const usesLocalhost = publicUrl.includes('localhost');
  let testStatus;
  if (usesLocalhost) testStatus = 'erro_dominio';
  else if (!resolved) testStatus = 'pagina_inexistente';
  else if (resolved.id !== product.id) testStatus = 'produto_incorreto';
  else if (resolved.status !== 'active') testStatus = 'produto_inativo';
  else testStatus = 'funcionando';
  const testedAt = new Date().toISOString();
  await db.updateProduct(product.id, { last_qr_test_status: testStatus, last_qr_test_at: testedAt });
  return {
    ok: testStatus === 'funcionando',
    sku: product.sku, slug: product.slug, status: product.status,
    publicUrl, usesLocalhost, resolvedSameProduct: !!resolved && resolved.id === product.id,
    testStatus, testedAt
  };
}

router.get('/qr-codes/:sku/testar', requireAuth, ah(async (req, res) => {
  const product = await db.getProductBySku(req.params.sku);
  if (!product) return res.status(404).json({ ok: false, error: 'SKU não encontrado' });
  const result = await evaluateQrTest(product);
  res.json(result);
}));

router.post('/qr-codes/testar-todos', requireAuth, ah(async (req, res) => {
  const products = await db.listProducts({});
  const results = [];
  for (const product of products) {
    results.push(await evaluateQrTest(product));
  }
  const summary = results.reduce((acc, r) => { acc[r.testStatus] = (acc[r.testStatus] || 0) + 1; return acc; }, {});
  res.json({ total: results.length, summary, results });
}));

module.exports = router;
