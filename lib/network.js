const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');

const isTailscaleIp = (ip) => {
  const [a, b] = ip.split('.').map(Number);
  return a === 100 && b >= 64 && b <= 127;
};

function addresses() {
  const lan = [];
  const tailscale = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family !== 'IPv4' || i.internal || i.address.startsWith('169.254.')) continue;
      if (isTailscaleIp(i.address)) tailscale.push(i.address);
      else if (!/vEthernet|VMware|VirtualBox|Hyper-V|WSL|docker|br-|veth/i.test(name)) lan.push(i.address);
    }
  }
  return { lan, tailscale };
}

function tailscaleExe() {
  const win = 'C:\\Program Files\\Tailscale\\tailscale.exe';
  return process.platform === 'win32' && fs.existsSync(win) ? win : 'tailscale';
}

function magicDns() {
  return new Promise((resolve) => {
    execFile(tailscaleExe(), ['status', '--self', '--json'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const s = JSON.parse(stdout);
        resolve(s.CurrentTailnet?.MagicDNSEnabled && s.Self?.DNSName ? s.Self.DNSName.replace(/\.$/, '') : null);
      } catch { resolve(null); }
    });
  });
}

function resolveHosts(hostSetting) {
  const out = [];
  for (const h of String(hostSetting).split(',').map((s) => s.trim()).filter(Boolean)) {
    if (h === 'tailscale') {
      out.push(...addresses().tailscale);
    } else out.push(h);
  }
  return [...new Set(out)];
}

module.exports = { addresses, magicDns, resolveHosts };
