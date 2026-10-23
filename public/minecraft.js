const mc = { slug: null, tab: 'console', servers: [], types: [], path: '', source: null, timer: null };
const MC_TEXT = /\.(properties|json|ya?ml|txt|toml|cfg|conf|log|ini|csv|md|xml|sh|mcmeta|sk|js|secret|lang)$/i;
const MC_EULA_URL = 'https://aka.ms/MinecraftEULA';
const mcApi = (slug, sub = '') => `/api/minecraft/${encodeURIComponent(slug)}${sub}`;

function closeMcConsoles() {
  if (mc.source) mc.source.close();
  mc.source = null;
  clearInterval(mc.timer);
  mc.timer = null;
}

async function mcFetch() {
  const d = await api('GET', '/api/minecraft');
  mc.servers = d.servers;
  mc.types = d.types;
}

function mcPill(s) {
  if (s.state === 'eula') return '<span class="pill starting">CLUF à accepter</span>';
  if (s.state !== 'running') return `<span class="pill stopped">${s.state === 'missing' ? 'Absent' : 'Arrêté'}</span>`;
  return s.health === 'healthy' ? '<span class="pill running">En ligne</span>' : '<span class="pill starting">Démarrage</span>';
}

async function loadMinecraft() {
  closeMcConsoles();
  const view = $('#view-minecraft');
  try { await mcFetch(); } catch (e) { view.innerHTML = `<div class="card empty">${esc(e.message)}</div>`; return; }
  if (mc.slug && mc.servers.some((s) => s.slug === mc.slug)) return mcDetail();
  mc.slug = null;
  view.innerHTML = `<div class="page-head"><h2>Serveurs Minecraft</h2>
      <button class="btn primary" id="mcNew">${svg('plus')}Nouveau serveur</button></div>
    <div class="mc-list">${mc.servers.map((s) => `<div class="card mc-card" data-slug="${esc(s.slug)}">
      <div class="mc-head"><h3>${esc(s.name)}</h3>${mcPill(s)}
        <div class="row-actions">${s.state === 'eula'
          ? '<button class="btn sm primary" data-a="eula">Accepter le CLUF et démarrer</button>'
          : `<button class="btn sm primary" data-a="open">Gérer</button>${s.state === 'running'
            ? '<button class="btn sm" data-a="stop">Arrêter</button>' : '<button class="btn sm" data-a="start">Démarrer</button>'}`}
        </div></div>
      <div class="mc-meta"><span>Adresse <b>${esc(location.hostname)}:${s.port}</b></span>
        ${s.publicAddress ? `<span>Internet <b>${esc(s.publicAddress)}</b></span>` : ''}
        <span>Version <b>${esc(s.type)} ${esc(s.version)}</b></span><span>RAM <b>${esc(s.memory)}</b></span>
        ${s.whitelist ? '<span><b>Whitelist</b></span>' : ''}${s.modrinth.length ? `<span>${s.modrinth.length} <b>${s.kind === 'mods' ? 'mods' : 'plugins'}</b></span>` : ''}</div>
    </div>`).join('') || '<div class="card empty">Aucun serveur. Créez-en un avec « Nouveau serveur ».</div>'}</div>`;
  $('#mcNew').onclick = () => mcFormDialog(null);
  $$('.mc-card', view).forEach((card) => {
    const s = mc.servers.find((x) => x.slug === card.dataset.slug);
    $$('[data-a]', card).forEach((b) => (b.onclick = async () => {
      const a = b.dataset.a;
      if (a === 'eula') return mcEula(s);
      if (a === 'open') { mc.slug = s.slug; mc.tab = 'console'; mc.path = ''; return mcDetail(); }
      b.disabled = true;
      try { await api('POST', mcApi(s.slug, `/power/${a}`)); } catch (e) { toast(e.message, true); }
      loadMinecraft();
    }));
  });
}

function mcEula(s) {
  openModal(`<h3>Contrat de licence de Minecraft</h3>
    <p class="muted">Pour faire tourner un serveur, Mojang exige que vous acceptiez le CLUF (EULA) de Minecraft.
    Lisez-le ici : <a href="${MC_EULA_URL}" target="_blank" rel="noopener">${MC_EULA_URL}</a></p>
    <p class="muted small">HouseApp n'accepte jamais ce contrat à votre place : le serveur « ${esc(s.name)} » ne démarrera qu'après votre clic.</p>
    <div class="modal-actions"><button class="btn" onclick="closeModal()">Plus tard</button>
      <button class="btn primary" id="eulaOk">J'ai lu et j'accepte le CLUF</button></div>`);
  $('#eulaOk').onclick = async () => {
    $('#eulaOk').disabled = true;
    try {
      const { job } = await api('POST', mcApi(s.slug, '/eula'));
      followJob(job, () => { if (state.view === 'minecraft') loadMinecraft(); });
    } catch (e) { toast(e.message, true); $('#eulaOk').disabled = false; }
  };
}

