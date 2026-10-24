const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');
const D = require('./docker');
const A = require('./apps');
const system = require('./system');

let ROOT;
let TMP;
const IGNORED = new Set(['bin', 'obj', '.vs', '.git', '.idea', 'node_modules', 'TestResults']);
const ICON_EXT = { '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

function init(dataDir) {
  ROOT = path.join(dataDir, 'local-apps');
  TMP = path.join(dataDir, 'tmp');
  fs.mkdirSync(ROOT, { recursive: true });
  fs.mkdirSync(TMP, { recursive: true });
  for (const d of fs.readdirSync(TMP)) {
    const p = path.join(TMP, d);
    if (Date.now() - fs.statSync(p).mtimeMs > 3600 * 1000) fs.rmSync(p, { recursive: true, force: true });
  }
}

const slugify = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
const cname = (id) => `houseapp-local-${id}`;
const imageName = (id) => `houseapp-local/${id}:latest`;

function safeRel(rel) {
  const parts = String(rel).replace(/\\/g, '/').split('/').filter((p) => p && p !== '.');
  if (!parts.length || parts.some((p) => p === '..' || /^[a-zA-Z]:$/.test(p) || p.includes('\0'))) throw new Error(`Chemin refusé : ${rel}`);
  if (parts.some((p) => IGNORED.has(p))) return null;
  return parts.join('/');
}

function uploadDir(token) {
  if (!/^[a-f0-9]{32}$/.test(token)) throw new Error('Jeton d\'envoi invalide');
  const dir = path.join(TMP, token);
  if (!fs.existsSync(dir)) throw new Error('Envoi expiré, recommencez');
  return dir;
}

function startUpload() {
  const token = crypto.randomBytes(16).toString('hex');
  fs.mkdirSync(path.join(TMP, token));
  return token;
}

function writeFile(token, rel, buf) {
  const r = safeRel(rel);
  if (!r) return;
  const dest = path.join(uploadDir(token), ...r.split('/'));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
}

function extractZip(token, buf) {
  const dir = uploadDir(token);
  let zip;
  try { zip = new AdmZip(buf); } catch { throw new Error('Fichier .zip illisible'); }
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue;
    const r = safeRel(e.entryName);
    if (!r) continue;
    const dest = path.join(dir, ...r.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, e.getData());
  }
}

function findRoot(dir, depth = 0) {
  if (fs.existsSync(path.join(dir, 'import.json'))) return dir;
  if (depth >= 2) return null;
  const subs = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory());
  for (const s of subs) {
    const r = findRoot(path.join(dir, s.name), depth + 1);
    if (r) return r;
  }
  return null;
}

function readManifest(root) {
  let m;
  try { m = JSON.parse(fs.readFileSync(path.join(root, 'import.json'), 'utf8').replace(/^﻿/, '')); }
  catch (e) { throw new Error(`import.json invalide : ${e.message}`); }
  if (!m || typeof m !== 'object') throw new Error('import.json doit contenir un objet');
  if (!m.name || typeof m.name !== 'string') throw new Error('import.json : "name" est obligatoire');
  const id = slugify(m.id || m.name);
  if (!id) throw new Error('import.json : impossible de déduire un identifiant depuis "name"');
  const web = m.web !== false;
  const port = Number(m.port ?? 8080);
  if (web && !(port > 0 && port < 65536)) throw new Error('import.json : "port" invalide');
  const env = {};
  for (const [k, v] of Object.entries(m.env || {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`import.json : variable "${k}" invalide`);
    env[k] = String(v);
  }
  const volumes = (m.volumes || []).map(String);
  for (const v of volumes) if (!v.startsWith('/')) throw new Error(`import.json : volume "${v}" doit être un chemin absolu du conteneur`);
  const project = safeRel(m.project || 'Projet');
  if (!project || !fs.existsSync(path.join(root, project))) throw new Error(`Dossier "${m.project || 'Projet'}" introuvable à côté de import.json`);
  return {
    id, name: m.name.slice(0, 40), description: String(m.description || '').slice(0, 300),
    version: String(m.version || ''), icon: m.icon ? String(m.icon) : null,
    web, port: web ? port : null, hostPort: Number(m.hostPort) || null,
    env, volumes, gpu: !!m.gpu, project,
    dotnet: { version: m.dotnet?.version ? String(m.dotnet.version) : null, project: m.dotnet?.project ? String(m.dotnet.project) : null },
  };
}

function findCsproj(dir, depth = 0) {
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name.endsWith('.csproj')) out.push(p);
    else if (e.isDirectory() && depth < 3) out = out.concat(findCsproj(p, depth + 1));
  }
  return out;
}

