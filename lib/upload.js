const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const db = require('../db/database');

const BUCKET = 'product-images';

function imageFileFilter(_req, file, cb) {
  if (/^image\//.test(file.mimetype)) return cb(null, true);
  cb(new Error('Apenas arquivos de imagem são permitidos'));
}

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: imageFileFilter,
  limits: { fileSize: 8 * 1024 * 1024 }
});

async function uploadToStorage(file) {
  const ext = path.extname(file.originalname || '') || '';
  const objectPath = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
  const { error } = await db.supabase.storage
    .from(BUCKET)
    .upload(objectPath, file.buffer, { contentType: file.mimetype, upsert: false });
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

module.exports = { upload, uploadToStorage, removeFromStorage };