function mcFormHtml(s) {
  const isNew = !s;
  s = s || { name: '', type: 'PAPER', version: 'LATEST', memory: '4G', port: 25565, maxPlayers: 20, gamemode: 'survival', difficulty: 'normal', motd: 'Un serveur HouseApp', onlineMode: true, pvp: true, hardcore: false, allowNether: true, commandBlocks: false, viewDistance: 10, levelType: 'minecraft:normal', seed: '', whitelist: false, whitelistPlayers: [], ops: [], modrinth: [] };
  const opt = (list, v) => list.map((x) => `<option value="${esc(x[0])}" ${x[0] === v ? 'selected' : ''}>${esc(x[1])}</option>`).join('');
  const TYPE_LABEL = { PAPER: 'Paper (plugins)', PURPUR: 'Purpur (plugins)', SPIGOT: 'Spigot (plugins)', VANILLA: 'Vanilla', FABRIC: 'Fabric (mods)', FORGE: 'Forge (mods)', NEOFORGE: 'NeoForge (mods)' };
  const chk = (n, v, label) => `<label class="check" style="margin-top:8px"><input type="checkbox" name="${n}" ${v ? 'checked' : ''}> ${label}</label>`;
  return `<form id="mcForm">
    <h4 style="margin-top:4px">Général</h4>
    <label>Nom</label><input name="name" required maxlength="40" value="${esc(s.name)}" ${isNew ? '' : 'readonly'}>
    <div class="row2">
      <div><label>Type</label><select name="type">${opt((mc.types.length ? mc.types : Object.keys(TYPE_LABEL)).map((t) => [t, TYPE_LABEL[t] || t]), s.type)}</select></div>
      <div><label>Version (LATEST ou 1.21.4…)</label><input name="version" value="${esc(s.version)}"></div>
      <div><label>Mémoire</label><select name="memory">${opt([['2G', '2 Go'], ['3G', '3 Go'], ['4G', '4 Go'], ['6G', '6 Go'], ['8G', '8 Go'], ['12G', '12 Go'], ['16G', '16 Go']], s.memory)}</select></div>
      <div><label>Port</label><input name="port" type="number" min="1024" max="65535" value="${s.port}"></div>
    </div>
    <h4>Partie</h4>
    <div class="row2">
      <div><label>Mode de jeu</label><select name="gamemode">${opt([['survival', 'Survie'], ['creative', 'Créatif'], ['adventure', 'Aventure'], ['spectator', 'Spectateur']], s.gamemode)}</select></div>
      <div><label>Difficulté</label><select name="difficulty">${opt([['peaceful', 'Paisible'], ['easy', 'Facile'], ['normal', 'Normale'], ['hard', 'Difficile']], s.difficulty)}</select></div>
      <div><label>Joueurs max</label><input name="maxPlayers" type="number" min="1" max="500" value="${s.maxPlayers}"></div>
      <div><label>Distance de vue (chunks)</label><input name="viewDistance" type="number" min="3" max="32" value="${s.viewDistance}"></div>
      <div><label>Type de monde</label><select name="levelType" ${isNew ? '' : 'disabled title="Le monde existe déjà"'}>${opt([['minecraft:normal', 'Normal'], ['minecraft:flat', 'Plat'], ['minecraft:large_biomes', 'Grands biomes'], ['minecraft:amplified', 'Amplifié']], s.levelType)}</select></div>
      <div><label>Seed (optionnel)</label><input name="seed" value="${esc(s.seed)}" ${isNew ? '' : 'disabled title="Le monde existe déjà"'}></div>
    </div>
    <label>Message du jour (MOTD)</label><input name="motd" value="${esc(s.motd)}">
    ${chk('pvp', s.pvp, 'PvP')}${chk('hardcore', s.hardcore, 'Hardcore')}${chk('allowNether', s.allowNether, 'Nether activé')}
    ${chk('commandBlocks', s.commandBlocks, 'Blocs de commande')}${chk('onlineMode', s.onlineMode, 'Mode en ligne (comptes Minecraft officiels uniquement)')}
    <h4>Joueurs</h4>
    ${chk('whitelist', s.whitelist, 'Whitelist : seuls les joueurs listés peuvent se connecter')}
    <label>Joueurs autorisés (whitelist), séparés par des virgules ou des retours à la ligne</label>
    <textarea name="whitelistPlayers" rows="2" placeholder="Steve, Alex">${esc(s.whitelistPlayers.join(', '))}</textarea>
    <label>Opérateurs (admins du serveur)</label>
    <textarea name="ops" rows="1" placeholder="VotrePseudo">${esc(s.ops.join(', '))}</textarea>
    <h4>Plugins / mods depuis Modrinth</h4>
    <span class="muted small">Identifiants Modrinth (ex : <code>luckperms</code>, <code>essentialsx</code> pour Paper ; <code>fabric-api</code>, <code>lithium</code> pour Fabric). Téléchargés automatiquement avec leurs dépendances. Vous pourrez aussi chercher et envoyer des .jar depuis le panel.</span>
    <textarea name="modrinth" rows="2" placeholder="luckperms, essentialsx">${esc(s.modrinth.join(', '))}</textarea>
    <div class="modal-actions"><button type="button" class="btn" onclick="closeModal()">Annuler</button>
      <button class="btn primary">${isNew ? 'Créer le serveur' : 'Enregistrer et redémarrer'}</button></div>
  </form>`;
}

