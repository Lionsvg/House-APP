const fs = require('fs');
const path = require('path');
const D = require('./docker');
const A = require('./apps');
const upnp = require('./upnp');

const IMAGE = 'itzg/minecraft-server:latest';
const PLAYIT_IMAGE = 'ghcr.io/playit-cloud/playit-agent:latest';
const TYPES = ['PAPER', 'PURPUR', 'SPIGOT', 'VANILLA', 'FABRIC', 'FORGE', 'NEOFORGE'];
const PLUGIN_TYPES = ['PAPER', 'PURPUR', 'SPIGOT'];
const MOD_TYPES = ['FABRIC', 'FORGE', 'NEOFORGE'];
const LOADERS = {
  PAPER: ['paper', 'spigot', 'bukkit'], PURPUR: ['purpur', 'paper', 'spigot', 'bukkit'], SPIGOT: ['spigot', 'bukkit'],
  FABRIC: ['fabric'], FORGE: ['forge'], NEOFORGE: ['neoforge'],
};
const LEVEL_TYPES = ['minecraft:normal', 'minecraft:flat', 'minecraft:large_biomes', 'minecraft:amplified'];
const NAME_RE = /^[A-Za-z0-9_]{1,16}$/;
const UA = { 'User-Agent': 'HouseApp/1.0 (github.com/Lionsvg/House-APP)' };

let STORE;
function init(dataDir) {
  STORE = path.join(dataDir, 'minecraft.json');
}
const load = () => { try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch { return {}; } };
const save = (s) => fs.writeFileSync(STORE, JSON.stringify(s, null, 2));
function get(slug) {
  const cfg = load()[slug];
  if (!cfg) throw new Error('Serveur inconnu');
  return cfg;
}
function put(slug, cfg) {
  const s = load();
  s[slug] = cfg;
  save(s);
}

const slugify = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
const cname = (slug) => `houseapp-mc-${slug}`;
const playitName = (slug) => `houseapp-mc-${slug}-playit`;
const volume = (slug) => `${cname(slug)}_data`;

const words = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\s,;]+/)).map((s) => String(s).trim()).filter(Boolean);
const players = (v) => [...new Set(words(v).filter((n) => NAME_RE.test(n)))].slice(0, 500);
const projects = (v) => [...new Set(words(v).filter((s) => /^[A-Za-z0-9_.-]{1,64}(:[A-Za-z0-9_.+-]{1,64})?$/.test(s)))].slice(0, 200);
const bool = (v, def) => (v === undefined || v === null || v === '' ? def : v === true || v === 'true' || v === 'on' || v === 1 || v === '1');
const int = (v, def, min, max) => Math.min(max, Math.max(min, Number.isFinite(Number(v)) && v !== '' ? Math.round(Number(v)) : def));

function sanitize(raw, prev = {}) {
  const m = { ...prev, ...raw };
  const type = TYPES.includes(String(m.type).toUpperCase()) ? String(m.type).toUpperCase() : 'PAPER';
  return {
    name: String(m.name || 'Serveur').slice(0, 40),
    type,
    version: /^[A-Za-z0-9._-]{1,20}$/.test(m.version || '') ? m.version : 'LATEST',
    memory: /^\d{1,2}G$/i.test(m.memory || '') ? m.memory.toUpperCase() : '4G',
    port: int(m.port, 25565, 1024, 65535),
    maxPlayers: int(m.maxPlayers, 20, 1, 500),
    gamemode: ['survival', 'creative', 'adventure', 'spectator'].includes(m.gamemode) ? m.gamemode : 'survival',
    difficulty: ['peaceful', 'easy', 'normal', 'hard'].includes(m.difficulty) ? m.difficulty : 'normal',
    motd: String(m.motd || 'Un serveur HouseApp').slice(0, 120),
    onlineMode: bool(m.onlineMode, true),
    pvp: bool(m.pvp, true),
    hardcore: bool(m.hardcore, false),
    allowNether: bool(m.allowNether, true),
    commandBlocks: bool(m.commandBlocks, false),
    viewDistance: int(m.viewDistance, 10, 3, 32),
    levelType: LEVEL_TYPES.includes(m.levelType) ? m.levelType : 'minecraft:normal',
    seed: String(m.seed || '').slice(0, 40),
    whitelist: bool(m.whitelist, false),
    whitelistPlayers: players(m.whitelistPlayers),
    ops: players(m.ops),
    modrinth: projects(m.modrinth),
    eula: !!prev.eula,
    upnp: !!prev.upnp,
    playit: prev.playit || null,
    publicAddress: prev.publicAddress || '',
  };
}

