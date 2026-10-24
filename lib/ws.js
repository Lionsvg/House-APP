// WebSocket minimal (RFC 6455), cote serveur : juste ce qu'il faut pour le terminal.
// Trames binaires = donnees du terminal, trames texte = messages de controle en JSON.
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 1024 * 1024;

function frame(opcode, payload) {
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x80 | opcode, len])
    : len < 65536 ? Buffer.from([0x80 | opcode, 126, len >> 8, len & 255])
      : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(len)); return b; })()]);
  return Buffer.concat([head, payload]);
}

/** Accepte la connexion (requete 'upgrade' de http.Server) ; renvoie un objet : send(), close(), events message/close. */
function accept(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade).toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return null;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);

  const ws = new EventEmitter();
  let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
  let parts = [];
  let partOp = 0;
  let closed = false;

  ws.send = (data) => {
    if (closed || socket.destroyed) return;
    socket.write(typeof data === 'string' ? frame(1, Buffer.from(data)) : frame(2, data));
  };
  ws.close = () => {
    if (closed) return;
    closed = true;
    if (!socket.destroyed) socket.end(frame(8, Buffer.alloc(0)));
    ws.emit('close');
  };

  function parse() {
    while (buf.length >= 2) {
      const fin = buf[0] & 0x80;
      const op = buf[0] & 0x0f;
      const masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (!masked || len > MAX_MESSAGE) return ws.close(); // un client doit masquer ses trames
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4);
      const data = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      buf = buf.subarray(off + 4 + len);

      if (op === 8) return ws.close();
      if (op === 9) { if (!socket.destroyed) socket.write(frame(10, data)); continue; }
      if (op === 10) continue;
      if (op !== 0) { partOp = op; parts = []; }
      parts.push(data);
      if (parts.reduce((n, p) => n + p.length, 0) > MAX_MESSAGE) return ws.close();
      if (fin) {
        const msg = Buffer.concat(parts);
        parts = [];
        ws.emit('message', partOp === 1 ? msg.toString('utf8') : msg);
      }
    }
  }

  socket.on('data', (d) => { buf = Buffer.concat([buf, d]); parse(); });
  // Le serveur HTTP accepte les connexions "a moitie ouvertes" : quand le navigateur coupe sans trame de
  // fermeture (page rechargee, telephone en veille), on ne recoit que 'end'. On ferme alors nous aussi.
  socket.on('end', () => ws.close());
  socket.on('close', () => { if (!closed) { closed = true; ws.emit('close'); } });
  socket.on('error', () => socket.destroy());
  const ping = setInterval(() => { if (!socket.destroyed) socket.write(frame(9, Buffer.alloc(0))); }, 25000);
  ws.on('close', () => clearInterval(ping));
  if (buf.length) setImmediate(parse);
  return ws;
}

module.exports = { accept };
