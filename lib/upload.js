const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const db = require('../db/database');

const BUCKET = 'product-images';

function makeFilter(allowedPattern, message) {
  return (_req, file, cb) => {
    if (allowedPattern.test(file.mimetype)) return cb(null, true);
    cb(new Error(message));
  };
}

const imageFilter = makeFilter(/^image\/(png|jpeg|webp|gif|svg\+xml)$/, 'Apenas imagens PNG, JPG, WEBP, GIF ou SVG são permitidas');
const videoFilter = makeFilter(/^video\/(mp4|webm)$/, 'Apenas vídeos MP4 ou WEBM são permitidos');
const documentFilter = makeFilter(/^(application\/pdf|application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|application\/vnd\.ms-excel|text\/csv)$/, 'Apenas PDF, XLSX ou CSV são permitidos');

const upload = multer({ storage: multer.memoryStorage(), fileFilter: imageFilter, limits: { fileSize: 8 * 1024 * 1024 } });
const uploadVideo = multer({ storage: multer.memoryStorage(), fileFilter: videoFilter, limits: { fileSize: 60 * 1024 * 1024 } });
const uploadDocument = multer({ storage: multer.memoryStorage(), fileFilter: documentFilter, limits: { fileSize: 15 * 1024 * 1024 } });

const IMAGE_FIELDS = new Set(['main_image_file', 'gallery_files', 'image']);
const VIDEO_FIELDS = new Set(['video_file']);
const DOCUMENT_FIELDS = new Set(['document_file']);

function productMediaFilter(_req, file, cb) {
  if (IMAGE_FIELDS.has(file.fieldname)) return imageFilter(_req, file, cb);
  if (VIDEO_FIELDS.has(file.fieldname)) return videoFilter(_req, file, cb);
  if (DOCUMENT_FIELDS.has(file.fieldname)) return documentFilter(_req, file, cb);
  cb(new Error('Campo de arquivo desconhecido'));
}

const productMediaUpload = multer({ storage: multer.memoryStorage(), fileFilter: productMediaFilter, limits: { fileSize: 60 * 1024 * 1024 } });

function safeName(originalname) {
  const ext = path.extname(originalname || '') || '';
  return `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
}

async function uploadToStorage(file, folder = 'products/images') {
  const objectPath = `${folder}/${safeName(file.originalname)}`;
  const { error } = await db.supabase.storage
    .from(BUCKET)
    // Nome do arquivo e unico (timestamp + random) — o conteudo nunca muda no
    // mesmo caminho, entao pode cachear por 1 ano sem risco de servir algo velho.
    .upload(objectPath, file.buffer, { contentType: file.mimetype, cacheControl: '31536000', upsert: false });
  if (error) throw error;
  const { data } = db.supabase.storage.from(BUCKET).getPublicUrl(objectPath);
  return data.publicUrl;
}

function extractObjectPath(publicUrl) {
  if (!publicUrl) return null;
  const marker = `/object/public/${BUCKET}/`;
  const index = publicUrl.indexOf(marker);
  if (index === -1) return null;
  return publicUrl.slice(index + marker.length);
}

async function removeFromStorage(publicUrl) {
  const objectPath = extractObjectPath(publicUrl);
  if (!objectPath) return;
  await db.supabase.storage.from(BUCKET).remove([objectPath]);
}

module.exports = { upload, uploadVideo, uploadDocument, productMediaUpload, uploadToStorage, removeFromStorage };
