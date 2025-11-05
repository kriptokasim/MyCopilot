// zip.js — Node.js script to create a zip using archiver
// Usage:
//   npm install
//   node zip.js
import fs from 'fs';
import path from 'path';
import archiver from 'archiver';

const outName = 'personal-copilot-local.zip';
const output = fs.createWriteStream(outName);
const archive = archiver('zip', { zlib: { level: 9 } });

output.on('close', () => {
  console.log(`${outName} created, ${archive.pointer()} total bytes`);
});
archive.on('warning', err => {
  if (err.code === 'ENOENT') console.warn(err);
  else throw err;
});
archive.on('error', err => { throw err; });

archive.pipe(output);

// Exclude patterns
const excludePatterns = [
  /^node_modules(\/|\\)/,
  /^\.git(\/|\\)/,
  new RegExp(`^${outName.replace(/\./g, '\\.')}$`)
];

// Recursively add files from cwd, skipping excludes
function addDir(dir) {
  const items = fs.readdirSync(dir, { withFileTypes: true });
  for (const item of items) {
    const full = path.join(dir, item.name);
    const rel = path.relative(process.cwd(), full);
    // skip the zip itself and excluded patterns
    if (excludePatterns.some(p => p.test(rel))) {
      continue;
    }
    if (item.isDirectory()) {
      addDir(full);
    } else if (item.isFile()) {
      archive.file(full, { name: rel });
    }
  }
}

addDir(process.cwd());

archive.finalize();