function mcFormBody(form) {
  const f = new FormData(form);
  const body = Object.fromEntries(f.entries());
  for (const k of ['pvp', 'hardcore', 'allowNether', 'commandBlocks', 'onlineMode', 'whitelist']) body[k] = f.has(k);
  return body;
}

function mcFormDialog(s) {
  openModal(`<h3>${s ? `Réglages — ${esc(s.name)}` : 'Nouveau serveur Minecraft'}</h3>${mcFormHtml(s)}`);
  $('#mcForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const { slug } = await api('POST', '/api/minecraft', mcFormBody(e.target));
      await mcFetch();
      mcEula(mc.servers.find((x) => x.slug === slug));
      loadMinecraftQuiet();
    } catch (err) { toast(err.message, true); }
  };
}

function loadMinecraftQuiet() {
  if (state.view === 'minecraft' && !mc.slug) loadMinecraft();
}

async function mcDetail() {
  closeMcConsoles();
  const s = mc.servers.find((x) => x.slug === mc.slug);
  const view = $('#view-minecraft');
  const tabs = [['console', 'Console'], ['players', 'Joueurs'], ...(s.kind ? [['addons', s.kind === 'mods' ? 'Mods' : 'Plugins']] : []),
    ['files', 'Fichiers'], ['public', 'Accès Internet'], ['settings', 'Réglages']];
  if (!tabs.some((t) => t[0] === mc.tab)) mc.tab = 'console';
  const running = s.state === 'running';
  view.innerHTML = `<div class="page-head">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><button class="btn sm" id="mcBack">← Serveurs</button><h2>${esc(s.name)}</h2>${mcPill(s)}</div>
      <div class="actions">${s.state === 'eula' ? '<button class="btn primary" data-p="eula">Accepter le CLUF et démarrer</button>'
        : running ? '<button class="btn" data-p="restart">Redémarrer</button><button class="btn" data-p="stop">Arrêter</button>'
          : '<button class="btn primary" data-p="start">Démarrer</button>'}</div></div>
    <div class="mc-meta" style="margin-top:-6px"><span>Adresse locale <b>${esc(location.hostname)}:${s.port}</b></span>
      ${s.publicAddress ? `<span>Internet <b>${esc(s.publicAddress)}</b></span>` : ''}
      <span>Version <b>${esc(s.type)} ${esc(s.version)}</b></span><span>RAM <b>${esc(s.memory)}</b></span>
      <span>Joueurs <b id="mcOnline">—</b></span><span>Charge <b id="mcLoad">—</b></span></div>
    <div class="tabs">${tabs.map(([id, label]) => `<button data-tab="${id}" class="${id === mc.tab ? 'active' : ''}">${label}</button>`).join('')}</div>
    <div id="mcTab"></div>`;
  $('#mcBack').onclick = () => { mc.slug = null; loadMinecraft(); };
  $$('[data-p]', view).forEach((b) => (b.onclick = async () => {
    if (b.dataset.p === 'eula') return mcEula(s);
    b.disabled = true;
    try { await api('POST', mcApi(s.slug, `/power/${b.dataset.p}`)); toast('C\'est fait'); } catch (e) { toast(e.message, true); }
    loadMinecraft();
  }));
  $$('.tabs button', view).forEach((b) => (b.onclick = () => { mc.tab = b.dataset.tab; mcDetail(); }));
  if (running) {
    mcLive(s);
    mc.timer = setInterval(() => { if (!document.hidden) mcLive(s); }, 10000);
  }
  const fn = { console: mcConsole, players: mcPlayers, addons: mcAddons, files: mcFiles, public: mcPublic, settings: mcSettings }[mc.tab];
  try { await fn(s, $('#mcTab')); } catch (e) { $('#mcTab').innerHTML = `<div class="card empty">${esc(e.message)}</div>`; }
}

function mcLive(s) {
  api('GET', mcApi(s.slug, '/players')).then((p) => { const el = $('#mcOnline'); if (el) el.textContent = `${p.online}${p.max ? '/' + p.max : ''}`; }).catch(() => {});
  api('GET', '/api/apps/stats').then((st) => { const x = st[s.container]; const el = $('#mcLoad'); if (x && el) el.textContent = `CPU ${x.cpu} · RAM ${x.mem.split('/')[0].trim()}`; }).catch(() => {});
}

