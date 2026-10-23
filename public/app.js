const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ICON_CDN = 'https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/';
const svg = (id) => `<svg class="i"><use href="#i-${id}"/></svg>`;

const state = { catalog: null, cat: 'Toutes', view: 'home', installed: [], liveTimer: null, mcSources: {} };

async function api(method, url, body, raw) {
  const res = await fetch(url, {
    method,
    headers: raw ? { 'Content-Type': 'application/octet-stream' } : body ? { 'Content-Type': 'application/json' } : {},
    body: raw || (body ? JSON.stringify(body) : undefined),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.startsWith('/api/auth')) { showAuth(); throw new Error('Session expirée'); }
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data;
}

function toast(msg, isError) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast${isError ? ' error' : ''}`;
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add('hidden'), 4000);
}

function fmtBytes(b) {
  if (b == null) return '—';
  const u = ['o', 'Ko', 'Mo', 'Go', 'To'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(b < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}
const fmtUptime = (s) => `${Math.floor(s / 86400)} j ${Math.floor((s % 86400) / 3600)} h`;
const level = (p) => (p > 90 ? 'bad' : p > 75 ? 'warn' : '');
const meter = (p) => `<div class="meter ${level(p)}"><i style="width:${Math.max(0, Math.min(100, p || 0))}%"></i></div>`;

function iconHtml(icon, name, cls = 'icon') {
  const letter = esc((name || '?')[0].toUpperCase());
  if (!icon) return `<span class="${cls}">${letter}</span>`;
  const src = icon.startsWith('local:') ? `/api/local-apps/${encodeURIComponent(icon.slice(6))}/icon`
    : /^https?:\/\//.test(icon) ? icon : `${ICON_CDN}${icon}.png`;
  return `<img class="${cls}" src="${esc(src)}" alt="" loading="lazy" onerror="this.outerHTML='<span class=&quot;${cls}&quot;>${letter}</span>'">`;
}

function openModal(html) {
  $('#modalBody').innerHTML = html;
  $('#modal').classList.remove('hidden');
}
function closeModal() {
  $('#modal').classList.add('hidden');
  $('#modalBody').innerHTML = '';
}
$('#modalClose').onclick = closeModal;
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

async function followJob(jobId, onDone) {
  openModal(`<h3 id="jobTitle">Tâche en cours…</h3><p id="jobStatus" class="progress-text"></p><div class="joblog" id="jobLog"></div>
    <div class="modal-actions"><button class="btn" onclick="closeModal()">Fermer</button></div>`);
  for (;;) {
    let j;
    try { j = await api('GET', `/api/jobs/${jobId}`); } catch (e) { if ($('#jobStatus')) $('#jobStatus').textContent = e.message; return; }
    const log = $('#jobLog');
    if (!log) return;
    $('#jobTitle').textContent = j.title;
    log.textContent = j.log.join('\n');
    log.scrollTop = log.scrollHeight;
    if (j.status === 'done') { $('#jobStatus').innerHTML = '<span class="ok-text">Terminé.</span>'; onDone && onDone(j); return; }
    if (j.status === 'error') { $('#jobStatus').innerHTML = `<span class="err">Échec : ${esc(j.error)}</span>`; return; }
    $('#jobStatus').textContent = 'En cours… Le premier téléchargement d\'une image peut prendre plusieurs minutes.';
    await new Promise((r) => setTimeout(r, 1200));
  }
}

async function showAuth() {
  $('#main').classList.add('hidden');
  $('#auth').classList.remove('hidden');
  stopLive();
  const st = await api('GET', '/api/auth/status');
  const setup = !st.setup;
  $('#authHint').textContent = setup ? 'Première connexion : choisissez le mot de passe administrateur.' : 'Connectez-vous pour continuer.';
  $('#authPw2').classList.toggle('hidden', !setup);
  $('#authPw2').required = setup;
  $('#authBtn').textContent = setup ? 'Créer le mot de passe' : 'Connexion';
  $('#authForm').onsubmit = async (e) => {
    e.preventDefault();
    $('#authErr').textContent = '';
    const pw = $('#authPw').value;
    try {
      if (setup) {
        if (pw !== $('#authPw2').value) throw new Error('Les mots de passe ne correspondent pas');
        await api('POST', '/api/auth/setup', { password: pw });
      } else {
        await api('POST', '/api/auth/login', { password: pw });
      }
      $('#authPw').value = $('#authPw2').value = '';
      start();
    } catch (err) { $('#authErr').textContent = err.message; }
  };
  $('#authPw').focus();
}

function go(view) {
  state.view = view;
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('hidden', v.id !== `view-${view}`));
  if (view !== 'minecraft') closeMcConsoles();
  window.scrollTo(0, 0);
  Promise.resolve(({ home: loadInstalled, store: renderStore, minecraft: loadMinecraft, house: loadHouse, settings: loadSettings })[view]?.())
    .catch((e) => toast(`Erreur de chargement : ${e.message}`, true));
}
$$('#nav a').forEach((a) => (a.onclick = () => go(a.dataset.view)));
document.addEventListener('click', (e) => { const g = e.target.closest('[data-goto]'); if (g) go(g.dataset.goto); });

function tickClock() {
  $('#clock').textContent = new Date().toLocaleString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
setInterval(tickClock, 10000);
tickClock();

async function refreshLive() {
  let d;
  try { d = await api('GET', '/api/system/live'); } catch { return; }
  const info = state.info || {};

  $('#w-cpu').innerHTML = `<div class="label"><span>Processeur</span><span>${info.cores || '?'} threads</span></div>
    <div class="value">${d.cpu.load.toFixed(0)}<small> %</small></div>${meter(d.cpu.load)}
    <div class="cores">${d.cpu.cores.map((c) => `<span style="height:${Math.max(2, c * 0.18)}px"></span>`).join('')}</div>
    <div class="detail" title="${esc(info.cpu)}">${esc(info.cpu || '')}${d.cpu.temp ? ` · ${d.cpu.temp} °C` : ''}</div>`;

  const memPct = (d.mem.used / d.mem.total) * 100;
  $('#w-ram').innerHTML = `<div class="label"><span>Mémoire</span><span>${memPct.toFixed(0)} %</span></div>
    <div class="value">${fmtBytes(d.mem.used)}<small> / ${fmtBytes(d.mem.total)}</small></div>${meter(memPct)}
    <div class="detail">Swap ${fmtBytes(d.mem.swapUsed)} / ${fmtBytes(d.mem.swapTotal)}</div>`;

  const g = d.gpus[0];
  if (g) {
    const vramPct = g.memTotal ? (g.memUsed / g.memTotal) * 100 : null;
    const extra = [vramPct != null ? `VRAM ${(g.memUsed / 1024).toFixed(1)} / ${(g.memTotal / 1024).toFixed(1)} Go` : '', g.power != null ? `${g.power.toFixed(0)} W` : '', g.fan != null ? `ventilateur ${g.fan} %` : ''].filter(Boolean).join(' · ');
    $('#w-gpu').innerHTML = `<div class="label"><span>Carte graphique</span><span>${g.temp != null ? `${g.temp} °C` : ''}</span></div>
      <div class="value">${g.load == null ? '—' : g.load.toFixed(0)}<small> %</small></div>${meter(g.load || 0)}
      <div class="detail">${extra}</div><div class="detail" title="${esc(g.name)}">${esc(g.name)}</div>`;
  } else {
    $('#w-gpu').innerHTML = '<div class="label">Carte graphique</div><div class="value">—</div><div class="detail">Aucun GPU détecté</div>';
  }

  $('#w-net').innerHTML = `<div class="label"><span>Réseau</span><span>en ligne depuis ${fmtUptime(d.uptime)}</span></div>
    <div class="value">${fmtBytes(d.net.rx)}<small>/s reçus</small></div>
    <div class="detail">${fmtBytes(d.net.tx)}/s envoyés</div>
    <div class="detail">${esc(info.os || '')}</div>`;

  $('#w-disks').innerHTML = d.disks.map((k) => `<div>
      <div class="disk-row"><span>${esc(k.mount)}</span><span>${fmtBytes(k.used)} / ${fmtBytes(k.size)}</span></div>
      ${meter(k.use)}</div>`).join('') || '<span class="muted">Mesure en cours…</span>';
}
function startLive() {
  stopLive();
  refreshLive();
  state.liveTimer = setInterval(() => { if (state.view === 'home' && !document.hidden) refreshLive(); }, 2000);
}
function stopLive() { clearInterval(state.liveTimer); }

const appUrl = (web) => `${web.scheme}://${location.hostname}:${web.port}${web.path || '/'}`;

async function loadInstalled() {
  try { state.installed = await api('GET', '/api/apps'); } catch (e) { $('#appGrid').innerHTML = `<div class="card empty">${esc(e.message)}</div>`; return; }
  const grid = $('#appGrid');
  if (!state.installed.length) {
    grid.innerHTML = '<div class="card empty" style="grid-column:1/-1">Aucune application pour l\'instant. Installez-en une depuis le catalogue ou importez la vôtre.</div>';
    return;
  }
  grid.innerHTML = state.installed.map((a, i) => `<div class="card app-tile" data-i="${i}" title="${esc(a.status)}">
      ${iconHtml(a.icon, a.title)}<div class="name">${esc(a.title)}</div>
      <div class="state"><span class="dot ${a.state === 'running' ? 'running' : ''}"></span>${a.state === 'running' ? 'Active' : 'Arrêtée'}</div></div>`).join('');
  $$('.app-tile', grid).forEach((t) => (t.onclick = () => appMenu(state.installed[t.dataset.i])));
}

async function refreshModules() {
  state.info = await api('GET', '/api/system/info').catch(() => state.info);
  const mods = state.info?.modules || {};
  $$('#nav a[data-module]').forEach((a) => a.classList.toggle('hidden', !mods[a.dataset.module]));
  if (state.view && $(`#nav a[data-view="${state.view}"]`)?.classList.contains('hidden')) go('home');
}

function moduleMenu(a) {
  openModal(`<div class="modal-head">${iconHtml(a.icon, a.title, 'icon lg')}<div><h3>${esc(a.title)}</h3><span class="muted small">Module HouseApp</span></div></div>
    <div class="menu-list">
      <button class="btn primary" data-act="open">Ouvrir</button>
      <button class="btn danger" data-act="remove">Désinstaller</button>
    </div>`);
  $('[data-act="open"]', $('#modalBody')).onclick = () => { closeModal(); go(a.module); };
  $('[data-act="remove"]', $('#modalBody')).onclick = () => {
    openModal(`<h3>Désinstaller ${esc(a.title)} ?</h3>
      <p class="muted">L'onglet disparaît du menu et les serveurs sont arrêtés. Réinstaller le module les retrouve.</p>
      <label class="check"><input type="checkbox" id="rmPurge"> Supprimer aussi tous les serveurs et leurs mondes (irréversible)</label>
      <div class="modal-actions"><button class="btn" onclick="closeModal()">Annuler</button><button class="btn danger" id="rmGo">Désinstaller</button></div>`);
    $('#rmGo').onclick = async () => {
      $('#rmGo').disabled = true;
      try {
        await api('DELETE', `/api/modules/${a.module}?purge=${$('#rmPurge').checked ? 1 : 0}`);
        closeModal();
        toast(`${a.title} désinstallé`);
        await refreshModules();
        loadInstalled();
      } catch (e) { toast(e.message, true); $('#rmGo').disabled = false; }
    };
  };
}

function appMenu(a) {
  if (a.module) return moduleMenu(a);
  const running = a.state === 'running';
  openModal(`<div class="modal-head">${iconHtml(a.icon, a.title, 'icon lg')}<div><h3>${esc(a.title)}</h3><span class="muted small">${esc(a.image)}</span></div></div>
    <div class="kv"><span>État</span><span>${esc(a.status)}</span>
    <span>Adresse</span><span>${a.web ? `<a href="${esc(appUrl(a.web))}" target="_blank" rel="noopener">${esc(appUrl(a.web))}</a>` : 'Pas d\'interface web'}</span></div>
    <div class="menu-list">
      ${a.web && running ? '<button class="btn primary" data-act="open">Ouvrir</button>' : ''}
      ${running ? '<button class="btn" data-act="stop">Arrêter</button><button class="btn" data-act="restart">Redémarrer</button>' : '<button class="btn primary" data-act="start">Démarrer</button>'}
      <button class="btn" data-act="logs">Journaux</button>
      <button class="btn danger" data-act="remove">Désinstaller</button>
    </div>`);
  $$('[data-act]', $('#modalBody')).forEach((b) => (b.onclick = async () => {
    const act = b.dataset.act;
    if (act === 'open') return window.open(appUrl(a.web), '_blank', 'noopener');
    if (act === 'logs') {
      const { logs } = await api('GET', `/api/containers/${a.name}/logs`).catch((e) => ({ logs: e.message }));
      return openModal(`<h3>Journaux — ${esc(a.title)}</h3><div class="joblog" style="max-height:60vh">${esc(logs || '(vide)')}</div>`);
    }
    if (act === 'remove') return confirmRemove(a);
    b.disabled = true;
    try {
      await api('POST', `/api/containers/${a.name}/${act}`);
      toast(`${a.title} : ${({ start: 'démarrée', stop: 'arrêtée', restart: 'redémarrée' })[act]}`);
      closeModal();
      loadInstalled();
    } catch (e) { toast(e.message, true); b.disabled = false; }
  }));
}

function confirmRemove(a) {
  openModal(`<h3>Désinstaller ${esc(a.title)} ?</h3>
    <p class="muted">Le conteneur est supprimé.${a.local ? ' Les sources importées restent disponibles dans Applications.' : ''}</p>
    <label class="check"><input type="checkbox" id="rmData"> Supprimer aussi les données (irréversible)</label>
    <div class="modal-actions"><button class="btn" onclick="closeModal()">Annuler</button><button class="btn danger" id="rmGo">Désinstaller</button></div>`);
  $('#rmGo').onclick = async () => {
    $('#rmGo').disabled = true;
    try {
      await api('DELETE', `/api/containers/${a.name}?data=${$('#rmData').checked ? 1 : 0}`);
      toast(`${a.title} désinstallée`);
      closeModal();
      loadInstalled();
    } catch (e) { toast(e.message, true); $('#rmGo').disabled = false; }
  };
}

async function renderStore() {
  if (!state.catalog) state.catalog = await api('GET', '/api/catalog');
  state.installed = await api('GET', '/api/apps').catch(() => state.installed);
  renderLocal();
  renderCatalog();
}

function renderCatalog() {
  const { categories, apps } = state.catalog;
  $('#storeCount').textContent = `${apps.length} dans le catalogue`;
  $('#storeCats').innerHTML = ['Toutes', ...categories].map((c) => `<span class="chip ${c === state.cat ? 'active' : ''}" data-cat="${esc(c)}">${esc(c)}</span>`).join('');
  $$('.chip').forEach((c) => (c.onclick = () => { state.cat = c.dataset.cat; renderCatalog(); }));
  const q = $('#storeSearch').value.trim().toLowerCase();
  const installedIds = new Set(state.installed.map((a) => a.app));
  const list = apps.filter((a) => (state.cat === 'Toutes' || a.cat === state.cat) && (!q || `${a.name} ${a.desc} ${a.cat}`.toLowerCase().includes(q)));
  $('#storeGrid').innerHTML = list.map((a) => `<div class="card store-card">${iconHtml(a.icon, a.name)}
    <div class="info"><div class="title">${esc(a.name)}${a.gpu ? '<span class="tag accent">GPU</span>' : ''}</div>
    <span class="muted small">${esc(a.cat)}</span><p>${esc(a.desc)}</p>
    ${installedIds.has(a.id) ? '<button class="btn sm" disabled>Installée</button>' : `<button class="btn sm" data-install="${a.id}">Installer</button>`}</div></div>`).join('')
    || '<div class="card empty" style="grid-column:1/-1">Aucun résultat.</div>';
  $$('[data-install]').forEach((b) => (b.onclick = () => installDialog(apps.find((x) => x.id === b.dataset.install))));
}
$('#storeSearch').addEventListener('input', () => state.catalog && renderCatalog());

function installDialog(a) {
  const ports = a.ports || [];
  const env = a.env || {};
  openModal(`<div class="modal-head">${iconHtml(a.icon, a.name, 'icon lg')}<div><h3>${esc(a.name)}</h3><span class="muted small">${esc(a.image)}</span></div></div>
    <p class="muted" style="margin:0">${esc(a.desc)}</p>
    <form id="instForm">
      ${ports.length ? '<h4>Ports</h4><span class="muted small">Si un port est déjà pris, le suivant libre est choisi.</span>' : ''}
      ${ports.map((p, i) => { const [hc, proto] = p.split('/'); const [host, cont] = hc.split(':');
        return `<label>Port du serveur → ${esc(cont)}/${esc(proto || 'tcp')} dans l'appli</label><input name="port${i}" type="number" min="1" max="65535" value="${esc(host)}">`; }).join('')}
      ${Object.keys(env).length ? '<h4>Variables</h4><span class="muted small">Pensez à changer les mots de passe par défaut.</span>' : ''}
      ${Object.entries(env).map(([k, v]) => `<label>${esc(k)}</label><input name="env_${esc(k)}" value="${esc(v)}">`).join('')}
      ${(a.volumes || []).length ? '<h4>Stockage</h4><span class="muted small">Vide = volume géré par HouseApp. Sinon, un dossier du serveur (ex : D:\\Films ou /srv/films).</span>' : ''}
      ${(a.volumes || []).map((v, i) => `<label>${esc(v)}</label><input name="vol${i}" placeholder="Volume automatique">`).join('')}
      <div class="modal-actions"><button type="button" class="btn" onclick="closeModal()">Annuler</button><button class="btn primary">Installer</button></div>
    </form>`);
  $('#instForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = { ports: {}, env: {}, volumes: {} };
    ports.forEach((_, i) => (body.ports[i] = f.get(`port${i}`)));
    Object.keys(env).forEach((k) => (body.env[k] = f.get(`env_${k}`)));
    (a.volumes || []).forEach((_, i) => { const v = String(f.get(`vol${i}`) || '').trim(); if (v) body.volumes[i] = v; });
    try {
      const { job } = await api('POST', `/api/apps/${a.id}/install`, body);
      followJob(job, async () => {
        toast(`${a.name} installée`);
        if (a.module) await refreshModules();
        if (state.view === 'store') renderStore();
      });
    } catch (err) { toast(err.message, true); }
  };
}

async function renderLocal() {
  const list = await api('GET', '/api/local-apps').catch(() => []);
  $('#localSection').classList.toggle('hidden', !list.length);
  const byLocal = Object.fromEntries(state.installed.filter((a) => a.local).map((a) => [a.local, a]));
  $('#localGrid').innerHTML = list.map((l) => {
    const inst = byLocal[l.id];
    const st = inst ? `<span class="dot ${inst.state === 'running' ? 'running' : ''}"></span>${inst.state === 'running' ? 'Active' : 'Arrêtée'}` : 'Non installée';
    return `<div class="card store-card">${iconHtml(l.icon, l.name)}
      <div class="info"><div class="title">${esc(l.name)}${l.version ? `<span class="tag">v${esc(l.version)}</span>` : ''}</div>
      <span class="muted small">${st}</span>
      <p>${l.error ? `<span class="err">${esc(l.error)}</span>` : esc(l.description || 'Application importée')}</p>
      <div class="row-actions">
        ${l.error ? '' : `<button class="btn sm" data-rebuild="${esc(l.id)}">${inst ? 'Reconstruire' : 'Installer'}</button>`}
        <button class="btn sm danger" data-rmlocal="${esc(l.id)}">Supprimer</button>
      </div></div></div>`;
  }).join('');
  $$('[data-rebuild]').forEach((b) => (b.onclick = async () => {
    try {
      const { job } = await api('POST', `/api/local-apps/${b.dataset.rebuild}/rebuild`);
      followJob(job, () => { if (state.view === 'store') renderStore(); });
    } catch (e) { toast(e.message, true); }
  }));
  $$('[data-rmlocal]').forEach((b) => (b.onclick = () => {
    const l = list.find((x) => x.id === b.dataset.rmlocal);
    openModal(`<h3>Supprimer ${esc(l.name)} ?</h3>
      <p class="muted">Le conteneur, l'image et les sources importées seront supprimés.</p>
      <label class="check"><input type="checkbox" id="rmData"> Supprimer aussi les données (irréversible)</label>
      <div class="modal-actions"><button class="btn" onclick="closeModal()">Annuler</button><button class="btn danger" id="rmGo">Supprimer</button></div>`);
    $('#rmGo').onclick = async () => {
      $('#rmGo').disabled = true;
      try { await api('DELETE', `/api/local-apps/${l.id}?data=${$('#rmData').checked ? 1 : 0}`); closeModal(); toast(`${l.name} supprimée`); renderStore(); }
      catch (e) { toast(e.message, true); $('#rmGo').disabled = false; }
    };
  }));
}

const IGNORED_DIRS = /(^|\/)(bin|obj|\.vs|\.git|\.idea|node_modules|TestResults)(\/|$)/;

async function importFolder(files) {
  const items = files.map((f) => ({ f, rel: (f.webkitRelativePath || f.name).split('/').slice(1).join('/') || f.name }))
    .filter((x) => !IGNORED_DIRS.test(x.rel));
  if (!items.some((x) => x.rel === 'import.json')) {
    return toast('Ce dossier ne contient pas import.json à sa racine', true);
  }
  const total = items.reduce((s, x) => s + x.f.size, 0);
  openModal(`<h3>Import en cours</h3><p class="progress-text" id="upText">Préparation…</p><div class="meter" style="margin-top:8px"><i id="upBar" style="width:0%"></i></div>`);
  try {
    const { token } = await api('POST', '/api/import/start');
    let done = 0, sent = 0;
    const queue = [...items];
    const worker = async () => {
      while (queue.length) {
        const x = queue.shift();
        await api('PUT', `/api/import/${token}/file?path=${encodeURIComponent(x.rel)}`, null, x.f);
        done++; sent += x.f.size;
        if ($('#upText')) { $('#upText').textContent = `${done} / ${items.length} fichiers (${fmtBytes(sent)} / ${fmtBytes(total)})`; $('#upBar').style.width = `${(sent / (total || 1)) * 100}%`; }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    await finishImport(token);
  } catch (e) { closeModal(); toast(e.message, true); }
}

async function importZip(file) {
  openModal(`<h3>Import en cours</h3><p class="progress-text">Envoi de ${esc(file.name)} (${fmtBytes(file.size)})…</p>`);
  try {
    const { token } = await api('POST', '/api/import/start');
    await api('POST', `/api/import/${token}/zip`, null, file);
    await finishImport(token);
  } catch (e) { closeModal(); toast(e.message, true); }
}

async function finishImport(token) {
  const { job } = await api('POST', `/api/import/${token}/finish`);
  followJob(job, () => { toast('Application importée et installée'); if (state.view === 'store') renderStore(); });
  if (state.view === 'store') renderLocal();
}

$('#importFolderBtn').onclick = () => $('#importFolder').click();
$('#importZipBtn').onclick = () => $('#importZip').click();
$('#importFolder').onchange = (e) => { const f = [...e.target.files]; e.target.value = ''; if (f.length) importFolder(f); };
$('#importZip').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importZip(f); };

const box = $('#importBox');
box.addEventListener('dragover', (e) => { e.preventDefault(); box.classList.add('drag'); });
box.addEventListener('dragleave', () => box.classList.remove('drag'));
box.addEventListener('drop', async (e) => {
  e.preventDefault();
  box.classList.remove('drag');
  const entry = e.dataTransfer.items?.[0]?.webkitGetAsEntry?.();
  if (entry?.isDirectory) return importFolder(await readEntry(entry, entry.name));
  const f = e.dataTransfer.files[0];
  if (f && /\.zip$/i.test(f.name)) importZip(f);
  else toast('Déposez un dossier ou un fichier .zip', true);
});
async function readEntry(entry, prefix) {
  if (entry.isFile) {
    const f = await new Promise((res, rej) => entry.file(res, rej));
    Object.defineProperty(f, 'webkitRelativePath', { value: prefix });
    return [f];
  }
  if (/^(bin|obj|\.vs|\.git|node_modules)$/.test(entry.name) && prefix.includes('/')) return [];
  const reader = entry.createReader();
  let all = [];
  for (;;) {
    const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
    if (!batch.length) break;
    for (const c of batch) all = all.concat(await readEntry(c, `${prefix}/${c.name}`));
  }
  return all;
}

const DOMAIN_FR = { light: 'Lumières', switch: 'Interrupteurs', sensor: 'Capteurs', binary_sensor: 'Détecteurs', climate: 'Climat', cover: 'Volets', fan: 'Ventilateurs', media_player: 'Lecteurs', lock: 'Serrures', scene: 'Scènes', script: 'Scripts', automation: 'Automatisations', input_boolean: 'Interrupteurs virtuels', person: 'Personnes', weather: 'Météo', camera: 'Caméras', button: 'Boutons', sun: 'Soleil' };
const DOMAIN_ORDER = ['light', 'switch', 'climate', 'cover', 'fan', 'lock', 'media_player', 'scene', 'script', 'sensor', 'binary_sensor', 'person', 'weather'];

async function loadHouse() {
  const body = $('#haBody');
  const cfg = await api('GET', '/api/ha/config').catch(() => ({}));
  if (!cfg.url || !cfg.hasToken) {
    const localHa = state.installed.find((a) => a.app === 'homeassistant');
    body.innerHTML = `<div class="card" style="padding:18px">
      <h3>Connecter Home Assistant</h3>
      <p class="muted">${localHa ? 'Home Assistant est installé sur ce serveur. ' : 'Installez Home Assistant depuis Applications, ou connectez une instance existante. '}
      Dans Home Assistant : Profil → Sécurité → Jetons d'accès longue durée → Créer un jeton, puis collez-le ici.</p>
      <div class="row-actions">${localHa ? '' : '<button class="btn" data-goto="store">Aller aux applications</button>'}
      <button class="btn primary" id="haConnect">Configurer la connexion</button></div></div>`;
    $('#haConnect').onclick = haDialog;
    return;
  }
  body.innerHTML = '<div class="card empty">Chargement des appareils…</div>';
  let ents;
  try { ents = await api('GET', '/api/ha/states'); } catch (e) {
    body.innerHTML = `<div class="card" style="padding:18px"><p class="err" style="margin-top:0">${esc(e.message)}</p><button class="btn" id="haConnect">Modifier la connexion</button></div>`;
    $('#haConnect').onclick = haDialog;
    return;
  }
  const groups = {};
  for (const e of ents) (groups[e.domain] ||= []).push(e);
  const domains = Object.keys(groups).sort((a, b) => {
    const ia = DOMAIN_ORDER.indexOf(a), ib = DOMAIN_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  const ON = ['on', 'open', 'unlocked', 'playing', 'home', 'heat', 'cool', 'auto'];
  body.innerHTML = domains.map((d) => `<div class="ha-domain"><h3>${esc(DOMAIN_FR[d] || d.replace(/_/g, ' '))} <span class="muted small">${groups[d].length}</span></h3>
    <div class="ha-grid">${groups[d].map((e) => `<div class="card ha-card ${ON.includes(e.state) ? 'on' : ''} ${e.action ? 'clickable' : ''}" data-ent="${esc(e.id)}" title="${esc(e.id)}">
      <span class="n">${esc(e.name)}</span><span class="s">${esc(e.state)}${e.unit ? ' ' + esc(e.unit) : ''}</span></div>`).join('')}</div></div>`).join('')
    || '<div class="card empty">Aucune entité trouvée.</div>';
  $$('.ha-card.clickable', body).forEach((c) => (c.onclick = async () => {
    c.style.opacity = 0.5;
    try { await api('POST', '/api/ha/toggle', { entity_id: c.dataset.ent }); setTimeout(loadHouse, 600); }
    catch (e) { toast(e.message, true); c.style.opacity = 1; }
  }));
}

async function haDialog() {
  const cfg = await api('GET', '/api/ha/config').catch(() => ({}));
  const localHa = state.installed.find((a) => a.app === 'homeassistant');
  const def = cfg.url || (localHa?.web ? `http://localhost:${localHa.web.port}` : 'http://localhost:8123');
  openModal(`<h3>Connexion à Home Assistant</h3>
    <form id="haForm"><label>Adresse (vue depuis le serveur HouseApp)</label><input name="url" value="${esc(def)}" required>
    <label>Jeton d'accès longue durée ${cfg.hasToken ? '(vide = garder l\'actuel)' : ''}</label><input name="token" type="password" ${cfg.hasToken ? '' : 'required'}>
    <p class="err" id="haErr"></p>
    <div class="modal-actions"><button type="button" class="btn" onclick="closeModal()">Annuler</button><button class="btn primary">Tester et enregistrer</button></div></form>`);
  $('#haForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api('POST', '/api/ha/config', { url: f.get('url'), token: f.get('token') });
      closeModal(); toast('Home Assistant connecté'); loadHouse();
    } catch (err) { $('#haErr').textContent = err.message; }
  };
}
$('#haSetup').onclick = haDialog;
$('#haRefresh').onclick = loadHouse;

async function loadSettings() {
  const i = await api('GET', '/api/system/info').catch(() => ({}));
  state.info = i;
  $('#sysInfo').innerHTML = `<div class="kv">
    <span>Machine</span><span>${esc(i.hostname)}</span><span>Système</span><span>${esc(i.os)} (${esc(i.arch)})</span>
    <span>Processeur</span><span>${esc(i.cpu)} · ${i.physicalCores} cœurs / ${i.cores} threads</span>
    <span>GPU</span><span>${esc((i.gpus || []).map((g) => g.name).join(', ') || 'aucun')}</span>
    <span>Docker</span><span>${i.docker?.ok ? esc(i.docker.version) : '<span class="err">indisponible</span>'}</span></div>`;

  const a = i.access || {};
  const all = (a.hosts || []).includes('0.0.0.0');
  const link = (host) => { const u = `http://${host}:${a.port}`; return `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a>`; };
  const ts = (a.tailscale || []).filter((ip) => all || a.hosts.includes(ip));
  $('#accessInfo').innerHTML = `<div class="kv">
    <span>Écoute sur</span><span>${esc((a.hosts || []).join(', '))}</span>
    <span>Tailscale</span><span>${ts.length ? [...(a.magicDns ? [a.magicDns] : []), ...ts].map(link).join('<br>') : '<span class="muted">non actif</span>'}</span>
    ${all ? `<span>Réseau local</span><span>${(a.lan || []).map(link).join('<br>') || '—'}</span>` : ''}</div>
    <p class="muted small" style="margin-bottom:0">Les applications s'ouvrent avec l'adresse utilisée pour accéder à HouseApp.</p>`;
  renderThemeSeg();
}

function currentTheme() { try { return localStorage.getItem('theme') || 'auto'; } catch { return 'auto'; } }
function renderThemeSeg() {
  $$('#themeSeg button').forEach((b) => b.classList.toggle('active', b.dataset.theme === currentTheme()));
}
$$('#themeSeg button').forEach((b) => (b.onclick = () => {
  const t = b.dataset.theme;
  try { t === 'auto' ? localStorage.removeItem('theme') : localStorage.setItem('theme', t); } catch { }
  if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  renderThemeSeg();
}));

$('#pwForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try { await api('POST', '/api/auth/password', Object.fromEntries(f.entries())); $('#pwMsg').innerHTML = '<span class="ok-text">Mot de passe modifié</span>'; e.target.reset(); }
  catch (err) { $('#pwMsg').textContent = err.message; }
};
$('#logout').onclick = async () => { await api('POST', '/api/auth/logout'); showAuth(); };

async function start() {
  $('#auth').classList.add('hidden');
  $('#main').classList.remove('hidden');
  try {
    state.info = await api('GET', '/api/system/info');
    $('#hostname').textContent = state.info.hostname;
    const w = $('#dockerWarn');
    if (!state.info.docker.ok) { w.textContent = `Docker est indisponible : ${state.info.docker.error}. Lancez Docker Desktop pour installer des applications.`; w.classList.remove('hidden'); }
    else w.classList.add('hidden');
  } catch { }
  await refreshModules();
  startLive();
  go('home');
}

api('GET', '/api/auth/status').then((st) => (st.logged ? start() : showAuth())).catch(() => showAuth());