function prepareDotnet(ctx, manifest, job) {
  let csproj;
  if (manifest.dotnet.project) {
    const r = safeRel(manifest.dotnet.project);
    csproj = path.join(ctx, ...r.split('/'));
    if (!fs.existsSync(csproj)) throw new Error(`Projet ${manifest.dotnet.project} introuvable`);
  } else {
    const all = findCsproj(ctx);
    if (!all.length) throw new Error('Aucun fichier .csproj ni Dockerfile trouvé dans le dossier Projet');
    const webs = all.filter((p) => /Sdk="Microsoft\.NET\.Sdk\.Web"/.test(fs.readFileSync(p, 'utf8')));
    if (all.length > 1 && webs.length !== 1) {
      throw new Error(`Plusieurs .csproj trouvés : précisez "dotnet": { "project": "…" } dans import.json (${all.map((p) => path.relative(ctx, p)).join(', ')})`);
    }
    csproj = webs[0] || all[0];
  }
  const xml = fs.readFileSync(csproj, 'utf8');
  const tfm = (xml.match(/<TargetFrameworks?>\s*net(\d+\.\d+)/) || [])[1];
  const version = manifest.dotnet.version || tfm || '10.0';
  if (!/^\d+\.\d+$/.test(version)) throw new Error(`Version .NET invalide : ${version}`);
  const assembly = (xml.match(/<AssemblyName>\s*([^<\s]+)\s*<\/AssemblyName>/) || [])[1] || path.basename(csproj, '.csproj');
  const rel = path.relative(ctx, csproj).replace(/\\/g, '/');
  A.log(job, `Projet C# détecté : ${rel} (.NET ${version}, ${assembly}.dll)`);

  const port = manifest.port || 8080;
  const dockerfile = `# Généré par HouseApp
FROM mcr.microsoft.com/dotnet/sdk:${version} AS build
WORKDIR /src
COPY . .
RUN dotnet publish "${rel}" -c Release -o /app/publish

FROM mcr.microsoft.com/dotnet/aspnet:${version}
WORKDIR /app
COPY --from=build /app/publish .
ENV ASPNETCORE_URLS=http://+:${port}
EXPOSE ${port}
ENTRYPOINT ["dotnet", "${assembly}.dll"]
`;
  const file = path.join(ctx, '.houseapp.Dockerfile');
  fs.writeFileSync(file, dockerfile);
  return file;
}

function dockerBuild(job, ctx, dockerfile, tag) {
  return new Promise((resolve, reject) => {
    A.log(job, 'Construction de l\'image (la première fois, le téléchargement du SDK .NET peut prendre quelques minutes)…');
    const p = spawn('docker', ['build', '--progress=plain', '-t', tag, '-f', dockerfile, ctx], { windowsHide: true });
    let tail = '';
    const onData = (d) => { const s = d.toString(); tail = (tail + s).slice(-4000); A.log(job, s); };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) return resolve();
      const err = tail.split('\n').reverse().find((l) => /error/i.test(l)) || `docker build a échoué (${code})`;
      reject(new Error(err.trim()));
    });
  });
}

function iconLabel(root, manifest) {
  if (!manifest.icon) return '';
  const ext = path.extname(manifest.icon).toLowerCase();
  if (ICON_EXT[ext]) {
    const r = safeRel(manifest.icon);
    return r && fs.existsSync(path.join(root, r)) ? `local:${manifest.id}` : '';
  }
  return manifest.icon;
}