function envOf(cfg) {
  const env = {
    EULA: 'TRUE', TYPE: cfg.type, VERSION: cfg.version, MEMORY: cfg.memory, TZ: A.TZ,
    MAX_PLAYERS: String(cfg.maxPlayers), MODE: cfg.gamemode, DIFFICULTY: cfg.difficulty, MOTD: cfg.motd,
    ONLINE_MODE: String(cfg.onlineMode), PVP: String(cfg.pvp), HARDCORE: String(cfg.hardcore),
    ALLOW_NETHER: String(cfg.allowNether), ENABLE_COMMAND_BLOCK: String(cfg.commandBlocks),
    VIEW_DISTANCE: String(cfg.viewDistance), LEVEL_TYPE: cfg.levelType, ENABLE_RCON: 'true',
  };
  if (cfg.seed) env.SEED = cfg.seed;
  if (cfg.whitelist) {
    env.ENABLE_WHITELIST = 'TRUE';
    env.ENFORCE_WHITELIST = 'TRUE';
    if (cfg.whitelistPlayers.length) env.WHITELIST = cfg.whitelistPlayers.join(',');
  }
  if (cfg.ops.length) env.OPS = cfg.ops.join(',');
  if (cfg.modrinth.length && cfg.type !== 'VANILLA') {
    env.MODRINTH_PROJECTS = cfg.modrinth.join(',');
    env.MODRINTH_DOWNLOAD_DEPENDENCIES = 'required';
  }
  return env;
}

async function startPlayit(slug, cfg, job) {
  await D.docker(['rm', '-f', playitName(slug)]).catch(() => {});
  if (!cfg.playit?.key) return;
  if (job) A.log(job, 'Démarrage du tunnel playit.gg…');
  if (!(await D.docker(['image', 'inspect', PLAYIT_IMAGE]).then(() => true, () => false))) {
    if (job) await A.pull(job, PLAYIT_IMAGE);
    else await D.docker(['pull', PLAYIT_IMAGE], { timeout: 600000 });
  }
  await A.runContainer({
    name: playitName(slug), image: PLAYIT_IMAGE, kind: 'minecraft-tunnel', network: `container:${cname(slug)}`,
    env: { SECRET_KEY: cfg.playit.key }, labels: { 'houseapp.mc': slug },
  });
}

function deploy(slug, cfg, title) {
  const job = A.newJob(`${title} — ${cfg.name}`, 'minecraft');
  (async () => {
    const name = cname(slug);
    await D.docker(['rm', '-f', playitName(slug)]).catch(() => {});
    if (await D.exists(name)) {
      A.log(job, 'Arrêt du serveur…');
      await D.remove(name);
    }
    const oldPort = load()[slug]?.port;
    const [port] = await A.resolvePorts([`${cfg.port}:25565`], {}, job);
    cfg.port = port.host;
    await A.pull(job, IMAGE);
    A.log(job, 'Création du serveur…');
    await A.runContainer({
      name, image: IMAGE, kind: 'minecraft', ports: [port], volumes: [{ target: '/data' }], env: envOf(cfg),
      labels: { 'houseapp.mc': slug },
    });
    await startPlayit(slug, cfg, job);
    if (cfg.upnp && oldPort !== cfg.port) {
      if (oldPort) await upnp.close(oldPort).catch(() => {});
      await upnp.open(cfg.port, `HouseApp Minecraft ${cfg.name}`).then(
        () => A.log(job, `Port ${cfg.port} ouvert sur le routeur (UPnP).`),
        (e) => A.log(job, `UPnP : ${e.message}`),
      );
    }
    put(slug, cfg);
    A.log(job, `Serveur lancé sur le port ${cfg.port}. Le premier démarrage télécharge Minecraft (1 à 3 minutes).`);
    job.result = { slug, port: cfg.port };
    job.status = 'done';
  })().catch((e) => {
    A.log(job, `ERREUR : ${e.message}`);
    job.error = e.message;
    job.status = 'error';
  });
  return job;
}

