const fs = require('fs');
const path = require('path');

let FILE;

function init(dataDir) {
  FILE = path.join(dataDir, 'config.json');
}

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; }
}

function save(c) {
  fs.writeFileSync(FILE, JSON.stringify(c, null, 2));
}

function update(fn) {
  const c = load();
  fn(c);
  save(c);
  return c;
}

const moduleEnabled = (id) => !!(load().modules || {})[id];

module.exports = { init, load, save, update, moduleEnabled };