function buildAndDeploy(id) {
  const root = path.join(ROOT, id);
  const manifest = readManifest(root);
  const job = A.newJob(`Installation de ${manifest.name}`, 'import');
  (async () => {
    const ctx = path.join(root, ...manifest.project.split('/'));
    if (!fs.existsSync(path.join(ctx, '.dockerignore'))) fs.writeFileSync(path.join(ctx, '.dockerignore'), 'bin/\nobj/\n.vs/\n.git/\n');
    const own = path.join(ctx, 'Dockerfile');
    const dockerfile = fs.existsSync(own) ? own : prepareDotnet(ctx, manifest, job);
    if (dockerfile === own) A.log(job, 'Dockerfile fourni par le projet : utilisé tel quel');
    await dockerBuild(job, ctx, dockerfile, imageName(id));

    const name = cname(id);
    if (await D.exists(name)) {
      A.log(job, 'Remplacement de la version précédente (les données sont conservées)…');
      await D.remove(name);
    }
    const ports = manifest.web ? await A.resolvePorts([`${manifest.hostPort || manifest.port}:${manifest.port}`], {}, job) : [];
    const gpu = manifest.gpu && (await system.hasNvidia());
    await A.runContainer({
      name, image: imageName(id), kind: 'app', ports, gpu,
      volumes: manifest.volumes.map((target) => ({ target })),
      env: { TZ: A.TZ, ...manifest.env },
      labels: {
        'houseapp.app': `local-${id}`, 'houseapp.local': id, 'houseapp.title': manifest.name,
        'houseapp.icon': iconLabel(root, manifest),
        ...(ports.length ? { 'houseapp.web': ports[0].host, 'houseapp.scheme': 'http', 'houseapp.path': '/' } : {}),
      },
    });
    A.log(job, `${manifest.name} est installée${ports.length ? ` → port ${ports[0].host}` : ''}.`);
    job.result = { name, port: ports.length ? ports[0].host : null };
    job.status = 'done';
  })().catch((e) => {
    A.log(job, `ERREUR : ${e.message}`);
    job.error = e.message;
    job.status = 'error';
  });
  return job;
}

function finish(token) {
  const dir = uploadDir(token);
  try {
    const root = findRoot(dir);
    if (!root) throw new Error('import.json introuvable : le dossier doit contenir import.json et un dossier Projet');
    const manifest = readManifest(root);
    const dest = path.join(ROOT, manifest.id);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(root, dest);
    return { id: manifest.id, job: buildAndDeploy(manifest.id).id };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function list() {
  return fs.readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => {
    try {
      const m = readManifest(path.join(ROOT, d.name));
      return { id: m.id, name: m.name, description: m.description, version: m.version, icon: iconLabel(path.join(ROOT, d.name), m), container: cname(m.id) };
    } catch (e) {
      return { id: d.name, name: d.name, error: e.message, container: cname(d.name) };
    }
  });
}

function iconFile(id) {
  const root = path.join(ROOT, slugify(id));
  const m = readManifest(root);
  const r = m.icon && safeRel(m.icon);
  const file = r && path.join(root, ...r.split('/'));
  if (!file || !fs.existsSync(file) || !ICON_EXT[path.extname(file).toLowerCase()]) throw new Error('Pas d\'icône');
  return { file, type: ICON_EXT[path.extname(file).toLowerCase()] };
}

async function remove(id, withData) {
  id = slugify(id);
  if (await D.exists(cname(id))) await A.uninstall(cname(id), withData);
  await D.docker(['image', 'rm', imageName(id)]).catch(() => {});
  fs.rmSync(path.join(ROOT, id), { recursive: true, force: true });
}

function rebuild(id) {
  id = slugify(id);
  if (!fs.existsSync(path.join(ROOT, id))) throw new Error('Application importée inconnue');
  return buildAndDeploy(id);
}

module.exports = { init, startUpload, writeFile, extractZip, finish, list, iconFile, remove, rebuild };
