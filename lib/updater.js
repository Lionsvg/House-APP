// Mise a jour de HouseApp depuis l'interface (Parametres -> Mise a jour).
// - Windows : lance scripts/update.ps1 dans un processus detache ; il arrete HouseApp, remplace
//   les fichiers modifies puis le relance.
// - Linux : HouseApp tourne sans droits root ; il depose data/update.request, que l'unite systemd
//   houseapp-update.path surveille : elle lance /opt/houseapp/update.sh en root (installee par
//   install.sh / update.sh). La sortie est ecrite dans data/update.log.
// Dans les deux cas, l'avancement est suivi comme une tache (onglet Telechargements).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const A = require('./apps');

const REPO = 'Lionsvg/House-APP';
const ROOT = path.resolve(__dirname, '..');
const CURRENT = require('../package.json').version;
const LINUX_UNIT = '/etc/systemd/system/houseapp-update.path';

let dataDir = null;
let tail = null;

const logFile = () => path.join(dataDir, 'update.log');
const pendingFile = () => path.join(dataDir, 'update.pending');

function init(dir) {
  dataDir = dir;
  // HouseApp vient de redemarrer apres une mise a jour lancee depuis l'interface : on cloture la tache.
  let pending = null;
  try { pending = JSON.parse(fs.readFileSync(pendingFile(), 'utf8')); } catch { return; }
  const job = A.getJob(pending.job);
  if (!job) { fs.rmSync(pendingFile(), { force: true }); return; }
  job.status = 'running';
  job.error = null;
  follow(job, pending.from, Date.now() + 90 * 1000);
}

/** Recopie data/update.log dans la tache ; la termine quand le script a fini (ou au bout du delai). */
function follow(job, from, deadline) {
  clearInterval(tail);
  tail = setInterval(() => {
    let text = '';
    try { text = fs.readFileSync(logFile(), 'utf8'); } catch { /* pas encore cree */ }
    job.log = text.replace(/\uFEFF/g, '').split(/\r?\n/).filter((l) => l.trim() && !/^[#=\s\d.%-]+$/.test(l)).slice(-300);
    const failed = /\[X\]/.test(text);
    const finished = /\[OK\].*(->|Deja a jour)/.test(text);
    if (failed || finished || Date.now() > deadline) {
      clearInterval(tail);
      fs.rmSync(pendingFile(), { force: true });
      if (finished) job.status = 'done';
      else {
        job.error = failed ? (job.log.filter((l) => /\[X\]/.test(l)).pop() || 'Échec').replace(/^\s*\[X\]\s*/, '')
          : 'Pas de nouvelles du script de mise à jour (voir data/update.log)';
        job.status = 'error';
      }
    }
  }, 1000);
}

/** Peut-on mettre a jour depuis l'interface ? Sinon, pourquoi. */
function capability() {
  if (fs.existsSync(path.join(ROOT, '.git'))) {
    return { ok: false, reason: 'Installation de développement (dépôt git) : mettez à jour avec git pull.' };
  }
  if (process.platform === 'win32') {
    return fs.existsSync(path.join(ROOT, 'scripts', 'update.ps1')) && fs.existsSync(path.join(ROOT, 'node', 'node.exe'))
      ? { ok: true } : { ok: false, reason: 'Paquet Windows incomplet (scripts\\update.ps1 ou node\\node.exe manquant).' };
  }
  if (process.platform === 'linux') {
    return fs.existsSync(LINUX_UNIT) ? { ok: true }
      : { ok: false, reason: `Pour activer la mise à jour en un clic, lancez une fois sur le serveur : curl -fsSL https://raw.githubusercontent.com/${REPO}/main/update.sh | sudo bash` };
  }
  return { ok: false, reason: `Système non pris en charge (${process.platform}).` };
}

async function latest() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { 'User-Agent': 'HouseApp', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`GitHub a répondu ${res.status}`);
  const r = await res.json();
  return { version: String(r.tag_name || '').replace(/^v/, ''), url: r.html_url, published: r.published_at, notes: r.body || '' };
}

const newer = (a, b) => {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};

async function check() {
  const l = await latest();
  return { current: CURRENT, latest: l.version, available: newer(l.version, CURRENT), url: l.url, published: l.published, notes: l.notes };
}

function status() {
  return { current: CURRENT, running: fs.existsSync(pendingFile()), ...capability() };
}

function start() {
  const cap = capability();
  if (!cap.ok) throw new Error(cap.reason);
  if (fs.existsSync(pendingFile())) throw new Error('Une mise à jour est déjà en cours');
  const job = A.newJob('Mise à jour de HouseApp', 'update');
  A.log(job, `Version actuelle : ${CURRENT}. Recherche de la dernière version…`);
  fs.writeFileSync(logFile(), '');
  fs.writeFileSync(pendingFile(), JSON.stringify({ job: job.id, from: CURRENT, at: Date.now() }));
  const from = process.env.HOUSEAPP_UPDATE_FROM; // tests uniquement : paquets locaux au lieu de GitHub

  if (process.platform === 'win32') {
    // update.ps1 va arreter ce processus node : il doit lui survivre. Lance directement en "detached",
    // PowerShell 5.1 se ferme aussitot (pas de console) ; et un enfant normal est tue avec node.
    // On passe donc par cmd.exe detache, qui lance PowerShell ; le script ecrit lui-meme son journal.
    const q = (v) => `"${v}"`;
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    let cmd = `${q(ps)} -NoProfile -ExecutionPolicy Bypass -File ${q(path.join(ROOT, 'scripts', 'update.ps1'))}`
      + ` -Dir ${q(ROOT)} -Silent -LogFile ${q(logFile())}`;
    if (from) cmd += ` -From ${q(from)} -Version ${q(process.env.HOUSEAPP_UPDATE_VERSION || '')}`;
    // Si HouseApp a ete lance depuis PowerShell 7, PSModulePath pointe vers ses modules : le PowerShell 5.1
    // de Windows ne trouverait plus Get-FileHash & co. On le retire (5.1 reprend alors ses chemins par defaut).
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== 'psmodulepath'));
    const p = spawn('cmd.exe', ['/d', '/s', '/c', `"${cmd}"`], { detached: true, windowsHide: true, stdio: 'ignore', windowsVerbatimArguments: true, env });
    p.on('error', (e) => { A.log(job, e.message); });
    p.unref();
  } else {
    fs.writeFileSync(path.join(dataDir, 'update.request'), String(Date.now()));
  }
  follow(job, CURRENT, Date.now() + 15 * 60 * 1000);
  return job;
}

module.exports = { init, status, check, start, CURRENT };
