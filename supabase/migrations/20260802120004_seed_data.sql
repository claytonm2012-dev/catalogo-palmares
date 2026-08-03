-- Dados iniciais essenciais (nao inclui produtos — esses vem da migracao dos dados
-- existentes em db/catalogo.json, feita pelo script scripts/migrate-to-supabase.js).

-- Usuario admin padrao. Senha: Palmares2026! (mesmo hash que ja estava em producao local).
insert into users (name, email, password, role)
values ('Administrador', 'admin@grupopalmares.com.br', '$2a$10$kVDhldCBc7EiCGLkn7beKeZvhRamnXJoZMqTKxY9OxzLheBWwE9Ue', 'admin')
on conflict (email) do nothing;

insert into settings (key, value) values
  ('site_title', 'Grupo Palmares'),
  ('site_url', 'https://grupopalmares.com.br/'),
  ('catalog_url', 'https://catalogo.grupopalmares.com.br/'),
  ('whatsapp', '(35) 99171-0177'),
  ('phone', '(35) 3529-0700'),
  ('email', 'contato@grupopalmares.com.br')
on conflict (key) do nothing;

insert into categories (name, slug, description, sort_order, status) values
  ('Importados', 'importados', 'Produtos importados', 0, 'active'),
  ('Vidro', 'vidro', 'Produtos em vidro', 0, 'active'),
  ('Porcelanas', 'porcelanas', 'Porcelanas', 0, 'active'),
  ('Térmico', 'termico', 'Produtos térmicos', 0, 'active'),
  ('Metalúrgico', 'metalurgico', 'Produtos metalúrgicos', 0, 'active'),
  ('Inox', 'inox', 'Produtos em inox', 0, 'active'),
  ('Alumínio', 'aluminio', 'Produtos em alumínio', 0, 'active'),
  ('Plástico', 'plastico', 'Produtos em plástico', 0, 'active'),
  ('Diversos', 'diversos', 'Diversos produtos', 0, 'active')
on conflict (slug) do nothing;
