const TOGGLE = {
  light: 'toggle', switch: 'toggle', fan: 'toggle', input_boolean: 'toggle', automation: 'toggle',
  cover: 'toggle', media_player: 'toggle', climate: 'toggle', siren: 'toggle', humidifier: 'toggle',
  script: 'turn_on', scene: 'turn_on', button: 'press', input_button: 'press', lock: null,
};

async function call(cfg, method, pathname, body) {
  if (!cfg || !cfg.url || !cfg.token) throw new Error('Home Assistant n\'est pas configuré');
  const url = cfg.url.replace(/\/+$/, '') + pathname;
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  }).catch(() => { throw new Error(`Impossible de joindre Home Assistant à ${cfg.url} (est-il démarré ?)`); });
  if (res.status === 401) throw new Error('Jeton Home Assistant refusé (401)');
  if (!res.ok) throw new Error(`Home Assistant a répondu ${res.status}`);
  return res.json();
}

async function states(cfg) {
  const all = await call(cfg, 'GET', '/api/states');
  return all
    .filter((s) => !s.entity_id.startsWith('update.') && !s.attributes?.hidden)
    .map((s) => {
      const domain = s.entity_id.split('.')[0];
      let action = TOGGLE[domain];
      if (domain === 'lock') action = s.state === 'locked' ? 'unlock' : 'lock';
      return {
        id: s.entity_id, domain, state: s.state, action: action || null,
        name: s.attributes?.friendly_name || s.entity_id,
        unit: s.attributes?.unit_of_measurement || '',
      };
    });
}

async function toggle(cfg, entityId) {
  if (!/^[a-z_]+\.[a-z0-9_]+$/.test(entityId)) throw new Error('Entité invalide');
  const domain = entityId.split('.')[0];
  let service = TOGGLE[domain];
  if (domain === 'lock') {
    const s = await call(cfg, 'GET', `/api/states/${entityId}`);
    service = s.state === 'locked' ? 'unlock' : 'lock';
  }
  if (!service) throw new Error('Cette entité ne se pilote pas');
  await call(cfg, 'POST', `/api/services/${domain}/${service}`, { entity_id: entityId });
}

async function test(cfg) {
  const r = await call(cfg, 'GET', '/api/');
  return r.message || 'OK';
}

module.exports = { states, toggle, test };
