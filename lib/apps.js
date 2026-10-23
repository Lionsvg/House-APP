const { spawn } = require('child_process');
const crypto = require('crypto');
const D = require('./docker');
const { byId } = require('./catalog');
const system = require('./system');
const config = require('./config');

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Paris';
const jobs = new Map();

function newJob(title) {
  const job = { id: crypto.randomUUID(), title, status: 'running', log: [], error: null, result: null, started: Date.now() };
  jobs.set(job.id, job);
  setTimeout(() => jobs.delete(job.id), 3600 * 1000).unref();
  return job;
}

function log(job, line) {
  for (const l of String(line).split(/\r?\n/)) {
    if (!l.trim()) continue;
    job.log.push(l);
  }
  if (job.log.length > 300) job.log.splice(0, job.log.length - 300);
}

function getJob(id) {
  return jobs.get(id) || null;
}

function pull(job, image) {
  return new Promise((resolve, reject) => {
    log(job, `Téléchargement de l'image ${image}…`);
    const p = spawn('docker', ['pull', image], { windowsHide: true });
    let lastErr = '';
    p.stdout.on('data', (d) => log(job, d.toString()));
    p.stderr.on('data', (d) => { lastErr = d.toString(); log(job, lastErr); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(lastErr.trim() || `docker pull a échoué (${code})`))));
  });
}

function parsePort(spec) {
  const [hostCont, proto = 'tcp'] = spec.split('/');
  const [host, cont] = hostCont.split(':');
  return { host: Number(host), cont: Number(cont), proto };
}

const volKey = (p) => p.replace(/^\/+/, '').replace(/[^a-zA-Z0-9]+/g, '_') || 'data';

async function resolvePorts(specs, overrides = {}, job) {
  const reserved = await D.reservedPorts();
  const out = [];
  for (let i = 0; i < specs.length; i++) {
    const p = parsePort(specs[i]);
    const wanted = Number(overrides[i]) || p.host;
    const key = `${wanted}/${p.proto}`;
    const free = !reserved.has(key) && (await D.portFree(wanted, p.proto));
    const host = free ? wanted : await D.nextFreePort(wanted + 1, p.proto, reserved);
    if (host !== wanted && job) log(job, `Port ${wanted}/${p.proto} occupé → utilisation du port ${host}`);
    reserved.add(`${host}/${p.proto}`);
    out.push({ ...p, host });
  }
  return out;
}

async function runContainer({ name, image, kind, labels = {}, ports = [], volumes = [], env = {}, cmd = [], gpu = false, sock = false, shm = null, network = null }) {
  const args = ['run', '-d', '--name', name, '--restart', 'unless-stopped',
    '--label', D.LABEL, '--label', `houseapp.kind=${kind}`];
  if (network) args.push('--network', network);
  else args.push('--add-host', 'host.docker.internal:host-gateway');
  for (const [k, v] of Object.entries(labels)) args.push('--label', `${k}=${v}`);
  for (const p of ports) args.push('-p', `${p.host}:${p.cont}${p.proto === 'udp' ? '/udp' : ''}`);
  for (const v of volumes) {
    if (!v.source) {
      const vname = `${name}_${volKey(v.target)}`.replace(/[^a-zA-Z0-9_.-]/g, '_');
      await D.docker(['volume', 'create', '--label', D.LABEL, '--label', `houseapp.owner=${name}`, vname]);
      args.push('-v', `${vname}:${v.target}`);
    } else {
      args.push('-v', `${v.source}:${v.target}`);
    }
  }
  if (sock) args.push('-v', '/var/run/docker.sock:/var/run/docker.sock');
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
  if (gpu) args.push('--gpus', 'all');
  if (shm) args.push('--shm-size', shm);
  args.push(image, ...cmd);
  await D.docker(args, { timeout: 120000 });
}

