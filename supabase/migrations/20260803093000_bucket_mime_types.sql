-- O bucket product-images agora guarda tambem videos e documentos (products/videos,
-- products/documents), nao só imagens. Amplia os mime types permitidos e o limite de tamanho.
update storage.buckets
set allowed_mime_types = array[
      'image/png','image/jpeg','image/webp','image/gif','image/svg+xml',
      'video/mp4','video/webm',
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'text/csv'
    ],
    file_size_limit = 62914560
where id = 'product-images';
