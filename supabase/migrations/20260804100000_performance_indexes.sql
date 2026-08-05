-- Indices parciais para as consultas mais frequentes do catalogo publico
-- (destaques e lancamentos na home, ambos sempre filtrados por status='active').
create index if not exists idx_products_featured_active
  on products (sort_order, id desc)
  where status = 'active' and is_featured = 'yes';

create index if not exists idx_products_launch_active
  on products (sort_order, id desc)
  where status = 'active' and is_launch = 'yes';

-- Contagem por categoria (usada na vitrine da home) e listagem de categoria.
create index if not exists idx_products_category_active
  on products (category_id)
  where status = 'active';
