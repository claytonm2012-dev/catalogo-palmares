const DIACRITICS = new RegExp("[\\u0300-\\u036f]", "g");

function slugify(value) {
  return String(value || '')
    .normalize('NFD').replace(DIACRITICS, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

module.exports = slugify;
