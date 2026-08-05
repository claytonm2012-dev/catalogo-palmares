// Recompacta as imagens estaticas de public/images/ no mesmo caminho e com as
// mesmas dimensoes (mozjpeg, qualidade 80) — reduz o tamanho do arquivo sem
// mexer em template/DB, ja que a URL nao muda. So sobrescreve se o resultado
// realmente ficar menor (nunca piora nada).
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..', 'public', 'images');

function collectJpegs(dir) {
  let results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results = results.concat(collectJpegs(full));
    else if (/\.jpe?g$/i.test(entry.name)) results.push(full);
  }
  return results;
}

async function main() {
  const files = collectJpegs(ROOT);
  let totalBefore = 0, totalAfter = 0, changed = 0;
  for (const file of files) {
    const before = fs.statSync(file).size;
    const buffer = fs.readFileSync(file);
    const compressed = await sharp(buffer).jpeg({ quality: 80, mozjpeg: true }).toBuffer();
    totalBefore += before;
    if (compressed.length < before) {
      fs.writeFileSync(file, compressed);
      totalAfter += compressed.length;
      changed++;
      console.log(`${path.relative(ROOT, file)}: ${(before / 1024).toFixed(0)}KB -> ${(compressed.length / 1024).toFixed(0)}KB`);
    } else {
      totalAfter += before;
      console.log(`${path.relative(ROOT, file)}: ja otimizado, mantido (${(before / 1024).toFixed(0)}KB)`);
    }
  }
  console.log(`\n${changed}/${files.length} arquivos recompactados.`);
  console.log(`Total: ${(totalBefore / 1024).toFixed(0)}KB -> ${(totalAfter / 1024).toFixed(0)}KB (${(100 - (totalAfter / totalBefore) * 100).toFixed(0)}% menor)`);
}

main().catch(err => { console.error(err); process.exit(1); });
