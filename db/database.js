const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const dbPath = process.env.CATALOGO_DB_PATH
  ? path.resolve(process.env.CATALOGO_DB_PATH)
  : path.join(__dirname, 'catalogo.json');

const defaultState = {
  users: [],
  categories: [],
  brands: [],
  collections: [],
  products: [],
  product_images: [],
  product_videos: [],
  product_documents: [],
  product_relations: [],
  product_redirects: [],
  product_views: [],
  qr_scans: [],
  audit_logs: [],
  settings: []
};

let state = loadState();

function loadState() {
  if (!fs.existsSync(dbPath)) {
    fs.writeFileSync(dbPath, JSON.stringify(defaultState, null, 2));
    return JSON.parse(JSON.stringify(defaultState));
  }
  const loaded = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  Object.keys(defaultState).forEach(table => {
    if (!Array.isArray(loaded[table])) loaded[table] = [];
  });
  return loaded;
}

function saveState() {
  fs.writeFileSync(dbPath, JSON.stringify(state, null, 2));
}

function makeId(table) {
  const items = state[table] || [];
  return items.length ? Math.max(...items.map(item => item.id)) + 1 : 1;
}

function list(table, filters = {}, orderBy = []) {
  let items = [...(state[table] || [])];
  Object.entries(filters).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    items = items.filter(item => item[key] === value);
  });
  if (orderBy.length) {
    items.sort((a, b) => {
      for (const rule of orderBy) {
        const dir = rule.direction === 'desc' ? -1 : 1;
        if (a[rule.field] < b[rule.field]) return -1 * dir;
        if (a[rule.field] > b[rule.field]) return 1 * dir;
      }
      return 0;
    });
  }
  return items;
}

function findOne(table, filters = {}) {
  return list(table, filters)[0] || null;
}

function create(table, data) {
  const item = { id: makeId(table), ...data, created_at: new Date().toISOString() };
  state[table].push(item);
  saveState();
  return item;
}

function update(table, id, data) {
  const index = (state[table] || []).findIndex(item => item.id === Number(id));
  if (index === -1) return null;
  state[table][index] = { ...state[table][index], ...data, updated_at: new Date().toISOString() };
  saveState();
  return state[table][index];
}

function remove(table, id) {
  const prevLength = (state[table] || []).length;
  state[table] = (state[table] || []).filter(item => item.id !== Number(id));
  saveState();
  return state[table].length < prevLength;
}

function count(table, filters = {}) {
  return list(table, filters).length;
}

function initialize() {
  if (state.users.length === 0) {
    const passwordHash = bcrypt.hashSync('Palmares2026!', 10);
    create('users', { name: 'Administrador', email: 'admin@grupopalmares.com.br', password: passwordHash, role: 'admin' });
  }

  if (state.settings.length === 0) {
    const baseSettings = [
      { key: 'site_title', value: 'Grupo Palmares' },
      { key: 'site_url', value: 'https://grupopalmares.com.br/' },
      { key: 'catalog_url', value: 'https://catalogo.grupopalmares.com.br/' },
      { key: 'whatsapp', value: '(35) 99171-0177' },
      { key: 'phone', value: '(35) 3529-0700' },
      { key: 'email', value: 'contato@grupopalmares.com.br' }
    ];
    baseSettings.forEach(setting => create('settings', setting));
  }

  if (state.categories.length === 0) {
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
    categoriesSeed.forEach(([name, slug, description]) => create('categories', { name, slug, description, sort_order: 0, status: 'active' }));
  }
}

function listProducts(filters = {}, orderBy = [{ field: 'id', direction: 'desc' }], limit = null) {
  const items = list('products', filters, orderBy);
  return limit ? items.slice(0, limit) : items;
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

function isSkuTaken(sku, excludeId = null) {
  return state.products.some(p => p.sku === sku && p.id !== Number(excludeId));
}

function isSlugTaken(slug, excludeId = null) {
  return state.products.some(p => p.slug === slug && p.id !== Number(excludeId));
}

function createProduct(data) {
  if (isSkuTaken(data.sku)) throw new Error('SKU duplicado');
  if (isSlugTaken(data.slug)) throw new Error('Slug duplicado');
  return create('products', data);
}

function updateProduct(id, data) {
  if (data.sku !== undefined && isSkuTaken(data.sku, id)) throw new Error('SKU duplicado');
  if (data.slug !== undefined && isSlugTaken(data.slug, id)) throw new Error('Slug duplicado');
  const current = getProductById(id);
  if (current && data.slug !== undefined && data.slug !== current.slug) {
    create('product_redirects', { old_slug: current.slug, product_id: current.id });
  }
  return update('products', id, data);
}

function deleteProduct(id) {
  return remove('products', id);
}

function getRedirectBySlug(slug) {
  const matches = list('product_redirects', { old_slug: slug }, [{ field: 'id', direction: 'desc' }]);
  return matches[0] || null;
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

function getRelatedProducts(productId) {
  const product = getProductById(productId);
  const categoryProducts = listProducts({ status: 'active', category_id: product?.category_id }, [{ field: 'id', direction: 'desc' }], 4);
  return categoryProducts.filter(item => item.id !== Number(productId));
}

initialize();

module.exports = {
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
  state
};
