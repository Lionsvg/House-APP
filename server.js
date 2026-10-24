const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const D = require('./lib/docker');
const system = require('./lib/system');
const catalog = require('./lib/catalog');
const apps = require('./lib/apps');
const mc = require('./lib/minecraft');
const ha = require('./lib/homeassistant');
const network = require('./lib/network');
const local = require('./lib/localapps');
const config = require('./lib/config');
const updater = require('./lib/updater');
const upnp = require('./lib/upnp');
const terminal = require('./lib/terminal');
const ollama = require('./lib/ollama');

const DATA = process.env.HOUSEAPP_DATA ? path.resolve(process.env.HOUSEAPP_DATA) : path.join(__dirname, 'data');
fs.mkdirSync(DATA, { recursive: true });
config.init(DATA);
mc.init(DATA);
local.init(DATA);
apps.initJobs(DATA);
updater.init(DATA);

// Acces (Parametres -> Acces) : le reglage de l'interface (config.json) l'emporte sur HOST / PORT
// (config.bat sous Windows, /etc/houseapp.env sous Linux).
const MODES = { local: '127.0.0.1', tailscale: '127.0.0.1,tailscale', lan: '0.0.0.0', internet: '0.0.0.0' };
const ENV_PORT = Number(process.env.PORT) || 8800;
const ENV_HOST = process.env.HOST || '0.0.0.0';
function accessSettings() {
  const a = config.load().access || {};
  const mode = MODES[a.mode] ? a.mode : null;
  return {
    mode, port: Number(a.port) || ENV_PORT, domain: a.domain || '', https: !!a.https,
    hostSetting: mode ? MODES[mode] : ENV_HOST,
    envMode: Object.keys(MODES).find((m) => m !== 'internet' && MODES[m] === ENV_HOST) || 'custom',
  };
}
let PORT = accessSettings().port;

const SESSION_MS = 7 * 24 * 3600 * 1000;
const sign = (exp, secret) => crypto.createHmac('sha256', secret).update(String(exp)).digest('hex');

function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex'), secret: crypto.randomBytes(32).toString('hex') };
}
function checkPassword(pw, cfg) {
  if (!cfg.auth) return false;
  const h = crypto.scryptSync(pw, cfg.auth.salt, 64);
  return crypto.timingSafeEqual(h, Buffer.from(cfg.auth.hash, 'hex'));
}
function isLogged(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)hs=(\d+)\.([a-f0-9]{64})/);
  const secret = config.load().auth?.secret;
  if (!m || !secret || Number(m[1]) < Date.now()) return false;
  return crypto.timingSafeEqual(Buffer.from(m[2], 'hex'), Buffer.from(sign(m[1], secret), 'hex'));
}
function openSession(res) {
  const exp = Date.now() + SESSION_MS;
  const t = `${exp}.${sign(exp, config.load().auth.secret)}`;
  res.setHeader('Set-Cookie', `hs=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`);
}

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/xterm', express.static(path.join(__dirname, 'node_modules', '@xterm', 'xterm')));
app.use('/vendor/xterm-fit', express.static(path.join(__dirname, 'node_modules', '@xterm', 'addon-fit')));

const h = (fn) => (req, res) => Promise.resolve().then(() => fn(req, res)).then((r) => { if (!res.headersSent) res.json(r ?? { ok: true }); })
  .catch((e) => { if (!res.headersSent) res.status(e.status || 400).json({ error: e.message }); });

app.get('/api/auth/status', (req, res) => {
  res.json({ setup: !!config.load().auth, logged: isLogged(req) });
});

app.post('/api/auth/setup', h(async (req, res) => {
  const cfg = config.load();
  if (cfg.auth) throw new Error('Mot de passe déjà défini');
  const pw = String(req.body.password || '');
  if (pw.length < 6) throw new Error('6 caractères minimum');
  cfg.auth = hashPassword(pw);
  config.save(cfg);
  openSession(res);
}));

