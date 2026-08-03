-- Dados iniciais essenciais (nao inclui produtos — esses vem da migracao dos dados
-- existentes em db/catalogo.json, feita pelo script scripts/migrate-to-supabase.js).

-- Usuario admin padrao. Senha real definida via ADMIN_DEFAULT_PASSWORD (.env, nao versionado) —
-- este hash bcrypt é apenas o estado já aplicado em producao, a senha em si nao fica no repositorio.
insert into users (name, email, password, role)
values ('Administrador', 'admin@grupopalmares.com', '$2a$10$67c8f.6rj08ysNdXtcea0eq12vjfOnGbWdwkbCZl/p5ya18tK.Fl.', 'admin')
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
