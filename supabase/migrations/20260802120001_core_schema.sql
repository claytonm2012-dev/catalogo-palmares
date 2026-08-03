-- Grupo Palmares — schema principal do catalogo
-- Tabelas, relacionamentos, indices, constraints e triggers de updated_at.

create extension if not exists pgcrypto;

create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ===================== users =====================
create table if not exists users (
  id bigint generated always as identity primary key,
  name text not null,
  email text not null unique,
  password text not null,
  role text not null default 'admin',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
drop trigger if exists trg_users_updated_at on users;
create trigger trg_users_updated_at before update on users
  for each row execute function set_updated_at();

-- ===================== categories =====================
create table if not exists categories (
  id bigint generated always as identity primary key,
  name text not null,
  slug text not null unique,
  description text,
  sort_order int not null default 0,
  status text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
drop trigger if exists trg_categories_updated_at on categories;
create trigger trg_categories_updated_at before update on categories
  for each row execute function set_updated_at();

-- ===================== brands =====================
create table if not exists brands (
  id bigint generated always as identity primary key,
  name text not null,
  slug text not null unique,
  description text,
  status text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
drop trigger if exists trg_brands_updated_at on brands;
create trigger trg_brands_updated_at before update on brands
  for each row execute function set_updated_at();

-- ===================== collections =====================
create table if not exists collections (
  id bigint generated always as identity primary key,
  name text not null,
  slug text unique,
  status text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
drop trigger if exists trg_collections_updated_at on collections;
create trigger trg_collections_updated_at before update on collections
  for each row execute function set_updated_at();

-- ===================== products =====================
-- sku e slug sao o vinculo permanente produto <-> QR Code: precisam ser unicos.
create table if not exists products (
  id bigint generated always as identity primary key,
  name text not null,
  sku text not null unique,
  slug text not null unique,
  description_short text,
  description text,
  category_id bigint references categories(id) on delete set null,
  brand_id bigint references brands(id) on delete set null,
  collection_id bigint references collections(id) on delete set null,
  material text,
  color text,
  capacity text,
  measures text,
  weight text,
  pieces_quantity text,
  box_quantity text,
  origin text,
  status text not null default 'active' check (status in ('active','inactive')),
  is_launch text not null default 'no' check (is_launch in ('yes','no')),
  is_featured text not null default 'no' check (is_featured in ('yes','no')),
  main_image text,
  view_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_products_category on products(category_id);
create index if not exists idx_products_brand on products(brand_id);
create index if not exists idx_products_status on products(status);
drop trigger if exists trg_products_updated_at on products;
create trigger trg_products_updated_at before update on products
  for each row execute function set_updated_at();

-- ===================== product_images =====================
create table if not exists product_images (
  id bigint generated always as identity primary key,
  product_id bigint not null references products(id) on delete cascade,
  url text not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists idx_product_images_product on product_images(product_id);

-- ===================== product_videos =====================
create table if not exists product_videos (
  id bigint generated always as identity primary key,
  product_id bigint not null references products(id) on delete cascade,
  url text not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists idx_product_videos_product on product_videos(product_id);

-- ===================== product_documents =====================
create table if not exists product_documents (
  id bigint generated always as identity primary key,
  product_id bigint not null references products(id) on delete cascade,
  name text,
  url text not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_product_documents_product on product_documents(product_id);

-- ===================== product_relations =====================
create table if not exists product_relations (
  id bigint generated always as identity primary key,
  product_id bigint not null references products(id) on delete cascade,
  related_product_id bigint not null references products(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists idx_product_relations_product on product_relations(product_id);

-- ===================== product_redirects =====================
-- URL antiga -> produto atual, para nao quebrar QR Codes ja impressos quando o slug muda.
create table if not exists product_redirects (
  id bigint generated always as identity primary key,
  old_slug text not null,
  product_id bigint not null references products(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists idx_product_redirects_old_slug on product_redirects(old_slug);

-- ===================== product_views =====================
create table if not exists product_views (
  id bigint generated always as identity primary key,
  product_id bigint not null references products(id) on delete cascade,
  origin text,
  device text,
  created_at timestamptz not null default now()
);
create index if not exists idx_product_views_product on product_views(product_id);

-- ===================== qr_scans =====================
create table if not exists qr_scans (
  id bigint generated always as identity primary key,
  product_id bigint not null references products(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists idx_qr_scans_product on qr_scans(product_id);

-- ===================== audit_logs =====================
-- entity_id e polimorfico (produto, categoria, marca...): sem FK de proposito.
create table if not exists audit_logs (
  id bigint generated always as identity primary key,
  user_id bigint references users(id) on delete set null,
  user_name text,
  action text not null,
  entity text not null,
  entity_id bigint,
  details text,
  created_at timestamptz not null default now()
);

-- ===================== settings =====================
create table if not exists settings (
  id bigint generated always as identity primary key,
  key text not null unique,
  value text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
drop trigger if exists trg_settings_updated_at on settings;
create trigger trg_settings_updated_at before update on settings
  for each row execute function set_updated_at();