app.post('/api/auth/login', h(async (req, res) => {
  if (!checkPassword(String(req.body.password || ''), config.load())) {
    await new Promise((r) => setTimeout(r, 800));
    throw new Error('Mot de passe incorrect');
  }
  openSession(res);
}));

app.post('/api/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'hs=; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.use('/api', (req, res, next) => (isLogged(req) ? next() : res.status(401).json({ error: 'Non connecté' })));

app.post('/api/auth/password', h(async (req, res) => {
  const cfg = config.load();
  if (!checkPassword(String(req.body.current || ''), cfg)) throw new Error('Mot de passe actuel incorrect');
  const pw = String(req.body.password || '');
  if (pw.length < 6) throw new Error('6 caractères minimum');
  cfg.auth = hashPassword(pw);
  config.save(cfg);
  openSession(res);
}));

app.get('/api/system/info', h(async () => ({
  ...(await system.getStatic()),
  docker: await D.available(),
  modules: config.load().modules || {},
  access: { port: PORT, hosts: HOSTS, ...network.addresses(), magicDns: await network.magicDns(), domain: accessSettings().domain, https: accessSettings().https },
  version: updater.CURRENT,
})));
app.get('/api/system/live', h(() => system.getLive()));

app.get('/api/catalog', (req, res) => res.json({ categories: catalog.CATEGORIES, apps: catalog.APPS }));
app.get('/api/apps', h(() => apps.installed()));
app.get('/api/apps/stats', h(() => D.stats()));
app.post('/api/apps/:id/install', h((req) => ({ job: apps.install(req.params.id, req.body || {}).id })));
app.delete('/api/modules/:id', h(async (req) => {
  if (req.params.id === 'minecraft') {
    if (req.query.purge === '1') await mc.removeAll();
    else await mc.stopAll();
  }
  apps.uninstallModule(req.params.id);
}));
app.post('/api/containers/:name/:verb(start|stop|restart)', h((req) => D.action(req.params.name, req.params.verb)));
app.get('/api/containers/:name/logs', h(async (req) => ({ logs: await D.logs(req.params.name, 300) })));
app.post('/api/containers/:name/ollama/pull', h(async (req) => ({ job: (await ollama.pull(req.params.name, req.body.model)).id })));
app.delete('/api/containers/:name', h((req) => apps.uninstall(req.params.name, req.query.data === '1')));
app.get('/api/jobs', h(() => apps.listJobs()));
app.delete('/api/jobs', h(() => apps.clearJobs()));
app.get('/api/jobs/:id', h((req) => {
  const j = apps.getJob(req.params.id);
  if (!j) throw new Error('Tâche inconnue');
  return j;
}));

const raw = express.raw({ type: () => true, limit: '500mb' });
const binary = (req) => {
  if (!Buffer.isBuffer(req.body)) throw new Error('Envoyez le fichier en application/octet-stream');
  return req.body;
};
app.get('/api/local-apps', h(() => local.list()));
app.post('/api/import/start', h(() => ({ token: local.startUpload() })));
app.put('/api/import/:token/file', raw, h((req) => local.writeFile(req.params.token, String(req.query.path || ''), binary(req))));
app.post('/api/import/:token/zip', raw, h((req) => local.extractZip(req.params.token, binary(req))));
app.post('/api/import/:token/finish', h((req) => local.finish(req.params.token)));
app.post('/api/local-apps/:id/rebuild', h((req) => ({ job: local.rebuild(req.params.id).id })));
app.delete('/api/local-apps/:id', h((req) => local.remove(req.params.id, req.query.data === '1')));
app.get('/api/local-apps/:id/icon', (req, res) => {
  try {
    const { file, type } = local.iconFile(req.params.id);
    res.type(type).sendFile(file);
  } catch { res.status(404).end(); }
});

const mcr = express.Router();
mcr.use((req, res, next) => (config.moduleEnabled('minecraft') ? next()
  : res.status(404).json({ error: 'Le panel Minecraft n\'est pas installé (Applications → Panel Minecraft)' })));
const jobOf = (job) => ({ job: job ? job.id : null });

mcr.get('/', h(async () => ({ types: mc.TYPES, servers: await mc.list() })));
mcr.post('/', h((req) => mc.create(req.body || {})));
mcr.put('/:slug', h((req) => jobOf(mc.update(req.params.slug, req.body || {}))));
mcr.delete('/:slug', h((req) => mc.remove(req.params.slug, req.query.world === '1')));
mcr.post('/:slug/eula', h((req) => jobOf(mc.acceptEula(req.params.slug))));
mcr.post('/:slug/power/:verb(start|stop|restart)', h((req) => mc.power(req.params.slug, req.params.verb)));
mcr.post('/:slug/command', h(async (req) => ({ output: await mc.command(req.params.slug, req.body.command) })));
mcr.get('/:slug/players', h((req) => mc.playersInfo(req.params.slug)));
mcr.post('/:slug/players', h(async (req) => ({ output: await mc.playerAction(req.params.slug, String(req.body.action || ''), String(req.body.name || '')) })));

mcr.get('/:slug/files', h((req) => mc.listDir(req.params.slug, req.query.path)));
mcr.get('/:slug/file', async (req, res) => {
  try {
    const buf = await mc.readFile(req.params.slug, req.query.path);
    if (req.query.download === '1') {
      const name = path.posix.basename(String(req.query.path || 'fichier')).replace(/[^\w.-]/g, '_');
      res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
      res.type('application/octet-stream');
    } else res.type('text/plain; charset=utf-8');
    res.send(buf);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
mcr.put('/:slug/file', raw, h((req) => mc.writeFile(req.params.slug, req.query.path, binary(req))));
mcr.delete('/:slug/file', h((req) => mc.removePath(req.params.slug, req.query.path)));
mcr.post('/:slug/mkdir', h((req) => mc.mkdir(req.params.slug, req.body.path)));
mcr.post('/:slug/rename', h((req) => mc.rename(req.params.slug, req.body.from, req.body.to)));
mcr.get('/:slug/backup', async (req, res) => {
  try {
    const p = await mc.backupStream(req.params.slug);
    const date = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.slug}-${date}.tar.gz"`);
    res.type('application/gzip');
    p.stdout.pipe(res);
    req.on('close', () => p.kill());
  } catch (e) { res.status(400).json({ error: e.message }); }
});

mcr.get('/:slug/modrinth/search', h((req) => mc.searchProjects(req.params.slug, req.query.q)));
mcr.put('/:slug/modrinth', h((req) => jobOf(mc.setProjects(req.params.slug, req.body.projects))));

mcr.get('/:slug/public', h((req) => mc.publicInfo(req.params.slug)));
mcr.post('/:slug/public/upnp', h((req) => mc.upnpOpen(req.params.slug)));
mcr.delete('/:slug/public/upnp', h((req) => mc.upnpClose(req.params.slug)));
mcr.put('/:slug/public/playit', h((req) => mc.setPlayit(req.params.slug, req.body || {})));
mcr.post('/:slug/public/test', h((req) => mc.testPublic(req.body.address)));

mcr.get('/:slug/console', async (req, res) => {
  const name = mc.cname(req.params.slug);
  try { await D.assertOwned(name); } catch (e) { return res.status(404).json({ error: e.message }); }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  const p = D.followLogs(name, 300, send);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  p.on('close', () => send('\n[console fermée — le serveur est peut-être arrêté]\n'));
  req.on('close', () => { clearInterval(ping); p.kill(); });
});
app.use('/api/minecraft', mcr);

app.get('/api/ha/config', (req, res) => {
  const c = config.load().ha || {};
  res.json({ url: c.url || '', hasToken: !!c.token });
});
app.post('/api/ha/config', h(async (req) => {
  const cfg = config.load();
  const url = String(req.body.url || '').trim();
  if (!/^https?:\/\/[^\s]+$/.test(url)) throw new Error('URL invalide (ex : http://localhost:8123)');
  const next = { url, token: req.body.token ? String(req.body.token).trim() : cfg.ha?.token };
  const message = await ha.test(next);
  cfg.ha = next;
  config.save(cfg);
  return { message };
}));
app.get('/api/ha/states', h(() => ha.states(config.load().ha)));
app.post('/api/ha/toggle', h((req) => ha.toggle(config.load().ha, String(req.body.entity_id || ''))));

// ---------------------------------------------------------------- mise a jour
app.get('/api/update', h(() => updater.status()));
app.get('/api/update/check', h(() => updater.check()));
app.post('/api/update', h(() => ({ job: updater.start().id })));

// ---------------------------------------------------------------- acces / exposition
const localAddr = (req) => String(req.socket.localAddress || '').replace(/^::ffff:/, '');
let upnpState = null;

app.get('/api/access', h(async (req) => {
  const a = accessSettings();
  return {
    mode: a.mode || a.envMode, fromEnv: !a.mode, port: PORT, domain: a.domain, https: a.https, hosts: HOSTS,
    ...network.addresses(), magicDns: await network.magicDns(), via: localAddr(req), upnp: upnpState,
  };
}));
app.get('/api/access/public', h(async () => {
  const out = { publicIp: null, router: null, nat: null, error: null };
  try { Object.assign(out, await upnp.status()); out.publicIp = out.externalIp; } catch (e) { out.error = e.message; }
  if (!out.publicIp || upnp.isPrivate(out.publicIp)) out.publicIp = await upnp.publicIpFromInternet().catch(() => out.publicIp);
  return out;
}));
app.put('/api/access', h(async (req) => {
  const b = req.body || {};
  const mode = String(b.mode || '');
  if (!MODES[mode]) throw new Error('Mode inconnu');
  const port = Number(b.port || PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port invalide (1024 à 65535)');
  const domain = String(b.domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (domain && !/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) throw new Error('Nom de domaine invalide (ex : maison.exemple.fr)');
  // Anti-verrouillage : le nouveau reglage doit encore servir l'adresse par laquelle on est connecte.
  const next = network.resolveHosts(MODES[mode]);
  const via = localAddr(req);
  const stillReachable = port === PORT && (next.includes('0.0.0.0') || next.includes(via));
  if (!stillReachable && !b.confirm) {
    const e = new Error(port !== PORT
      ? `HouseApp passera sur le port ${port} : il faudra rouvrir la page à la nouvelle adresse.`
      : `Vous êtes connecté via ${via} : avec ce mode, cette adresse ne répondra plus. Vous ne pourrez revenir qu'avec une adresse encore autorisée.`);
    e.status = 409;
    throw e;
  }
  const before = accessSettings();
  config.update((c) => { c.access = { mode, port, domain, https: !!b.https }; });
  setTimeout(() => applyAccess(before).catch((err) => console.error(`Changement d'accès : ${err.message}`)), 400);
  return { ok: true, port, reachable: stillReachable };
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'Route inconnue' }));

const HOSTS = [];
const servers = new Map();
const wantsTailscale = () => accessSettings().hostSetting.split(',').map((s) => s.trim()).includes('tailscale');

// Terminal des conteneurs (WebSocket) : session obligatoire, et seulement depuis la page HouseApp elle-meme
// (une autre page web ne doit pas pouvoir ouvrir un terminal avec votre session).
function onUpgrade(req, socket, head) {
  const url = new URL(req.url, 'http://x');
  const m = url.pathname.match(/^\/api\/containers\/([\w.-]+)\/terminal$/);
  let sameOrigin = false;
  try { sameOrigin = new URL(req.headers.origin).host === req.headers.host; } catch { /* pas d'Origin */ }
  if (!m) return socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
  if (!isLogged(req) || !sameOrigin) return socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  terminal.handle(req, socket, head, m[1], url.searchParams).catch(() => socket.destroy());
}

function bind(host, fatal) {
  return new Promise((resolve) => {
    const srv = app.listen(PORT, host, () => { HOSTS.push(host); servers.set(host, srv); resolve(true); }).on('error', (e) => {
      console.error(`Impossible d'écouter sur ${host}:${PORT} — ${e.message}`);
      if (fatal) process.exit(1);
      resolve(false);
    });
    srv.on('upgrade', onUpgrade);
  });
}

/** Ouvre le port sur la box (UPnP) en mode Internet, le referme sinon. */
async function syncUpnp(previous) {
  const a = accessSettings();
  if (previous && previous.mode === 'internet' && (a.mode !== 'internet' || previous.port !== a.port)) {
    await upnp.close(previous.port).catch(() => {});
    upnpState = null;
  }
  if (a.mode !== 'internet') return;
  try {
    const r = await upnp.open(a.port, 'HouseApp');
    upnpState = { ok: true, port: a.port, router: r.router, at: Date.now() };
    console.log(`  Internet  : port ${a.port} ouvert sur la box (${r.router})`);
  } catch (e) {
    upnpState = { ok: false, port: a.port, error: e.message, at: Date.now() };
    console.log(`  Internet  : ouverture automatique du port impossible (${e.message}) — ouvrez le port ${a.port} sur la box`);
  }
}

/** Applique un nouveau reglage d'acces sans redemarrer : on ferme les ecoutes puis on les rouvre. */
async function applyAccess(previous) {
  await Promise.all([...servers.values()].map((srv) => new Promise((r) => { srv.close(() => r()); srv.closeAllConnections?.(); })));
  servers.clear();
  HOSTS.length = 0;
  PORT = accessSettings().port;
  for (const host of network.resolveHosts(accessSettings().hostSetting)) await bind(host, false);
  console.log(`Accès modifié : écoute sur ${HOSTS.join(', ') || 'aucune adresse'}, port ${PORT}`);
  await syncUpnp(previous);
}

(async () => {
  for (const host of network.resolveHosts(accessSettings().hostSetting)) await bind(host, true);
  console.log(`HouseApp démarré (écoute sur ${HOSTS.join(', ') || 'aucune adresse pour l\'instant'}, port ${PORT})`);
  const { lan, tailscale } = network.addresses();
  const all = HOSTS.includes('0.0.0.0');
  if (all || HOSTS.some((x) => x.startsWith('127.'))) console.log(`  Local     : http://localhost:${PORT}`);
  if (all) lan.forEach((ip) => console.log(`  Réseau    : http://${ip}:${PORT}`));
  const ts = tailscale.filter((ip) => all || HOSTS.includes(ip));
  ts.forEach((ip) => console.log(`  Tailscale : http://${ip}:${PORT}`));
  if (ts.length) {
    const dns = await network.magicDns();
    if (dns) console.log(`  Tailscale : http://${dns}:${PORT}`);
  }
  if (wantsTailscale() && !ts.length) console.log('  Tailscale : pas encore connecté — HouseApp l\'ajoutera dès qu\'il le sera');
  if (accessSettings().domain) console.log(`  Domaine   : ${accessSettings().https ? 'https' : 'http'}://${accessSettings().domain}${accessSettings().https ? '' : `:${PORT}`}`);
  syncUpnp(null);
  setInterval(() => { if (accessSettings().mode === 'internet') syncUpnp(null); }, 24 * 3600 * 1000).unref();
  D.available().then((d) => console.log(d.ok ? `Docker ${d.version} détecté` : `ATTENTION : Docker indisponible — ${d.error}`));
  if (config.moduleEnabled('minecraft')) mc.renewUpnp();

  {
    setInterval(async () => {
      if (!wantsTailscale()) return;
      for (const ip of network.addresses().tailscale) {
        if (!HOSTS.includes(ip) && (await bind(ip, false))) console.log(`Tailscale connecté : http://${ip}:${PORT}`);
      }
    }, 15000);
  }
})();
