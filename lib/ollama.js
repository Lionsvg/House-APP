// Modeles Ollama : "ollama pull" lance comme une tache (onglet Telechargements).
// Le telechargement continue meme si la page est fermee, contrairement au terminal.
const D = require('./docker');
const A = require('./apps');

const MODEL = /^[a-z0-9][\w.-]*(\/[\w.-]+)*(:[\w.-]+)?$/i;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const SPINNER = /[⠀-⣿]/g; // petite roue "⠋⠙⠹" affichee pendant l'attente

async function container(name) {
  const c = (await D.list('app')).find((x) => x.name === name);
  if (!c || c.labels['houseapp.app'] !== 'ollama') throw new Error('Ce conteneur n\'est pas Ollama');
  if (c.state !== 'running') throw new Error('Ollama est arrêté : démarrez-le d\'abord');
  return c;
}

async function pull(name, model) {
  model = String(model || '').trim();
  if (!MODEL.test(model) || model.length > 120) throw new Error('Nom de modèle invalide (ex : qwen3:8b)');
  await container(name);
  const job = A.newJob(`Modèle Ollama ${model}`, 'model');
  A.log(job, `ollama pull ${model}`);
  const p = D.dockerStream(['exec', name, 'ollama', 'pull', model]);
  // Ollama redessine tout son bloc de progression plusieurs fois par seconde ("pulling manifest",
  // "pulling 6a07…: 45% …") : on garde une ligne par etape, mise a jour sur place.
  const step = (l) => (/^pulling [0-9a-f]+:/.test(l) ? l.slice(0, l.indexOf(':') + 1) : l);
  const onData = (d) => {
    for (const raw of d.toString().replace(ANSI, '').replace(SPINNER, '').split(/[\r\n]+/)) {
      const line = raw.trim();
      if (!line) continue;
      const i = job.log.findIndex((l) => step(l) === step(line));
      if (i >= 0) job.log[i] = line;
      else A.log(job, line);
    }
  };
  p.stdout.on('data', onData);
  p.stderr.on('data', onData);
  p.on('error', (e) => { job.error = e.message; job.status = 'error'; });
  p.on('close', (code) => {
    if (job.status !== 'running') return;
    if (code === 0) { A.log(job, `Modèle ${model} prêt : ollama run ${model}`); job.status = 'done'; return; }
    job.error = job.log.filter((l) => /^Error/i.test(l)).pop()?.replace(/^Error:\s*/i, '') || `ollama pull a échoué (code ${code})`;
    job.status = 'error';
  });
  return job;
}

module.exports = { pull };
