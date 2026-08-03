-- Bucket publico para imagens de produtos (substitui public/uploads em disco local).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-images', 'product-images', true, 8388608, array['image/png','image/jpeg','image/webp','image/gif'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Leitura publica dos arquivos (site publico exibe as fotos sem autenticacao).
drop policy if exists "product-images public read" on storage.objects;
create policy "product-images public read"
  on storage.objects for select
  using (bucket_id = 'product-images');

-- Escrita (upload/update/delete) somente via service_role (usado pelo servidor Express no /admin).
-- Anon e authenticated nao tem policy de insert/update/delete aqui de proposito:
-- o upload de imagens so acontece pelo backend autenticado do admin, nunca direto do navegador.
