const si = require('systeminformation');
const os = require('os');
const { execFile } = require('child_process');

let staticInfo = null;

function nvidiaSmi() {
  return new Promise((resolve) => {
    execFile(
      'nvidia-smi',
      ['--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,fan.speed', '--format=csv,noheader,nounits'],
      { timeout: 5000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        const num = (v) => (isNaN(parseFloat(v)) ? null : parseFloat(v));
        resolve(
          stdout.trim().split('\n').filter(Boolean).map((l) => {
            const [name, util, used, total, temp, power, fan] = l.split(',').map((s) => s.trim());
            return { name, vendor: 'NVIDIA', load: num(util), memUsed: num(used), memTotal: num(total), temp: num(temp), power: num(power), fan: num(fan) };
          })
        );
      }
    );
  });
}

async function getStatic() {
  if (staticInfo) return staticInfo;
  const [cpu, osInfo, graphics] = await Promise.all([si.cpu(), si.osInfo(), si.graphics().catch(() => ({ controllers: [] }))]);
  staticInfo = {
    cpu: `${cpu.manufacturer} ${cpu.brand}`.trim(),
    cores: cpu.cores,
    physicalCores: cpu.physicalCores,
    os: `${osInfo.distro} ${osInfo.release}`.trim(),
    hostname: os.hostname(),
    arch: osInfo.arch,
    gpus: graphics.controllers.filter((g) => !/virtual|mobile monitor|parsec|basic display/i.test(g.model || ''))
      .map((g) => ({ name: g.model, vendor: g.vendor, vram: g.vram })),
  };
  return staticInfo;
}

async function collectFast() {
  const [load, mem, nv] = await Promise.all([si.currentLoad(), si.mem(), nvidiaSmi()]);

  let gpus = nv;
  if (!gpus || !gpus.length) {
    const g = await si.graphics().catch(() => ({ controllers: [] }));
    gpus = g.controllers.map((c) => ({
      name: c.model, vendor: c.vendor, load: c.utilizationGpu ?? null,
      memUsed: c.memoryUsed ?? null, memTotal: c.memoryTotal ?? c.vram ?? null, temp: c.temperatureGpu ?? null, power: null, fan: null,
    }));
  }

  return {
    cpu: { load: load.currentLoad, cores: load.cpus.map((c) => c.load) },
    mem: { total: mem.total, used: mem.active, swapTotal: mem.swaptotal, swapUsed: mem.swapused },
    gpus,
  };
}

const VIRTUAL = /vEthernet|Loopback|Npcap|Tailscale|VMware|VirtualBox|ZeroTier|WireGuard|Hyper-V|Bluetooth/i;
let prevNet = null;
function windowsNet() {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-NetAdapterStatistics | Select-Object Name,ReceivedBytes,SentBytes | ConvertTo-Json -Compress'],
    { timeout: 8000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const list = [].concat(JSON.parse(stdout) || []).filter((a) => !VIRTUAL.test(a.Name));
        const now = { t: Date.now(), rx: list.reduce((s, a) => s + a.ReceivedBytes, 0), tx: list.reduce((s, a) => s + a.SentBytes, 0) };
        const prev = prevNet;
        prevNet = now;
        if (!prev) return resolve({ rx: 0, tx: 0 });
        const dt = (now.t - prev.t) / 1000;
        resolve({ rx: Math.max(0, (now.rx - prev.rx) / dt), tx: Math.max(0, (now.tx - prev.tx) / dt) });
      } catch { resolve(null); }
    });
  });
}
async function netRate() {
  if (process.platform === 'win32') {
    const w = await windowsNet();
    if (w) return w;
  }
  const stats = await si.networkStats('*').catch(() => []);
  return {
    rx: stats.filter((n) => !VIRTUAL.test(n.iface)).reduce((a, n) => a + (n.rx_sec > 0 ? n.rx_sec : 0), 0),
    tx: stats.filter((n) => !VIRTUAL.test(n.iface)).reduce((a, n) => a + (n.tx_sec > 0 ? n.tx_sec : 0), 0),
  };
}

async function collectSlow() {
  const [temp, fs, net] = await Promise.all([
    si.cpuTemperature().catch(() => ({})),
    si.fsSize().catch(() => []),
    netRate(),
  ]);
  const seen = new Set();
  const disks = fs
    .filter((d) => d.size > 0 && !seen.has(d.mount) && seen.add(d.mount))
    .map((d) => ({ mount: d.mount, fs: d.type, size: d.size, used: d.used, use: d.use }));
  return { temp: temp.main || null, disks, net };
}

let fast = null;
let slow = { temp: null, disks: [], net: { rx: 0, tx: 0 } };
let lastRead = 0;
function loop(fn, every, onData) {
  const tick = async () => {
    if (Date.now() - lastRead < 60000) {
      try { onData(await fn()); } catch { }
    }
    setTimeout(tick, every).unref();
  };
  tick();
}
let started = false;
function startSampling() {
  if (started) return;
  started = true;
  lastRead = Date.now();
  loop(collectFast, 2000, (d) => (fast = d));
  loop(collectSlow, 5000, (d) => (slow = d));
}

async function getLive() {
  startSampling();
  lastRead = Date.now();
  if (!fast) fast = await collectFast();
  return {
    time: Date.now(),
    uptime: os.uptime(),
    cpu: { ...fast.cpu, temp: slow.temp },
    mem: fast.mem,
    gpus: fast.gpus,
    disks: slow.disks,
    net: slow.net,
  };
}

async function hasNvidia() {
  const nv = await nvidiaSmi();
  return !!(nv && nv.length);
}

module.exports = { getStatic, getLive, hasNvidia };