function mcConsole(s, el) {
  el.innerHTML = `<div class="console"></div>
    <form class="cmd-row"><input placeholder="Commande : op Steve, time set day, say Salut" ${s.state === 'running' ? '' : 'disabled'}>
    <button class="btn" ${s.state === 'running' ? '' : 'disabled'}>Envoyer</button></form>`;
  const out = $('.console', el);
  if (s.state === 'eula') { out.textContent = 'Acceptez le CLUF de Minecraft pour démarrer ce serveur.'; return; }
  if (s.state === 'missing') { out.textContent = 'Le conteneur n\'existe plus : ouvrez Réglages et enregistrez pour le recréer.'; return; }
  mc.source = new EventSource(mcApi(s.slug, '/console'));
  mc.source.onmessage = (ev) => {
    const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
    out.textContent += JSON.parse(ev.data);
    if (out.textContent.length > 200000) out.textContent = out.textContent.slice(-150000);
    if (atBottom) out.scrollTop = out.scrollHeight;
  };
  mc.source.onerror = () => mc.source && mc.source.close();
  $('.cmd-row', el).onsubmit = async (e) => {
    e.preventDefault();
    const input = $('input', e.target);
    const cmd = input.value.trim();
    if (!cmd) return;
    input.value = '';
    out.textContent += `> ${cmd}\n`;
    try {
      const { output } = await api('POST', mcApi(s.slug, '/command'), { command: cmd });
      if (output) out.textContent += `${output}\n`;
    } catch (err) { out.textContent += `[erreur] ${err.message}\n`; }
    out.scrollTop = out.scrollHeight;
  };
}

async function mcPlayers(s, el) {
  if (s.state !== 'running') { el.innerHTML = '<div class="card empty">Démarrez le serveur pour gérer les joueurs.</div>'; return; }
  const p = await api('GET', mcApi(s.slug, '/players'));
  const row = (name, buttons) => `<div class="list-row"><span><img class="avatar" src="https://mc-heads.net/avatar/${encodeURIComponent(name)}/24" alt="" loading="lazy" onerror="this.remove()">${esc(name)}</span>
    <span class="row-actions">${buttons.map(([a, l, d]) => `<button class="btn sm ${d ? 'danger' : ''}" data-act="${a}" data-name="${esc(name)}">${l}</button>`).join('')}</span></div>`;
  const add = (id, label, ph) => `<form class="cmd-row" data-add="${id}"><input placeholder="${ph}" maxlength="16" pattern="[A-Za-z0-9_]{1,16}" required><button class="btn">${label}</button></form>`;
  el.innerHTML = `<div class="settings-grid">
    <div class="card"><h3>En ligne <span class="muted small">${p.online}${p.max ? ' / ' + p.max : ''}</span></h3>
      ${p.names.map((n) => row(n, [['op', 'Op'], ['kick', 'Expulser', 1], ['ban', 'Bannir', 1]])).join('') || '<p class="muted">Personne pour l\'instant.</p>'}</div>
    <div class="card"><h3>Whitelist <span class="muted small">${s.whitelist ? 'activée' : 'désactivée'}</span></h3>
      <button class="btn sm" data-act="${s.whitelist ? 'whitelist-off' : 'whitelist-on'}">${s.whitelist ? 'Désactiver' : 'Activer'} la whitelist</button>
      <div style="margin-top:10px">${p.whitelist.map((n) => row(n, [['whitelist-remove', 'Retirer', 1]])).join('') || '<p class="muted">Liste vide.</p>'}</div>
      ${add('whitelist-add', 'Ajouter', 'Pseudo à autoriser')}</div>
    <div class="card"><h3>Opérateurs</h3>
      ${p.ops.map((n) => row(n, [['deop', 'Retirer', 1]])).join('') || '<p class="muted">Aucun opérateur.</p>'}
      ${add('op', 'Ajouter', 'Pseudo à promouvoir')}</div>
    <div class="card"><h3>Bannis</h3>
      ${p.banned.map((n) => row(n, [['pardon', 'Débannir']])).join('') || '<p class="muted">Aucun joueur banni.</p>'}
      ${add('ban', 'Bannir', 'Pseudo à bannir')}</div></div>`;
  const act = async (action, name) => {
    try {
      const { output } = await api('POST', mcApi(s.slug, '/players'), { action, name });
      toast(output || 'C\'est fait');
      if (action.startsWith('whitelist-o')) await mcFetch();
      mcDetail();
    } catch (e) { toast(e.message, true); }
  };
  $$('[data-act]', el).forEach((b) => (b.onclick = () => act(b.dataset.act, b.dataset.name)));
  $$('[data-add]', el).forEach((f) => (f.onsubmit = (e) => { e.preventDefault(); act(f.dataset.add, $('input', f).value.trim()); }));
}

