const { execFile, spawn } = require('child_process');
const net = require('net');

const LABEL = 'houseapp=1';

function docker(args, { timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message || '').toString().trim();
        return reject(new Error(msg || 'Erreur Docker'));
      }
      resolve(stdout.toString());
    });
  });
}

function dockerRaw(args, { input = null, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn('docker', args, { windowsHide: true });
    const out = [];
    let err = '';
    const timer = setTimeout(() => { p.kill(); reject(new Error('Délai dépassé')); }, timeout);
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(err.trim() || `docker ${args[0]} a échoué (${code})`));
    });
    if (input) p.stdin.end(input); else p.stdin.end();
  });
}

function dockerStream(args) {
  return spawn('docker', args, { windowsHide: true });
}

async function state(name) {
  try {
    return (await docker(['inspect', '--format', '{{.State.Status}}', name])).trim();
  } catch {
    return null;
  }
}

async function volumeExists(name) {
  try {
    await docker(['volume', 'inspect', name]);
    return true;
  } catch {
    return false;
  }
}

async function available() {
  try {
    const v = await docker(['version', '--format', '{{.Server.Version}}'], { timeout: 10000 });
    return { ok: true, version: v.trim() };
  } catch (e) {
    if (/ENOENT/.test(e.message)) return { ok: false, error: 'Docker n\'est pas installé (commande docker introuvable)' };
    if (/permission denied/i.test(e.message)) return { ok: false, error: 'Accès à Docker refusé : l\'utilisateur doit faire partie du groupe docker' };
    return { ok: false, error: e.message };
  }
}

function parseLabels(str) {
  const out = {};
  for (const part of (str || '').split(',')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

async function list(kind) {
  const args = ['ps', '-a', '--no-trunc', '--filter', `label=${LABEL}`];
  if (kind) args.push('--filter', `label=houseapp.kind=${kind}`);
  args.push('--format', '{{json .}}');
  const out = await docker(args);
  return out.split('\n').filter(Boolean).map((line) => {
    const c = JSON.parse(line);
    return {
      id: c.ID,
      name: c.Names,
      image: c.Image,
      state: c.State,
      status: c.Status,
      ports: c.Ports,
      labels: parseLabels(c.Labels),
    };
  });
}

async function assertOwned(name) {
  const out = await docker(['inspect', '--format', '{{index .Config.Labels "houseapp"}}', name]).catch(() => '');
  if (out.trim() !== '1') throw new Error(`Conteneur ${name} introuvable ou non géré par HouseApp`);
}

async function action(name, verb) {
  if (!['start', 'stop', 'restart'].includes(verb)) throw new Error('Action invalide');
  await assertOwned(name);
  await docker([verb, name], { timeout: 120000 });
}

async function remove(name) {
  await assertOwned(name);
  await docker(['rm', '-f', name], { timeout: 120000 });
}

async function exists(name) {
  try {
    await docker(['inspect', '--format', '{{.Id}}', name]);
    return true;
  } catch {
    return false;
  }
}

async function logs(name, tail = 200) {
  await assertOwned(name);
  return new Promise((resolve, reject) => {
    const p = spawn('docker', ['logs', '--tail', String(tail), name], { windowsHide: true });
    let buf = '';
    p.stdout.on('data', (d) => (buf += d));
    p.stderr.on('data', (d) => (buf += d));
    p.on('error', reject);
    p.on('close', () => resolve(buf));
  });
}

function followLogs(name, tail, onData) {
  const p = spawn('docker', ['logs', '-f', '--tail', String(tail), name], { windowsHide: true });
  p.stdout.on('data', (d) => onData(d.toString()));
  p.stderr.on('data', (d) => onData(d.toString()));
  return p;
}

async function exec(name, cmdArgs, timeout = 20000) {
  await assertOwned(name);
  return docker(['exec', name, ...cmdArgs], { timeout });
}

async function stats() {
  const running = (await list()).filter((c) => c.state === 'running').map((c) => c.name);
  if (!running.length) return {};
  const out = await docker(['stats', '--no-stream', '--format', '{{json .}}', ...running], { timeout: 30000 });
  const res = {};
  for (const line of out.split('\n').filter(Boolean)) {
    const s = JSON.parse(line);
    res[s.Name] = { cpu: s.CPUPerc, mem: s.MemUsage, memPerc: s.MemPerc };
  }
  return res;
}

function portFree(port, proto = 'tcp') {
  if (proto === 'udp') {
    return new Promise((resolve) => {
      const s = require('dgram').createSocket('udp4');
      s.once('error', () => resolve(false));
      s.bind(port, '0.0.0.0', () => s.close(() => resolve(true)));
    });
  }
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '0.0.0.0', () => s.close(() => resolve(true)));
  });
}

async function nextFreePort(port, proto, reserved = new Set()) {
  let p = Number(port);
  for (let i = 0; i < 200; i++, p++) {
    if (p > 65535) break;
    if (reserved.has(`${p}/${proto}`)) continue;
    if (await portFree(p, proto)) return p;
  }
  throw new Error(`Aucun port libre trouvé à partir de ${port}`);
}

async function reservedPorts() {
  const set = new Set();
  const out = await docker(['ps', '-a', '-q', '--filter', `label=${LABEL}`]);
  const ids = out.split('\n').filter(Boolean);
  if (!ids.length) return set;
  const info = await docker(['inspect', '--format', '{{json .HostConfig.PortBindings}}', ...ids]);
  for (const line of info.split('\n').filter(Boolean)) {
    const b = JSON.parse(line) || {};
    for (const [key, binds] of Object.entries(b)) {
      const proto = key.split('/')[1] || 'tcp';
      for (const x of binds || []) if (x.HostPort) set.add(`${x.HostPort}/${proto}`);
    }
  }
  return set;
}

module.exports = {
  docker, dockerRaw, dockerStream, state, volumeExists, available, list, action, remove, exists, logs, followLogs, exec, stats,
  portFree, nextFreePort, reservedPorts, assertOwned, LABEL,
};