function install(appId, opts = {}) {
  const app = byId(appId);
  if (!app) throw new Error('Application inconnue');
  const name = `houseapp-${app.id}`;
  const job = newJob(`Installation de ${app.name}`);

  if (app.module) {
    (async () => {
      if (config.moduleEnabled(app.id)) throw new Error(`${app.name} est déjà installé`);
      await pull(job, app.image);
      config.update((c) => { (c.modules ||= {})[app.id] = true; });
      log(job, `${app.name} est installé : son onglet est disponible dans le menu.`);
      job.result = { module: app.id };
      job.status = 'done';
    })().catch((e) => {
      log(job, `ERREUR : ${e.message}`);
      job.error = e.message;
      job.status = 'error';
    });
    return job;
  }

  (async () => {
    if (await D.exists(name)) throw new Error(`${app.name} est déjà installée`);
    const ports = await resolvePorts(app.ports || [], opts.ports || {}, job);
    await pull(job, app.image);

    const env = { TZ, ...(app.lsio ? { PUID: '1000', PGID: '1000' } : {}), ...(app.env || {}), ...(opts.env || {}) };
    const volumes = (app.volumes || []).map((target, i) => ({ target, source: (opts.volumes || {})[i] || null }));
    const gpu = !!app.gpu && (await system.hasNvidia());
    if (app.gpu) log(job, gpu ? 'GPU NVIDIA détecté → accélération activée' : 'Pas de GPU NVIDIA → installation sans GPU');

    const webPort = app.web === false ? null : ports.find((p) => p.proto === 'tcp');
    log(job, 'Création du conteneur…');
    await runContainer({
      name, image: app.image, kind: 'app', ports, volumes, env, cmd: app.cmd || [], gpu, sock: !!app.sock, shm: app.shm,
      labels: {
        'houseapp.app': app.id,
        ...(webPort ? { 'houseapp.web': webPort.host, 'houseapp.scheme': app.scheme || 'http', 'houseapp.path': app.path || '/' } : {}),
      },
    });
    log(job, `${app.name} est installée${webPort ? ` → port ${webPort.host}` : ''}.`);
    job.result = { name, port: webPort ? webPort.host : null };
    job.status = 'done';
  })().catch((e) => {
    log(job, `ERREUR : ${e.message}`);
    job.error = e.message;
    job.status = 'error';
  });

  return job;
}

async function uninstall(name, withData) {
  await D.remove(name);
  if (withData) {
    const out = await D.docker(['volume', 'ls', '-q', '--filter', `label=houseapp.owner=${name}`]);
    const vols = out.split('\n').filter(Boolean);
    if (vols.length) await D.docker(['volume', 'rm', ...vols]);
  }
}

async function installed() {
  const list = await D.list('app');
  const modules = Object.keys(config.load().modules || {}).filter((id) => config.moduleEnabled(id)).map((id) => {
    const app = byId(id) || {};
    return { name: `module:${id}`, app: id, module: id, title: app.name || id, icon: app.icon, image: app.image, state: 'running', status: 'Module HouseApp', web: null };
  });
  return modules.concat(list.map((c) => {
    const app = byId(c.labels['houseapp.app']) || {};
    return {
      name: c.name, app: c.labels['houseapp.app'], local: c.labels['houseapp.local'] || null,
      title: app.name || c.labels['houseapp.title'] || c.name, icon: app.icon || c.labels['houseapp.icon'] || null, image: c.image,
      state: c.state, status: c.status,
      web: c.labels['houseapp.web'] ? { port: Number(c.labels['houseapp.web']), scheme: c.labels['houseapp.scheme'] || 'http', path: c.labels['houseapp.path'] || '/' } : null,
    };
  }));
}

function uninstallModule(id) {
  if (!config.moduleEnabled(id)) throw new Error('Module non installé');
  config.update((c) => { delete c.modules[id]; });
}

module.exports = { install, uninstall, uninstallModule, installed, getJob, newJob, log, pull, runContainer, resolvePorts, TZ };
