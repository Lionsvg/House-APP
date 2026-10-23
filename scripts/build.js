const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const CACHE = path.join(DIST, '.cache');
const NODE_MAJOR = 'v22';
const pkg = require(path.join(ROOT, 'package.json'));

const APP_FILES = ['server.js', 'package.json', 'package-lock.json', 'README.md', 'SECURITE.md', 'PROMPT.md', 'LICENSE', 'lib', 'public', 'skills', 'exemples'];
const WINDOWS_FILES = ['Setup.bat', 'start.bat', 'scripts/setup.ps1'];
const LINUX_FILES = ['install.sh'];
const SOURCE_FILES = [...APP_FILES, ...WINDOWS_FILES, ...LINUX_FILES, 'Package.bat', 'scripts/build.js', '.gitignore'];
const SKIP = /(^|[\\/])(bin|obj|\.vs|\.git)([\\/]|$)/;

function walk(rel, out = []) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return out;
  if (fs.statSync(abs).isDirectory()) {
    for (const e of fs.readdirSync(abs)) walk(path.join(rel, e), out);
  } else if (!SKIP.test(rel)) out.push(rel.replace(/\\/g, '/'));
  return out;
}

async function download(url, dest) {
  if (fs.existsSync(dest)) return fs.readFileSync(dest);
  console.log(`  téléchargement ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return buf;
}

async function nodeRelease() {
  const index = await (await fetch('https://nodejs.org/dist/index.json')).json();
  const version = index.find((r) => r.version.startsWith(`${NODE_MAJOR}.`)).version;
  const sums = await (await fetch(`https://nodejs.org/dist/${version}/SHASUMS256.txt`)).text();
  const sha = Object.fromEntries(sums.trim().split('\n').map((l) => l.trim().split(/\s+/).reverse()));
  return { version, sha };
}

async function nodeArchive(rel, file) {
  const buf = await download(`https://nodejs.org/dist/${rel.version}/${file}`, path.join(CACHE, file));
  const got = crypto.createHash('sha256').update(buf).digest('hex');
  if (got !== rel.sha[file]) {
    fs.rmSync(path.join(CACHE, file));
    throw new Error(`Empreinte SHA-256 incorrecte pour ${file}`);
  }
  return buf;
}

function tarEntries(buf) {
  const out = [];
  let i = 0;
  let longName = null;
  while (i + 512 <= buf.length) {
    const h = buf.subarray(i, i + 512);
    if (h.every((b) => b === 0)) break;
    const str = (a, b) => h.subarray(a, b).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(str(124, 136).trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 48);
    const prefix = str(345, 500);
    let name = (prefix ? `${prefix}/` : '') + str(0, 100);
    const data = buf.subarray(i + 512, i + 512 + size);
    if (type === 'L') longName = data.toString('utf8').replace(/\0.*$/s, '');
    else if (type === 'x') {
      const m = /\d+ path=([^\n]+)\n/.exec(data.toString('utf8'));
      if (m) longName = m[1];
    } else {
      if (longName) { name = longName; longName = null; }
      out.push({ name, type, data, mode: parseInt(str(100, 108).trim() || '644', 8) });
    }
    i += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

function tarHeader(name, size, mode, type) {
  const h = Buffer.alloc(512);
  let prefix = '';
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf('/', 154);
    prefix = name.slice(0, cut);
    name = name.slice(cut + 1);
  }
  h.write(name, 0, 100, 'utf8');
  h.write(`${mode.toString(8).padStart(7, '0')}\0`, 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  h.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return h;
}

function makeTarGz(files) {
  const parts = [];
  const dirs = new Set();
  for (const f of files) {
    const segs = f.name.split('/');
    for (let k = 1; k < segs.length; k++) {
      const d = `${segs.slice(0, k).join('/')}/`;
      if (!dirs.has(d)) { dirs.add(d); parts.push(tarHeader(d, 0, 0o755, '5')); }
    }
    parts.push(tarHeader(f.name, f.data.length, f.mode, '0'), f.data, Buffer.alloc((512 - (f.data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(parts), { level: 9 });
}

function appFiles(extra) {
  const list = [...APP_FILES, ...extra].flatMap((f) => walk(f));
  const deps = walk('node_modules');
  return [...list, ...deps].map((rel) => ({ rel, data: fs.readFileSync(path.join(ROOT, rel)) }));
}

async function buildWindows(rel) {
  const file = `node-${rel.version}-win-x64.zip`;
  const nodeZip = new AdmZip(await nodeArchive(rel, file));
  const exe = nodeZip.getEntry(`node-${rel.version}-win-x64/node.exe`).getData();
  const license = nodeZip.getEntry(`node-${rel.version}-win-x64/LICENSE`).getData();
  const zip = new AdmZip();
  for (const f of appFiles(WINDOWS_FILES)) zip.addFile(`HouseApp/${f.rel}`, f.data);
  zip.addFile('HouseApp/node/node.exe', exe);
  zip.addFile('HouseApp/node/LICENSE', license);
  const out = path.join(DIST, 'HouseApp-windows-x64.zip');
  zip.writeZip(out);
  return out;
}

async function buildLinux(rel, arch) {
  const file = `node-${rel.version}-linux-${arch}.tar.gz`;
  const entries = tarEntries(zlib.gunzipSync(await nodeArchive(rel, file)));
  const pick = (p) => entries.find((e) => e.name === `node-${rel.version}-linux-${arch}/${p}`).data;
  const files = appFiles(LINUX_FILES).map((f) => ({ name: `houseapp/${f.rel}`, data: f.data, mode: f.rel === 'install.sh' ? 0o755 : 0o644 }));
  files.push({ name: 'houseapp/node/bin/node', data: pick('bin/node'), mode: 0o755 });
  files.push({ name: 'houseapp/node/LICENSE', data: pick('LICENSE'), mode: 0o644 });
  const out = path.join(DIST, `HouseApp-linux-${arch}.tar.gz`);
  fs.writeFileSync(out, makeTarGz(files));
  return out;
}

function buildSource() {
  const zip = new AdmZip();
  for (const rel of SOURCE_FILES.flatMap((f) => walk(f))) zip.addFile(`HouseApp-${pkg.version}/${rel}`, fs.readFileSync(path.join(ROOT, rel)));
  const out = path.join(DIST, 'HouseApp-source.zip');
  zip.writeZip(out);
  return out;
}

(async () => {
  fs.mkdirSync(CACHE, { recursive: true });
  if (!fs.existsSync(path.join(ROOT, 'node_modules', 'express'))) throw new Error('Lancez d\'abord : npm install');
  const only = process.argv.slice(2);
  const want = (t) => !only.length || only.includes(t);
  const rel = await nodeRelease();
  console.log(`HouseApp ${pkg.version} — Node.js ${rel.version} intégré`);
  const outputs = [];
  if (want('windows')) outputs.push(await buildWindows(rel));
  if (want('linux')) outputs.push(await buildLinux(rel, 'x64'), await buildLinux(rel, 'arm64'));
  if (want('source')) outputs.push(buildSource());
  for (const o of outputs) console.log(`  ${path.basename(o).padEnd(32)} ${(fs.statSync(o).size / 1048576).toFixed(1)} Mo`);
  const sums = fs.readdirSync(DIST).filter((f) => /^HouseApp-.*\.(zip|tar\.gz)$/.test(f)).sort()
    .map((f) => `${crypto.createHash('sha256').update(fs.readFileSync(path.join(DIST, f))).digest('hex')}  ${f}`);
  fs.writeFileSync(path.join(DIST, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`);
  console.log(`Terminé : ${DIST}`);
})().catch((e) => {
  console.error(`ERREUR : ${e.message}`);
  process.exit(1);
});