function create(raw) {
  const cfg = sanitize(raw);
  const store = load();
  const base = slugify(cfg.name) || 'serveur';
  let slug = base;
  for (let n = 2; store[slug]; n++) slug = `${base}-${n}`;
  put(slug, cfg);
  return { slug };
}

function acceptEula(slug) {
  const cfg = get(slug);
  cfg.eula = true;
  put(slug, cfg);
  return deploy(slug, cfg, 'Premier démarrage');
}

function update(slug, raw) {
  const cfg = sanitize(raw, get(slug));
  if (!cfg.eula) {
    put(slug, cfg);
    return null;
  }
  return deploy(slug, cfg, 'Application des réglages');
}

function setProjects(slug, list) {
  const cfg = get(slug);
  cfg.modrinth = projects(list);
  if (!cfg.eula) {
    put(slug, cfg);
    return null;
  }
  return deploy(slug, cfg, 'Mise à jour des plugins/mods');
}

async function list() {
  const store = load();
  const containers = await D.list('minecraft');
  const byName = Object.fromEntries(containers.map((c) => [c.name, c]));
  return Object.entries(store).map(([slug, cfg]) => {
    const c = byName[cname(slug)];
    let health = null;
    if (c && /\(healthy\)/.test(c.status)) health = 'healthy';
    else if (c && /unhealthy/.test(c.status)) health = 'unhealthy';
    else if (c && /health: starting/.test(c.status)) health = 'starting';
    const { playit, ...pub } = cfg;
    return {
      slug, container: cname(slug), ...pub, playit: !!playit?.key,
      state: !cfg.eula ? 'eula' : c ? c.state : 'missing', status: c ? c.status : '', health,
      kind: PLUGIN_TYPES.includes(cfg.type) ? 'plugins' : MOD_TYPES.includes(cfg.type) ? 'mods' : null,
    };
  });
}

async function power(slug, verb) {
  get(slug);
  if (!['start', 'stop', 'restart'].includes(verb)) throw new Error('Action invalide');
  await D.action(cname(slug), verb);
  if (await D.exists(playitName(slug))) {
    await D.docker([verb === 'stop' ? 'stop' : 'restart', playitName(slug)]).catch(() => {});
  }
}

async function remove(slug, withWorld) {
  const cfg = get(slug);
  await D.docker(['rm', '-f', playitName(slug)]).catch(() => {});
  if (cfg.upnp) await upnp.close(cfg.port).catch(() => {});
  if (await D.exists(cname(slug))) await A.uninstall(cname(slug), withWorld);
  else if (withWorld && (await D.volumeExists(volume(slug)))) await D.docker(['volume', 'rm', volume(slug)]);
  const s = load();
  delete s[slug];
  save(s);
}

async function stopAll() {
  for (const slug of Object.keys(load())) {
    for (const n of [playitName(slug), cname(slug)]) await D.docker(['stop', n]).catch(() => {});
  }
}

async function removeAll() {
  for (const slug of Object.keys(load())) await remove(slug, true).catch(() => {});
}

