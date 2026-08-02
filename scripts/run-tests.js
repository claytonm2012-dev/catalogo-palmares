const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const seedPath = path.join(__dirname, '..', 'db', 'catalogo.seed.json');
const tmpPath = path.join(os.tmpdir(), `catalogo-test-${process.pid}-${Date.now()}.json`);
fs.copyFileSync(seedPath, tmpPath);

const result = spawnSync(process.execPath, ['--test'], {
  stdio: 'inherit',
  cwd: path.join(__dirname, '..'),
  env: {
    ...process.env,
    CATALOGO_DB_PATH: tmpPath,
    PUBLIC_SITE_URL: process.env.PUBLIC_SITE_URL || 'https://catalogo.grupopalmares.com.br'
  }
});

fs.unlinkSync(tmpPath);
process.exit(result.status === null ? 1 : result.status);
