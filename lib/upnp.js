const dgram = require('dgram');
const net = require('net');
const network = require('./network');

const TARGETS = [
  'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
  'urn:schemas-upnp-org:device:InternetGatewayDevice:2',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANIPConnection:2',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
];
let cached = null;
let cachedAt = 0;

function searchFrom(localIp, timeout) {
  return new Promise((resolve) => {
    const found = new Set();
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    s.on('message', (m) => {
      const loc = /^location:\s*(\S+)/im.exec(m.toString());
      if (loc) found.add(loc[1]);
    });
    s.on('error', () => {});
    s.bind(0, localIp, () => {
      try { s.setMulticastInterface(localIp); } catch {}
      for (const st of TARGETS) {
        const msg = `M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`;
        s.send(Buffer.from(msg), 1900, '239.255.255.250', () => {});
      }
    });
    setTimeout(() => { try { s.close(); } catch {} resolve([...found]); }, timeout);
  });
}

async function describe(location) {
  const res = await fetch(location, { signal: AbortSignal.timeout(4000) });
  const xml = await res.text();
  const base = (/<URLBase>\s*([^<\s]+)\s*<\/URLBase>/i.exec(xml) || [])[1] || location;
  const name = (/<friendlyName>([^<]*)<\/friendlyName>/i.exec(xml) || [])[1] || 'Routeur';
  for (const block of xml.match(/<service>[\s\S]*?<\/service>/gi) || []) {
    const type = (/<serviceType>\s*([^<\s]+)\s*<\/serviceType>/i.exec(block) || [])[1] || '';
    const control = (/<controlURL>\s*([^<\s]+)\s*<\/controlURL>/i.exec(block) || [])[1];
    if (control && /WAN(IP|PPP)Connection/.test(type)) return { type, control: new URL(control, base).href, name };
  }
  return null;
}

async function gateway() {
  if (cached && Date.now() - cachedAt < 600000) return cached;
  const ips = network.addresses().lan;
  const locations = new Set();
  for (const list of await Promise.all(ips.map((ip) => searchFrom(ip, 2500)))) list.forEach((l) => locations.add(l));
  for (const loc of locations) {
    try {
      const svc = await describe(loc);
      if (svc) {
        cached = svc;
        cachedAt = Date.now();
        return svc;
      }
    } catch {}
  }
  throw new Error('Aucun routeur UPnP trouvé. Activez UPnP sur votre box, ou ouvrez le port à la main.');
}

const xmlEscape = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

async function soap(svc, action, args = {}) {
  const inner = Object.entries(args).map(([k, v]) => `<${k}>${xmlEscape(v)}</${k}>`).join('');
  const body = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${svc.type}">${inner}</u:${action}></s:Body></s:Envelope>`;
  const res = await fetch(svc.control, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${svc.type}#${action}"` },
    body,
    signal: AbortSignal.timeout(6000),
  });
  const text = await res.text();
  if (!res.ok) {
    const code = (/<errorCode>(\d+)<\/errorCode>/.exec(text) || [])[1];
    const desc = (/<errorDescription>([^<]*)<\/errorDescription>/.exec(text) || [])[1];
    const err = new Error(`Le routeur a refusé : ${desc || 'erreur'}${code ? ` (${code})` : ''}`);
    err.code = Number(code) || res.status;
    throw err;
  }
  return text;
}

function localAddressFor(url) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: u.hostname, port: Number(u.port) || 80, timeout: 4000 }, () => {
      const ip = s.localAddress.replace(/^::ffff:/, '');
      s.end();
      resolve(ip);
    });
    s.on('error', reject);
    s.on('timeout', () => { s.destroy(); reject(new Error('Routeur injoignable')); });
  });
}

const isPrivate = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|127\.|0\.)/.test(ip);

async function externalIp() {
  const svc = await gateway();
  const text = await soap(svc, 'GetExternalIPAddress');
  return (/<NewExternalIPAddress>([^<]*)<\/NewExternalIPAddress>/.exec(text) || [])[1] || null;
}

async function publicIpFromInternet() {
  const res = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(6000) });
  return (await res.json()).ip;
}

async function open(port, description) {
  const svc = await gateway();
  const client = await localAddressFor(svc.control);
  const args = {
    NewRemoteHost: '', NewExternalPort: port, NewProtocol: 'TCP', NewInternalPort: port,
    NewInternalClient: client, NewEnabled: 1, NewPortMappingDescription: description, NewLeaseDuration: 0,
  };
  try {
    await soap(svc, 'AddPortMapping', args);
  } catch (e) {
    if (e.code !== 725 && e.code !== 402 && e.code !== 501) throw e;
    await soap(svc, 'AddPortMapping', { ...args, NewLeaseDuration: 604800 });
  }
  return { router: svc.name, internalClient: client };
}

async function close(port) {
  const svc = await gateway();
  await soap(svc, 'DeletePortMapping', { NewRemoteHost: '', NewExternalPort: port, NewProtocol: 'TCP' }).catch((e) => {
    if (e.code !== 714) throw e;
  });
}

function natKind(ip) {
  if (!ip) return 'unknown';
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return 'cgnat';
  return isPrivate(ip) ? 'double' : 'direct';
}

async function status() {
  const svc = await gateway();
  const ip = await externalIp();
  return { router: svc.name, externalIp: ip, nat: natKind(ip) };
}

module.exports = { status, open, close, externalIp, publicIpFromInternet, isPrivate };