async function mcAddons(s, el) {
  const folder = s.kind === 'mods' ? 'mods' : 'plugins';
  const label = s.kind === 'mods' ? 'mods' : 'plugins';
  el.innerHTML = `<div class="settings-grid">
    <div class="card"><h3>Depuis Modrinth</h3>
      <p class="muted small" style="margin-top:0">Téléchargés automatiquement (avec leurs dépendances) à chaque démarrage, dans la bonne version.</p>
      <div class="chips" id="mrChips">${s.modrinth.map((p) => `<span class="chip">${esc(p)} <a data-rm="${esc(p)}" title="Retirer">×</a></span>`).join('') || '<span class="muted">Aucun pour l\'instant.</span>'}</div>
      <form class="cmd-row" id="mrSearch"><input placeholder="Chercher des ${label} (ex : ${s.kind === 'mods' ? 'sodium, lithium' : 'luckperms, worldedit'})"><button class="btn">Chercher</button></form>
      <div id="mrResults"></div></div>
    <div class="card"><h3>Fichiers .jar <span class="muted small">/${folder}</span></h3>
      <p class="muted small" style="margin-top:0">Envoyez vos propres .jar. Redémarrez le serveur pour les charger.</p>
      <button class="btn sm" id="jarUp">${svg('upload')}Envoyer des .jar</button><input type="file" id="jarFile" accept=".jar" multiple class="hidden">
      <div id="jarList" style="margin-top:10px"><span class="muted">Chargement…</span></div></div></div>`;
  const setProjects = async (list) => {
    try {
      const { job } = await api('PUT', mcApi(s.slug, '/modrinth'), { projects: list });
      if (job) followJob(job, async () => { await mcFetch(); if (state.view === 'minecraft') mcDetail(); });
      else { await mcFetch(); mcDetail(); }
    } catch (e) { toast(e.message, true); }
  };
  $$('[data-rm]', el).forEach((a) => (a.onclick = () => setProjects(s.modrinth.filter((p) => p !== a.dataset.rm))));
  $('#mrSearch').onsubmit = async (e) => {
    e.preventDefault();
    const res = $('#mrResults');
    res.innerHTML = '<p class="muted">Recherche…</p>';
    try {
      const hits = await api('GET', mcApi(s.slug, `/modrinth/search?q=${encodeURIComponent($('input', e.target).value)}`));
      res.innerHTML = hits.map((h) => `<div class="list-row"><span style="display:flex;gap:10px;align-items:center;min-width:0">
          ${h.icon ? `<img src="${esc(h.icon)}" alt="" class="avatar" style="width:32px;height:32px;border-radius:6px">` : ''}
          <span style="min-width:0"><b>${esc(h.title)}</b> <span class="muted small">${esc(h.slug)} · ${Number(h.downloads).toLocaleString('fr-FR')} téléchargements</span>
          <br><span class="muted small">${esc(h.description)}</span></span></span>
        ${s.modrinth.includes(h.slug) ? '<button class="btn sm" disabled>Ajouté</button>' : `<button class="btn sm" data-addp="${esc(h.slug)}">Ajouter</button>`}</div>`).join('')
        || '<p class="muted">Aucun résultat compatible.</p>';
      $$('[data-addp]', res).forEach((b) => (b.onclick = () => setProjects([...s.modrinth, b.dataset.addp])));
    } catch (err) { res.innerHTML = `<p class="err">${esc(err.message)}</p>`; }
  };
  const listJars = async () => {
    const box = $('#jarList');
    try {
      const files = (await api('GET', mcApi(s.slug, `/files?path=${encodeURIComponent(folder)}`))).filter((f) => !f.dir && /\.jar$/i.test(f.name));
      box.innerHTML = files.map((f) => `<div class="list-row"><span>${esc(f.name)} <span class="muted small">${fmtBytes(f.size)}</span></span>
        <button class="btn sm danger" data-del="${esc(f.name)}">Supprimer</button></div>`).join('') || '<p class="muted">Aucun fichier .jar.</p>';
      $$('[data-del]', box).forEach((b) => (b.onclick = async () => {
        try { await api('DELETE', mcApi(s.slug, `/file?path=${encodeURIComponent(`${folder}/${b.dataset.del}`)}`)); listJars(); } catch (e) { toast(e.message, true); }
      }));
    } catch (e) { box.innerHTML = `<p class="muted">${/No such file/.test(e.message) ? 'Dossier vide.' : esc(e.message)}</p>`; }
  };
  $('#jarUp').onclick = () => $('#jarFile').click();
  $('#jarFile').onchange = async (e) => {
    for (const f of e.target.files) {
      try { await api('PUT', mcApi(s.slug, `/file?path=${encodeURIComponent(`${folder}/${f.name}`)}`), null, f); } catch (err) { toast(err.message, true); }
    }
    e.target.value = '';
    toast('Fichiers envoyés : redémarrez le serveur pour les charger');
    listJars();
  };
  listJars();
}

