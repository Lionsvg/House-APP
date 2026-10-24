// Terminal dans un conteneur (fiche d'une appli -> Terminal), affiche par xterm.js dans le navigateur.
// Un vrai terminal (TTY) passe par l'API du moteur Docker : la commande "docker exec -it" exige
// elle-meme un terminal, ce qu'un service n'a pas. On parle donc directement a la socket Docker
// (celle de la commande docker : DOCKER_HOST ou contexte actif), sans module natif.
const http = require('http');
const crypto = require('crypto');
const D = require('./docker');
const WS = require('./ws');

const MAX_SESSIONS = 8;
const SHELL = ['/bin/sh', '-c', 'if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh -l; fi'];
let endpoint = null;
let sessions = 0;

/** Ou joindre le moteur Docker : unix:///..., npipe:////./pipe/... ou tcp://... */
async function getEndpoint() {
  if (endpoint) return endpoint;
  let host = process.env.DOCKER_HOST || '';
  if (!host) host = (await D.docker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']).catch(() => '')).trim();
  if (!host) host = process.platform === 'win32' ? 'npipe:////./pipe/docker_engine' : 'unix:///var/run/docker.sock';
  if (host.startsWith('unix://')) endpoint = { socketPath: host.slice(7) };
  else if (host.startsWith('npipe://')) endpoint = { socketPath: host.slice(8).replace(/\//g, '\\') };
  else if (host.startsWith('tcp://') && !process.env.DOCKER_TLS_VERIFY) {
    const u = new URL(host.replace(/^tcp:/, 'http:'));
    endpoint = { host: u.hostname, port: Number(u.port) || 2375 };
  } else throw new Error(`Connexion à Docker non prise en charge pour le terminal (${host})`);
  return endpoint;
}

function call(method, url, body) {
  return getEndpoint().then((ep) => new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({ ...ep, method, path: url, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} }, (res) => {
      let txt = '';
      res.on('data', (d) => (txt += d));
      res.on('end', () => {
        let json = null;
        try { json = txt ? JSON.parse(txt) : null; } catch { /* reponse vide ou texte */ }
        if (res.statusCode >= 400) reject(new Error(json?.message || txt.trim() || `Docker a répondu ${res.statusCode}`));
        else resolve(json);
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error('Docker ne répond pas')));
    req.on('error', reject);
    req.end(data);
  }));
}

/** Lance le shell et renvoie la connexion brute (flux du TTY dans les deux sens). */
function attach(execId) {
  return getEndpoint().then((ep) => new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify({ Detach: false, Tty: true }));
    const req = http.request({
      ...ep, method: 'POST', path: `/exec/${execId}/start`,
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, Connection: 'Upgrade', Upgrade: 'tcp' },
    });
    req.on('upgrade', (res, socket, head) => resolve({ socket, head }));
    req.on('response', (res) => {
      let txt = '';
      res.on('data', (d) => (txt += d));
      res.on('end', () => reject(new Error(txt.trim() || `Docker a répondu ${res.statusCode}`)));
    });
    req.on('error', reject);
    req.end(data);
  }));
}

// Fermer l'onglet ne tue pas ce qui tourne dans le conteneur (Docker garde le shell en vie).
// Chaque session marque ses processus avec HOUSEAPP_TERM=<jeton> ; a la fermeture on les arrete tous.
function killSession(name, token) {
  const script = 'for p in /proc/[0-9]*; do tr "\\000" "\\n" <"$p/environ" 2>/dev/null | grep -qx "HOUSEAPP_TERM=$1" && echo "${p#/proc/}"; done';
  const sig = (s) => `pids=$(${script}); [ -n "$pids" ] && kill -${s} $pids 2>/dev/null; true`;
  return D.docker(['exec', name, 'sh', '-c', `${sig('HUP')}; sleep 1; ${sig('KILL')}`, 'houseapp', token], { timeout: 15000 }).catch(() => {});
}

const size = (v, def, max) => Math.max(1, Math.min(max, Math.floor(Number(v)) || def));

/** Requete d'upgrade sur /api/containers/<nom>/terminal (l'appelant a deja verifie la session). */
async function handle(req, socket, head, name, query) {
  const fail = (code, msg) => socket.end(`HTTP/1.1 ${code}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${msg}`);
  if (sessions >= MAX_SESSIONS) return fail('429 Too Many Requests', 'Trop de terminaux ouverts');
  try {
    await D.assertOwned(name);
  } catch (e) { return fail('404 Not Found', e.message); }

  const ws = WS.accept(req, socket, head);
  if (!ws) return;
  sessions++;
  let docker = null;
  let execId = null;
  let gone = false;
  let exited = false;
  const token = crypto.randomBytes(12).toString('hex');
  const cleanup = () => {
    if (docker && !docker.destroyed) docker.destroy();
    if (execId && !exited) killSession(name, token);
  };
  ws.on('close', () => { gone = true; sessions--; cleanup(); });
  const early = []; // frappes recues avant que le shell soit pret
  ws.on('message', (m) => {
    if (typeof m !== 'string') {
      if (docker) { if (!docker.destroyed) docker.write(m); } else early.push(m);
      return;
    }
    let c = null;
    try { c = JSON.parse(m); } catch { return; }
    if (c.type === 'resize' && execId) call('POST', `/exec/${execId}/resize?h=${size(c.rows, 30, 200)}&w=${size(c.cols, 100, 500)}`).catch(() => {});
  });

  try {
    const cols = size(query.get('cols'), 100, 500);
    const rows = size(query.get('rows'), 30, 200);
    const ex = await call('POST', `/containers/${encodeURIComponent(name)}/exec`, {
      AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: true,
      Env: ['TERM=xterm-256color', 'COLORTERM=truecolor', `HOUSEAPP_TERM=${token}`], Cmd: SHELL, ConsoleSize: [rows, cols],
    });
    execId = ex.Id;
    const conn = await attach(execId);
    docker = conn.socket;
    if (gone) return cleanup(); // onglet ferme pendant le demarrage
    if (conn.head && conn.head.length) ws.send(conn.head);
    call('POST', `/exec/${execId}/resize?h=${rows}&w=${cols}`).catch(() => {});
    docker.on('data', (d) => ws.send(d));
    docker.on('close', async () => {
      if (gone) return;
      const info = await call('GET', `/exec/${execId}/json`).catch(() => null);
      exited = !!info && !info.Running;
      ws.send(JSON.stringify({ type: 'exit', code: info ? info.ExitCode : null }));
      ws.close();
    });
    docker.on('error', () => docker.destroy());
    for (const m of early.splice(0)) docker.write(m);
  } catch (e) {
    ws.send(JSON.stringify({ type: 'error', message: e.message }));
    ws.close();
  }
}

module.exports = { handle };
