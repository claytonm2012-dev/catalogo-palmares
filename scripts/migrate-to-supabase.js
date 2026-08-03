// Migra os dados existentes de db/catalogo.json (produtos, imagens, views, qr_scans)
// para o Supabase. Rode DEPOIS que as migrations SQL (supabase/migrations) ja foram
// aplicadas (elas ja seedam users/settings/categories). Idempotente por SKU/slug:
// produtos ja existentes no Supabase sao ignorados, nao duplicados.
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceKey) {
  console.error('SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY precisam estar no .env');
  process.exit(1);
}
const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

const sourcePath = path.join(__dirname, '..', 'db', 'catalogo.json');

async function main() {
  const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));

  const { data: existingCategories, error: catErr } = await supabase.from('categories').select('id, slug');
  if (catErr) throw catErr;
  const categoryIdSet = new Set((existingCategories || []).map(c => c.id));

  const { data: existingBrands, error: brandErr } = await supabase.from('brands').select('id');
  if (brandErr) throw brandErr;
  const brandIdSet = new Set((existingBrands || []).map(b => b.id));

  const { data: existingCollections, error: colErr } = await supabase.from('collections').select('id');
  if (colErr) throw colErr;
  const collectionIdSet = new Set((existingCollections || []).map(c => c.id));

  const oldToNewProductId = {};
  let migratedProducts = 0, skippedProducts = 0;

  const productsSorted = [...(source.products || [])].sort((a, b) => a.id - b.id);

  for (const product of productsSorted) {
    const { data: already } = await supabase.from('products').select('id').eq('sku', product.sku).limit(1);
    if (already && already.length) {
      oldToNewProductId[product.id] = already[0].id;
      skippedProducts += 1;
      console.log(`[skip] ${product.sku} já existe no Supabase (id ${already[0].id})`);
      continue;
    }

    const category_id = categoryIdSet.has(product.category_id) ? product.category_id : null;
    const brand_id = brandIdSet.has(product.brand_id) ? product.brand_id : null;
    const collection_id = collectionIdSet.has(product.collection_id) ? product.collection_id : null;
    if (product.brand_id && !brand_id) {
      console.warn(`[aviso] produto ${product.sku}: brand_id ${product.brand_id} não existe (referência órfã no JSON de origem) — migrado como null`);
    }

    const payload = {
      name: product.name,
      sku: product.sku,
      slug: product.slug,
      description_short: product.description_short || null,
      description: product.description || null,
      category_id, brand_id, collection_id,
      material: product.material || null,
      color: product.color || null,
      capacity: product.capacity || null,
      measures: product.measures || null,
      weight: product.weight || null,
      pieces_quantity: product.pieces_quantity || null,
      box_quantity: product.box_quantity || null,
      origin: product.origin || null,
      status: product.status || 'active',
      is_launch: product.is_launch || 'no',
      is_featured: product.is_featured || 'no',
      main_image: product.main_image || null,
      view_count: product.view_count || 0,
      created_at: product.created_at || new Date().toISOString(),
      updated_at: product.updated_at || product.created_at || new Date().toISOString()
    };

    const { data: inserted, error } = await supabase.from('products').insert(payload).select().single();
    if (error) throw new Error(`Falha ao migrar produto ${product.sku}: ${error.message}`);
    oldToNewProductId[product.id] = inserted.id;
    migratedProducts += 1;
    console.log(`[ok] ${product.sku} -> id ${inserted.id}`);
  }

  async function migrateChildRows(sourceKey, table, mapRow) {
    const rows = source[sourceKey] || [];
    let migrated = 0, skipped = 0;
    for (const row of rows) {
      const newProductId = oldToNewProductId[row.product_id];
      if (!newProductId) { skipped += 1; continue; }
      const payload = mapRow(row, newProductId);
      const { error } = await supabase.from(table).insert(payload);
      if (error) throw new Error(`Falha ao migrar ${table} (origem id ${row.id}): ${error.message}`);
      migrated += 1;
    }
    console.log(`${table}: ${migrated} migrados, ${skipped} ignorados (produto não migrado)`);
  }

  await migrateChildRows('product_images', 'product_images', (row, pid) => ({
    product_id: pid, url: row.url, sort_order: row.sort_order || 0, created_at: row.created_at
  }));
  await migrateChildRows('product_videos', 'product_videos', (row, pid) => ({
    product_id: pid, url: row.url, sort_order: row.sort_order || 0, created_at: row.created_at
  }));
  await migrateChildRows('product_documents', 'product_documents', (row, pid) => ({
    product_id: pid, name: row.name || null, url: row.url, created_at: row.created_at
  }));
  await migrateChildRows('product_views', 'product_views', (row, pid) => ({
    product_id: pid, origin: row.origin || 'public', device: row.device || 'desktop', created_at: row.created_at
  }));
  await migrateChildRows('qr_scans', 'qr_scans', (row, pid) => ({
    product_id: pid, created_at: row.created_at
  }));

  console.log(`\nProdutos migrados: ${migratedProducts}, já existentes (ignorados): ${skippedProducts}`);
  console.log('Migração concluída.');
}

main().catch(err => {
  console.error('Erro na migração:', err);
  process.exit(1);
});