async function mcFiles(s, el) {
  const items = await api('GET', mcApi(s.slug, `/files?path=${encodeURIComponent(mc.path)}`));
  const parts = mc.path.split('/').filter(Boolean);
  const crumbs = [['', 'data'], ...parts.map((p, i) => [parts.slice(0, i + 1).join('/'), p])];
  const full = (name) => (mc.path ? `${mc.path}/${name}` : name);
  el.innerHTML = `<div class="toolbar">
      <div class="crumbs">${crumbs.map(([p, n], i) => `<a data-go="${esc(p)}">${esc(n)}</a>${i < crumbs.length - 1 ? ' / ' : ''}`).join('')}</div>
      <div class="row-actions" style="margin-left:auto">
        <button class="btn sm" id="fNewFile">Nouveau fichier</button><button class="btn sm" id="fNewDir">Nouveau dossier</button>
        <button class="btn sm" id="fUp">${svg('upload')}Envoyer</button><input type="file" id="fUpFile" multiple class="hidden">
        <a class="btn sm" href="${mcApi(s.slug, '/backup')}">Sauvegarde du monde</a></div></div>
    <div class="card file-table">${mc.path ? '<div class="file-row" data-up><span class="fname">..</span><span></span><span></span><span></span></div>' : ''}
      ${items.map((f) => `<div class="file-row" data-name="${esc(f.name)}" data-dir="${f.dir ? 1 : 0}">
        <span class="fname">${svg(f.dir ? 'folder' : 'file')}${esc(f.name)}</span>
        <span class="muted small">${f.dir ? '' : fmtBytes(f.size)}</span>
        <span class="muted small">${new Date(f.mtime).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}</span>
        <span class="row-actions">${f.dir ? '' : `<a class="btn sm" href="${mcApi(s.slug, `/file?download=1&path=${encodeURIComponent(full(f.name))}`)}">Télécharger</a>`}
          <button class="btn sm" data-ren>Renommer</button><button class="btn sm danger" data-del>Supprimer</button></span></div>`).join('')
      || '<div class="empty">Dossier vide.</div>'}</div>
    <p class="muted small">Les réglages faits dans HouseApp (MOTD, mode de jeu…) remplacent ceux de server.properties à chaque démarrage.</p>`;
  const go2 = (p) => { mc.path = p; mcDetail(); };
  $$('[data-go]', el).forEach((a) => (a.onclick = () => go2(a.dataset.go)));
  const up = $('[data-up]', el);
  if (up) up.onclick = () => go2(parts.slice(0, -1).join('/'));
  $$('.file-row[data-name]', el).forEach((row) => {
    const name = row.dataset.name;
    $('.fname', row).onclick = () => (row.dataset.dir === '1' ? go2(full(name)) : mcEdit(s, full(name), items.find((f) => f.name === name)));
    $('[data-del]', row).onclick = () => {
      openModal(`<h3>Supprimer « ${esc(name)} » ?</h3><p class="muted">Cette action est définitive.</p>
        <div class="modal-actions"><button class="btn" onclick="closeModal()">Annuler</button><button class="btn danger" id="fDel">Supprimer</button></div>`);
      $('#fDel').onclick = async () => {
        try { await api('DELETE', mcApi(s.slug, `/file?path=${encodeURIComponent(full(name))}`)); closeModal(); mcDetail(); } catch (e) { toast(e.message, true); }
      };
    };
    $('[data-ren]', row).onclick = () => mcAsk('Renommer', name, async (v) => {
      await api('POST', mcApi(s.slug, '/rename'), { from: full(name), to: full(v) });
    });
  });
  $('#fNewDir').onclick = () => mcAsk('Nouveau dossier', '', (v) => api('POST', mcApi(s.slug, '/mkdir'), { path: full(v) }));
  $('#fNewFile').onclick = () => mcAsk('Nouveau fichier', 'nouveau.txt', (v) => api('PUT', mcApi(s.slug, `/file?path=${encodeURIComponent(full(v))}`), null, new Blob([''])));
  $('#fUp').onclick = () => $('#fUpFile').click();
  $('#fUpFile').onchange = async (e) => {
    for (const f of e.target.files) {
      try { await api('PUT', mcApi(s.slug, `/file?path=${encodeURIComponent(full(f.name))}`), null, f); } catch (err) { toast(err.message, true); }
    }
    e.target.value = '';
    mcDetail();
  };
}

function mcAsk(title, value, run) {
  openModal(`<h3>${esc(title)}</h3><form id="askForm"><input name="v" value="${esc(value)}" required maxlength="200">
    <div class="modal-actions"><button type="button" class="btn" onclick="closeModal()">Annuler</button><button class="btn primary">Valider</button></div></form>`);
  const input = $('#askForm input');
  input.focus();
  input.select();
  $('#askForm').onsubmit = async (e) => {
    e.preventDefault();
    const v = input.value.trim();
    if (!v || /[\\/]/.test(v)) return toast('Nom invalide', true);
    try { await run(v); closeModal(); mcDetail(); } catch (err) { toast(err.message, true); }
  };
}

