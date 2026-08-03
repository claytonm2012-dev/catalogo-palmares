-- Row Level Security
-- O servidor Express (routes/public.js, routes/admin.js) usa a service_role key,
-- que ignora RLS por definicao — todo o CRUD do admin continua funcionando.
-- As policies abaixo definem o que a chave publishable/anon enxerga, caso o
-- projeto passe a fazer alguma leitura direto do navegador no futuro.
-- Por padrao: leitura publica so do que ja e publico no catalogo; nada de escrita.

alter table users enable row level security;
alter table categories enable row level security;
alter table brands enable row level security;
alter table collections enable row level security;
alter table products enable row level security;
alter table product_images enable row level security;
alter table product_videos enable row level security;
alter table product_documents enable row level security;
alter table product_relations enable row level security;
alter table product_redirects enable row level security;
alter table product_views enable row level security;
alter table qr_scans enable row level security;
alter table audit_logs enable row level security;
alter table settings enable row level security;

-- users, product_redirects, product_views, qr_scans, audit_logs, settings:
-- nenhuma policy publica — somente service_role (bypassa RLS) acessa.

drop policy if exists "public read active categories" on categories;
create policy "public read active categories"
  on categories for select
  using (status = 'active');

drop policy if exists "public read active brands" on brands;
create policy "public read active brands"
  on brands for select
  using (status = 'active');

drop policy if exists "public read active collections" on collections;
create policy "public read active collections"
  on collections for select
  using (status = 'active');

drop policy if exists "public read active products" on products;
create policy "public read active products"
  on products for select
  using (status = 'active');

drop policy if exists "public read images of active products" on product_images;
create policy "public read images of active products"
  on product_images for select
  using (exists (
    select 1 from products p where p.id = product_images.product_id and p.status = 'active'
  ));

drop policy if exists "public read videos of active products" on product_videos;
create policy "public read videos of active products"
  on product_videos for select
  using (exists (
    select 1 from products p where p.id = product_videos.product_id and p.status = 'active'
  ));

drop policy if exists "public read documents of active products" on product_documents;
create policy "public read documents of active products"
  on product_documents for select
  using (exists (
    select 1 from products p where p.id = product_documents.product_id and p.status = 'active'
  ));

drop policy if exists "public read relations of active products" on product_relations;
create policy "public read relations of active products"
  on product_relations for select
  using (exists (
    select 1 from products p where p.id = product_relations.product_id and p.status = 'active'
  ));
