// Miniaturas via Supabase Storage Image Transformations (CDN, sob demanda, sem
// precisar gerar/guardar arquivos extras). So funciona pra imagens hospedadas no
// nosso bucket do Storage — imagens estaticas locais (public/images/*) passam direto.
const TRANSFORM_MARKER = '/storage/v1/object/public/';

function withTransform(url, { width, height, quality = 75, resize = 'cover' } = {}) {
  if (!url || typeof url !== 'string' || !url.includes(TRANSFORM_MARKER)) return url;
  const base = url.replace(TRANSFORM_MARKER, '/storage/v1/render/image/public/');
  const params = new URLSearchParams();
  if (width) params.set('width', String(width));
  if (height) params.set('height', String(height));
  params.set('resize', resize);
  params.set('quality', String(quality));
  return `${base}?${params.toString()}`;
}

// Miniatura padrao pra cards de listagem/grid (produtos, relacionados, coverflow, galeria).
function cardThumb(url) {
  return withTransform(url, { width: 480, height: 480, resize: 'cover', quality: 75 });
}

module.exports = { withTransform, cardThumb };