async function mcEdit(s, path, info) {
  if (!MC_TEXT.test(path) || (info && info.size > 2 * 1024 * 1024)) {
    window.location.href = mcApi(s.slug, `/file?download=1&path=${encodeURIComponent(path)}`);
    return;
  }
  const res = await fetch(mcApi(s.slug, `/file?path=${encodeURIComponent(path)}`));
  if (!res.ok) return toast((await res.json().catch(() => ({}))).error || 'Lecture impossible', true);
  const text = await res.text();
  openModal(`<h3>${esc(path)}</h3><textarea id="edText" class="editor" spellcheck="false"></textarea>
    <div class="modal-actions"><button class="btn" onclick="closeModal()">Fermer</button><button class="btn primary" id="edSave">Enregistrer</button></div>`);
  $('#modal .modal-card').classList.add('wide');
  $('#edText').value = text;
  $('#edSave').onclick = async () => {
    try {
      await api('PUT', mcApi(s.slug, `/file?path=${encodeURIComponent(path)}`), null, new Blob([$('#edText').value]));
      toast('Enregistré. Redémarrez le serveur si nécessaire.');
    } catch (e) { toast(e.message, true); }
  };
}

async function mcPublic(s, el) {
  el.innerHTML = '<div class="card empty">Analyse de votre connexion…</div>';
  const p = await api('GET', mcApi(s.slug, '/public'));
  const r = p.router;
  let upnpText;
  if (!r) upnpText = `<p class="muted">${esc(p.routerError || 'Routeur introuvable')}</p>`;
  else if (r.nat === 'direct') upnpText = `<p>Routeur <b>${esc(r.router)}</b>, IP publique <b>${esc(r.externalIp)}</b>.</p>
    <p class="muted small">HouseApp peut ouvrir le port ${p.port} sur votre box : vos amis se connecteront à <b>${esc(r.externalIp)}:${p.port}</b>.</p>`;
  else if (r.nat === 'double') upnpText = `<p>Routeur <b>${esc(r.router)}</b>, mais son IP « externe » est <b>${esc(r.externalIp)}</b> : il est lui-même branché derrière une autre box (double NAT).</p>
    <p class="muted small">Ouvrir le port ici ne suffit pas : il faudrait aussi le rediriger sur la box principale vers ${esc(r.externalIp)}, ou utiliser playit.gg (recommandé).</p>`;
  else upnpText = `<p>Votre opérateur partage votre IP publique (CGNAT, IP ${esc(r.externalIp || '?')}) : aucune redirection de port ne peut marcher. Utilisez playit.gg.</p>`;
  const defaultTest = s.publicAddress || (r && r.nat === 'direct' ? `${r.externalIp}:${p.port}` : '');
  el.innerHTML = `<div class="settings-grid">
    <div class="card"><h3>playit.gg <span class="tag accent">recommandé</span></h3>
      <p class="muted small" style="margin-top:0">Un tunnel gratuit qui donne une adresse publique (ex : <code>exemple.joinmc.link</code>), même derrière une box, un double NAT ou un CGNAT. Aucun port à ouvrir.</p>
      <ol class="steps">
        <li>Créez un compte gratuit sur <a href="https://playit.gg" target="_blank" rel="noopener">playit.gg</a>.</li>
        <li>Dans le tableau de bord : <b>Add Agent</b> → <b>Docker</b>, puis copiez la clé secrète (<code>SECRET_KEY</code>).</li>
        <li>Collez-la ci-dessous et enregistrez : HouseApp lance l'agent à côté du serveur.</li>
        <li>Sur playit.gg : <b>Add Tunnel</b> → <b>Minecraft Java</b>, adresse locale <code>127.0.0.1</code>, port <code>25565</code>.</li>
        <li>Recopiez ici l'adresse publique affichée par playit.gg pour la partager.</li>
      </ol>
      ${p.playit ? (p.playitError ? `<p class="err">Le tunnel ne démarre pas : ${esc(p.playitError)}</p>`
        : p.playitState === 'running' ? '<p class="ok-text">Agent playit.gg actif.</p>' : '') : ''}
      <form id="playitForm">
        <label>Clé secrète ${p.playit ? '(configurée — vide pour la garder)' : ''}</label><input name="key" type="password" autocomplete="off">
        <label>Adresse publique</label><input name="address" value="${esc(s.publicAddress)}" placeholder="exemple.joinmc.link">
        <div class="modal-actions" style="justify-content:flex-start">
          <button class="btn primary">Enregistrer</button>${p.playit ? '<button type="button" class="btn danger" id="playitOff">Désactiver le tunnel</button>' : ''}</div>
      </form></div>
    <div class="card"><h3>Ouvrir le port sur la box (UPnP)</h3>${upnpText}
      ${r ? (p.upnp ? `<p class="ok-text">Port ${p.port} ouvert par HouseApp.</p><button class="btn danger" id="upnpOff">Fermer le port</button>`
        : `<button class="btn" id="upnpOn" ${r.nat === 'cgnat' ? 'disabled' : ''}>Ouvrir le port ${p.port}</button>`) : ''}
      <p class="muted small">Le serveur est toujours joignable en local sur <b>${esc(location.hostname)}:${p.port}</b>.</p></div>
    <div class="card"><h3>Tester depuis Internet</h3>
      <p class="muted small" style="margin-top:0">Le test passe par le service public mcsrvstat.us, qui essaie de joindre votre serveur depuis l'extérieur.</p>
      <form class="cmd-row" id="testForm"><input name="address" value="${esc(defaultTest)}" placeholder="adresse:port" required><button class="btn">Tester</button></form>
      <div id="testOut"></div></div></div>`;
  $('#playitForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = { address: f.get('address') };
    if (f.get('key')) body.key = f.get('key');
    try { await api('PUT', mcApi(s.slug, '/public/playit'), body); toast('Enregistré'); await mcFetch(); mcDetail(); } catch (err) { toast(err.message, true); }
  };
  if ($('#playitOff')) $('#playitOff').onclick = async () => {
    try { await api('PUT', mcApi(s.slug, '/public/playit'), { key: '' }); await mcFetch(); mcDetail(); } catch (e) { toast(e.message, true); }
  };
  if ($('#upnpOn')) $('#upnpOn').onclick = async () => {
    $('#upnpOn').disabled = true;
    try { const o = await api('POST', mcApi(s.slug, '/public/upnp')); toast(`Port ${o.port} ouvert sur ${o.router}`); mcDetail(); } catch (e) { toast(e.message, true); $('#upnpOn').disabled = false; }
  };
  if ($('#upnpOff')) $('#upnpOff').onclick = async () => {
    try { await api('DELETE', mcApi(s.slug, '/public/upnp')); toast('Port fermé'); mcDetail(); } catch (e) { toast(e.message, true); }
  };
  $('#testForm').onsubmit = async (e) => {
    e.preventDefault();
    const out = $('#testOut');
    out.innerHTML = '<p class="muted">Test en cours…</p>';
    try {
      const t = await api('POST', mcApi(s.slug, '/public/test'), { address: new FormData(e.target).get('address') });
      out.innerHTML = t.online ? `<p class="ok-text">Joignable depuis Internet : ${esc(t.version || '')} · ${esc(t.players || '')} joueurs</p>`
        : '<p class="err">Injoignable depuis Internet pour l\'instant.</p>';
    } catch (err) { out.innerHTML = `<p class="err">${esc(err.message)}</p>`; }
  };
}