async function command(slug, cmd) {
  get(slug);
  const c = String(cmd || '').replace(/^\//, '').trim();
  if (!c) throw new Error('Commande vide');
  if (c.length > 1000) throw new Error('Commande trop longue');
  return (await D.exec(cname(slug), ['rcon-cli', c])).trim();
}

async function readJson(slug, file) {
  try { return JSON.parse((await readFile(slug, file)).toString('utf8')); } catch { return []; }
}

async function playersInfo(slug) {
  get(slug);
  const running = (await D.state(cname(slug))) === 'running';
  let online = { online: 0, max: null, names: [] };
  if (running) {
    const out = await command(slug, 'list').catch(() => '');
    const m = out.match(/There are (\d+) of a max(?: of)? (\d+) players online:?\s*(.*)/i);
    if (m) online = { online: Number(m[1]), max: Number(m[2]), names: m[3] ? m[3].split(',').map((s) => s.trim()).filter(Boolean) : [] };
  }
  const [wl, ops, bans] = await Promise.all(['whitelist.json', 'ops.json', 'banned-players.json'].map((f) => readJson(slug, f)));
  return {
    running, ...online,
    whitelist: wl.map((p) => p.name).filter(Boolean),
    ops: ops.map((p) => p.name).filter(Boolean),
    banned: bans.map((p) => p.name).filter(Boolean),
  };
}

const PLAYER_ACTIONS = {
  'whitelist-add': (n) => `whitelist add ${n}`, 'whitelist-remove': (n) => `whitelist remove ${n}`,
  op: (n) => `op ${n}`, deop: (n) => `deop ${n}`, kick: (n) => `kick ${n}`, ban: (n) => `ban ${n}`, pardon: (n) => `pardon ${n}`,
  'whitelist-on': () => 'whitelist on', 'whitelist-off': () => 'whitelist off',
};

async function playerAction(slug, action, name) {
  const cmd = PLAYER_ACTIONS[action];
  if (!cmd) throw new Error('Action inconnue');
  if (!action.startsWith('whitelist-o') && !NAME_RE.test(String(name || ''))) throw new Error('Pseudo Minecraft invalide');
  if ((await D.state(cname(slug))) !== 'running') throw new Error('Démarrez le serveur pour gérer les joueurs');
  const out = await command(slug, cmd(name));
  if (action === 'whitelist-on' || action === 'whitelist-off') {
    const cfg = get(slug);
    cfg.whitelist = action === 'whitelist-on';
    put(slug, cfg);
  }
  return out;
}

function dataPath(p) {
  const abs = path.posix.normalize(`/data/${String(p || '').replace(/\\/g, '/')}`);
  if (abs !== '/data' && !abs.startsWith('/data/')) throw new Error('Chemin refusé');
  if (abs.includes('\0')) throw new Error('Chemin refusé');
  return abs.replace(/\/+$/, '') || '/data';
}

async function run(slug, args, input = null) {
  get(slug);
  const name = cname(slug);
  if ((await D.state(name)) === 'running') {
    return D.dockerRaw(['exec', '-i', '-u', '1000:1000', name, ...args], { input });
  }
  if (!(await D.volumeExists(volume(slug)))) throw new Error('Démarrez le serveur une première fois pour créer ses fichiers');
  return D.dockerRaw(['run', '--rm', '-i', '--user', '1000:1000', '--entrypoint', '', '-v', `${volume(slug)}:/data`, IMAGE, ...args], { input });
}

async function listDir(slug, p) {
  const abs = dataPath(p);
  const out = (await run(slug, ['find', abs, '-mindepth', '1', '-maxdepth', '1', '-printf', '%y\t%s\t%T@\t%f\n'])).toString('utf8');
  return out.split('\n').filter(Boolean).map((l) => {
    const [t, size, mtime, ...rest] = l.split('\t');
    return { name: rest.join('\t'), dir: t === 'd', size: Number(size), mtime: Math.round(Number(mtime) * 1000) };
  }).sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
}

const readFile = (slug, p) => run(slug, ['cat', '--', dataPath(p)]);

async function writeFile(slug, p, buf) {
  const abs = dataPath(p);
  if (abs === '/data') throw new Error('Chemin refusé');
  await run(slug, ['sh', '-c', 'mkdir -p "$(dirname "$1")" && cat > "$1"', 'sh', abs], buf);
}

async function removePath(slug, p) {
  const abs = dataPath(p);
  if (abs === '/data') throw new Error('Impossible de supprimer la racine');
  await run(slug, ['rm', '-rf', '--', abs]);
}

const mkdir = (slug, p) => run(slug, ['mkdir', '-p', '--', dataPath(p)]);

async function rename(slug, from, to) {
  const a = dataPath(from);
  const b = dataPath(to);
  if (a === '/data' || b === '/data') throw new Error('Chemin refusé');
  await run(slug, ['mv', '-n', '--', a, b]);
}

async function backupStream(slug) {
  get(slug);
  const name = cname(slug);
  const script = 'cd /data && tar czf - $(ls -d world* 2>/dev/null) server.properties whitelist.json ops.json 2>/dev/null';
  if ((await D.state(name)) === 'running') {
    await command(slug, 'save-all flush').catch(() => {});
    return D.dockerStream(['exec', '-u', '1000:1000', name, 'sh', '-c', script]);
  }
  if (!(await D.volumeExists(volume(slug)))) throw new Error('Aucun monde à sauvegarder pour l\'instant');
  return D.dockerStream(['run', '--rm', '--user', '1000:1000', '--entrypoint', '', '-v', `${volume(slug)}:/data`, IMAGE, 'sh', '-c', script]);
}

async function searchProjects(slug, query) {
  const cfg = get(slug);
  const loaders = LOADERS[cfg.type];
  if (!loaders) throw new Error('Un serveur Vanilla n\'accepte ni plugins ni mods : choisissez Paper (plugins) ou Fabric (mods)');
  const facets = [[`project_type:${PLUGIN_TYPES.includes(cfg.type) ? 'plugin' : 'mod'}`], loaders.map((l) => `categories:${l}`)];
  if (MOD_TYPES.includes(cfg.type)) facets.push(['server_side:required', 'server_side:optional']);
  if (cfg.version !== 'LATEST') facets.push([`versions:${cfg.version}`]);
  const url = `https://api.modrinth.com/v2/search?limit=20&query=${encodeURIComponent(String(query || '').slice(0, 100))}&facets=${encodeURIComponent(JSON.stringify(facets))}`;
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Modrinth a répondu ${res.status}`);
  const data = await res.json();
  return data.hits.map((h) => ({ slug: h.slug, title: h.title, description: h.description, icon: h.icon_url, downloads: h.downloads, author: h.author }));
}

async function upnpOpen(slug) {
  const cfg = get(slug);
  const st = await upnp.status();
  const r = await upnp.open(cfg.port, `HouseApp Minecraft ${cfg.name}`);
  cfg.upnp = true;
  put(slug, cfg);
  return { ...st, ...r, port: cfg.port };
}

async function upnpClose(slug) {
  const cfg = get(slug);
  await upnp.close(cfg.port);
  cfg.upnp = false;
  put(slug, cfg);
}

async function setPlayit(slug, { key, address }) {
  const cfg = get(slug);
  if (key !== undefined) {
    const k = String(key || '').trim();
    if (k && !/^[A-Za-z0-9_-]{16,256}$/.test(k)) throw new Error('Clé secrète playit.gg invalide');
    cfg.playit = k ? { key: k } : null;
  }
  if (address !== undefined) {
    const a = String(address || '').trim();
    if (a && !/^[A-Za-z0-9.-]{3,253}(:\d{1,5})?$/.test(a)) throw new Error('Adresse publique invalide');
    cfg.publicAddress = a;
  }
  put(slug, cfg);
  if (cfg.eula && (await D.exists(cname(slug)))) await startPlayit(slug, cfg, null);
}

async function testPublic(address) {
  if (!/^[A-Za-z0-9.-]{3,253}(:\d{1,5})?$/.test(String(address || ''))) throw new Error('Adresse invalide');
  const res = await fetch(`https://api.mcsrvstat.us/3/${encodeURIComponent(address)}`, { headers: UA, signal: AbortSignal.timeout(15000) });
  const d = await res.json();
  return { online: !!d.online, players: d.players ? `${d.players.online}/${d.players.max}` : null, version: d.version || null, motd: d.motd?.clean?.join(' ') || null };
}

async function publicInfo(slug) {
  const cfg = get(slug);
  const out = { port: cfg.port, upnp: cfg.upnp, playit: !!cfg.playit?.key, publicAddress: cfg.publicAddress, router: null };
  try { out.router = await upnp.status(); } catch (e) { out.routerError = e.message; }
  if (out.playit) {
    out.playitState = await D.state(playitName(slug));
    if (out.playitState && out.playitState !== 'running') {
      const logs = await D.logs(playitName(slug), 20).catch(() => '');
      const err = logs.split('\n').reverse().find((l) => /error|invalid/i.test(l));
      out.playitError = err ? err.replace(/\x1b\[[0-9;]*m/g, '').trim().slice(-200) : `Agent ${out.playitState}`;
    }
  }
  return out;
}

function renewUpnp() {
  for (const cfg of Object.values(load())) {
    if (cfg.upnp && cfg.eula) upnp.open(cfg.port, `HouseApp Minecraft ${cfg.name}`).catch(() => {});
  }
}

module.exports = {
  init, create, acceptEula, update, setProjects, list, power, remove, stopAll, removeAll, command,
  playersInfo, playerAction, listDir, readFile, writeFile, removePath, mkdir, rename, backupStream,
  searchProjects, upnpOpen, upnpClose, setPlayit, testPublic, publicInfo, renewUpnp, cname, TYPES, IMAGE,
};
