require('dotenv').config({ quiet: true });
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceKey) {
  throw new Error('SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY precisam estar definidos (.env)');
}

const supabase = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

function applyFilters(query, filters = {}) {
  let q = query;
  Object.entries(filters).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    q = q.eq(key, value);
  });
  return q;
}

async function list(table, filters = {}, orderBy = [], limit = null) {
  let q = supabase.from(table).select('*');
  q = applyFilters(q, filters);
  orderBy.forEach(rule => { q = q.order(rule.field, { ascending: rule.direction !== 'desc' }); });
  if (limit) q = q.limit(limit);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

async function findOne(table, filters = {}) {
  const items = await list(table, filters, [], 1);
  return items[0] || null;
}

async function create(table, data) {
  const { data: rows, error } = await supabase.from(table).insert(data).select();
  if (error) throw error;
  return rows[0];
}

async function update(table, id, data) {
  const { data: rows, error } = await supabase.from(table).update(data).eq('id', Number(id)).select();
  if (error) throw error;
  return rows[0] || null;
}

async function remove(table, id) {
  const { data: rows, error } = await supabase.from(table).delete().eq('id', Number(id)).select();
  if (error) throw error;
  return (rows || []).length > 0;
}

async function count(table, filters = {}) {
  let q = supabase.from(table).select('*', { count: 'exact', head: true });
  q = applyFilters(q, filters);
  const { count: total, error } = await q;
  if (error) throw error;
  return total || 0;
}

async function initialize() {
  const userCount = await count('users');
  if (userCount === 0) {
    const email = process.env.ADMIN_DEFAULT_EMAIL;
    const password = process.env.ADMIN_DEFAULT_PASSWORD || require('crypto').randomBytes(9).toString('base64url');
    if (!process.env.ADMIN_DEFAULT_EMAIL || !process.env.ADMIN_DEFAULT_PASSWORD) {
      console.warn(`[db] ADMIN_DEFAULT_EMAIL/ADMIN_DEFAULT_PASSWORD não definidos — usuário admin inicial criado com email "${email || 'admin@example.com'}" e senha temporária: ${password} (troque no primeiro acesso)`);
    }
    const passwordHash = bcrypt.hashSync(password, 10);
    await create('users', { name: 'Administrador', email: email || 'admin@example.com', password: passwordHash, role: 'admin' });
  }

  const settingsCount = await count('settings');
  if (settingsCount === 0) {
    const baseSettings = [
      { key: 'site_title', value: 'Grupo Palmares' },
      { key: 'site_url', value: 'https://grupopalmares.com.br/' },
      { key: 'catalog_url', value: 'https://catalogo.grupopalmares.com.br/' },
      { key: 'whatsapp', value: '(35) 99171-0177' },
      { key: 'phone', value: '(35) 3529-0700' },
      { key: 'email', value: 'contato@grupopalmares.com.br' },
      { key: 'instagram_url', value: '' },
      { key: 'facebook_url', value: '' },
      { key: 'institutional_years', value: '30' },
      { key: 'hero_fallback_title', value: 'Catálogo Virtual <span class="hl">Grupo Palmares</span>' },
      { key: 'hero_fallback_subtitle', value: 'Explore nosso catálogo digital de utilidades domésticas e produtos industriais.' }
    ];
    for (const setting of baseSettings) await create('settings', setting);
  }

  const categoriesCount = await count('categories');
  if (categoriesCount === 0) {
    const categoriesSeed = [
      ['Importados', 'importados', 'Produtos importados'],
      ['Vidro', 'vidro', 'Produtos em vidro'],
      ['Porcelanas', 'porcelanas', 'Porcelanas'],
      ['Térmico', 'termico', 'Produtos térmicos'],
      ['Metalúrgico', 'metalurgico', 'Produtos metalúrgicos'],
      ['Inox', 'inox', 'Produtos em inox'],
      ['Alumínio', 'aluminio', 'Produtos em alumínio'],
      ['Plástico', 'plastico', 'Produtos em plástico'],
      ['Diversos', 'diversos', 'Diversos produtos']
    ];
    for (const [name, slug, description] of categoriesSeed) {
      await create('categories', { name, slug, description, sort_order: 0, status: 'active' });
    }
  }
}

function listProducts(filters = {}, orderBy = [{ field: 'id', direction: 'desc' }], limit = null) {
  return list('products', filters, orderBy, limit);
}

function getProductBySlug(slug) {
  return findOne('products', { slug });
}

function getProductBySku(sku) {
  return findOne('products', { sku });
}

function getProductById(id) {
  return findOne('products', { id: Number(id) });
}

async function isSkuTaken(sku, excludeId = null) {
  let q = supabase.from('products').select('id').eq('sku', sku);
  if (excludeId) q = q.neq('id', Number(excludeId));
  const { data, error } = await q;
  if (error) throw error;
  return (data || []).length > 0;
}

async function isSlugTaken(slug, excludeId = null) {
  let q = supabase.from('products').select('id').eq('slug', slug);
  if (excludeId) q = q.neq('id', Number(excludeId));
  const { data, error } = await q;
  if (error) throw error;
  return (data || []).length > 0;
}

async function createProduct(data) {
  if (await isSkuTaken(data.sku)) throw new Error('SKU duplicado');
  if (await isSlugTaken(data.slug)) throw new Error('Slug duplicado');
  return create('products', data);
}

async function updateProduct(id, data) {
  if (data.sku !== undefined && await isSkuTaken(data.sku, id)) throw new Error('SKU duplicado');
  if (data.slug !== undefined && await isSlugTaken(data.slug, id)) throw new Error('Slug duplicado');
  const current = await getProductById(id);
  if (current && data.slug !== undefined && data.slug !== current.slug) {
    await create('product_redirects', { old_slug: current.slug, product_id: current.id });
  }
  return update('products', id, data);
}

function deleteProduct(id) {
  return remove('products', id);
}

async function getRedirectBySlug(slug) {
  const { data, error } = await supabase
    .from('product_redirects')
    .select('*')
    .eq('old_slug', slug)
    .order('id', { ascending: false })
    .limit(1);
  if (error) throw error;
  return (data && data[0]) || null;
}

function listCategories(filters = {}) {
  return list('categories', filters, [{ field: 'sort_order', direction: 'asc' }, { field: 'id', direction: 'asc' }]);
}

function listBrands(filters = {}) {
  return list('brands', filters, [{ field: 'name', direction: 'asc' }]);
}

function listCollections(filters = {}) {
  return list('collections', filters, [{ field: 'name', direction: 'asc' }]);
}

function createCategory(data) {
  return create('categories', data);
}

function updateCategory(id, data) {
  return update('categories', id, data);
}

function deleteCategory(id) {
  return remove('categories', id);
}

function createBrand(data) {
  return create('brands', data);
}

function updateBrand(id, data) {
  return update('brands', id, data);
}

function deleteBrand(id) {
  return remove('brands', id);
}

function createAuditLog(data) {
  return create('audit_logs', data);
}

function createProductView(productId, origin = 'public', device = 'desktop') {
  return create('product_views', { product_id: productId, origin, device });
}

function createQrScan(productId) {
  return create('qr_scans', { product_id: productId });
}

function getProductImages(productId) {
  return list('product_images', { product_id: Number(productId) }, [{ field: 'sort_order', direction: 'asc' }]);
}

function getProductVideos(productId) {
  return list('product_videos', { product_id: Number(productId) }, [{ field: 'sort_order', direction: 'asc' }]);
}

function getProductDocuments(productId) {
  return list('product_documents', { product_id: Number(productId) }, [{ field: 'id', direction: 'asc' }]);
}

async function getRelatedProducts(productId) {
  const product = await getProductById(productId);
  const categoryProducts = await listProducts({ status: 'active', category_id: product?.category_id }, [{ field: 'id', direction: 'desc' }], 4);
  return categoryProducts.filter(item => item.id !== Number(productId));
}

async function getSettingsMap() {
  const rows = await list('settings');
  const map = {};
  rows.forEach(row => { map[row.key] = row.value; });
  return map;
}

async function upsertSetting(key, value) {
  const existing = await findOne('settings', { key });
  if (existing) return update('settings', existing.id, { value });
  return create('settings', { key, value });
}

async function countProductsByCategory(categoryId) {
  return count('products', { category_id: Number(categoryId) });
}

async function countProductsByBrand(brandId) {
  return count('products', { brand_id: Number(brandId) });
}

async function reorderProductImage(imageId, direction) {
  const image = await findOne('product_images', { id: Number(imageId) });
  if (!image) return null;
  const siblings = await list('product_images', { product_id: image.product_id }, [{ field: 'sort_order', direction: 'asc' }]);
  const index = siblings.findIndex(item => item.id === image.id);
  const swapIndex = direction === 'up' ? index - 1 : index + 1;
  if (swapIndex < 0 || swapIndex >= siblings.length) return image;
  const swapWith = siblings[swapIndex];
  await update('product_images', image.id, { sort_order: swapWith.sort_order });
  await update('product_images', swapWith.id, { sort_order: image.sort_order });
  return image;
}

const ready = initialize().catch(err => {
  console.error('[db] Falha ao inicializar dados padrão no Supabase:', err.message);
  throw err;
});

module.exports = {
  ready,
  supabase,
  list,
  findOne,
  create,
  update,
  remove,
  count,
  initialize,
  listProducts,
  getProductBySlug,
  getProductBySku,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct,
  isSkuTaken,
  isSlugTaken,
  getRedirectBySlug,
  listCategories,
  listBrands,
  listCollections,
  createCategory,
  updateCategory,
  deleteCategory,
  createBrand,
  updateBrand,
  deleteBrand,
  createAuditLog,
  createProductView,
  createQrScan,
  getProductImages,
  getProductVideos,
  getProductDocuments,
  getRelatedProducts,
  getSettingsMap,
  upsertSetting,
  countProductsByCategory,
  countProductsByBrand,
  reorderProductImage
};