function mcSettings(s, el) {
  el.innerHTML = `<div class="settings-grid"><div class="card">${mcFormHtml(s)}</div>
    <div class="card"><h3>Sauvegarde</h3><p class="muted small" style="margin-top:0">Télécharge le monde (overworld, nether, end) et les réglages en .tar.gz.</p>
      <a class="btn" href="${mcApi(s.slug, '/backup')}">Télécharger une sauvegarde</a>
      <h3 style="margin-top:22px">Zone dangereuse</h3><button class="btn danger" id="mcDelete">Supprimer ce serveur</button></div></div>`;
  $('.modal-actions [onclick]', el)?.remove();
  $('#mcForm', el).onsubmit = async (e) => {
    e.preventDefault();
    try {
      const { job } = await api('PUT', mcApi(s.slug), mcFormBody(e.target));
      if (job) followJob(job, async () => { await mcFetch(); if (state.view === 'minecraft') mcDetail(); });
      else { toast('Enregistré'); await mcFetch(); mcDetail(); }
    } catch (err) { toast(err.message, true); }
  };
  $('#mcDelete').onclick = () => {
    openModal(`<h3>Supprimer « ${esc(s.name)} » ?</h3>
      <label class="check" style="margin-top:12px"><input type="checkbox" id="rmWorld"> Supprimer aussi le monde et tous ses fichiers (irréversible)</label>
      <div class="modal-actions"><button class="btn" onclick="closeModal()">Annuler</button><button class="btn danger" id="mcRm">Supprimer</button></div>`);
    $('#mcRm').onclick = async () => {
      $('#mcRm').disabled = true;
      try { await api('DELETE', `${mcApi(s.slug)}?world=${$('#rmWorld').checked ? 1 : 0}`); closeModal(); toast('Serveur supprimé'); mc.slug = null; loadMinecraft(); }
      catch (e) { toast(e.message, true); $('#mcRm').disabled = false; }
    };
  };
}
