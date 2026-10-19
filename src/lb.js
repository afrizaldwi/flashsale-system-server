// Load balancer sederhana (tanpa dependensi): round-robin ke beberapa instance backend,
// health check aktif, dan retry otomatis ke backend lain jika satu backend mati.
// Retry POST /checkout aman karena setiap request membawa Idempotency-Key.
require('dotenv').config();
const http = require('http');

const PORT = parseInt(process.env.LB_PORT || '3000', 10);
const backends = (process.env.BACKENDS || 'localhost:3001,localhost:3002')
  .split(',').map((s) => s.trim()).filter(Boolean)
  .map((s) => { const [host, port] = s.split(':'); return { host, port: parseInt(port, 10), healthy: true, served: 0 }; });

const agent = new http.Agent({ keepAlive: true, maxSockets: 200 });
let rr = 0;

// Health check aktif: backend dianggap hidup jika proses menjawab HTTP apa pun (200 maupun 503).
// Status 503 berarti DATABASE bermasalah, bukan prosesnya, jadi backend tetap dipakai.
function check(b) {
  const req = http.get({ host: b.host, port: b.port, path: '/health', timeout: 1500, agent: false }, (res) => {
    res.resume();
    if (!b.healthy) console.log(`[lb] ${b.host}:${b.port} kembali sehat`);
    b.healthy = true;
  });
  const down = () => { if (b.healthy) console.log(`[lb] ${b.host}:${b.port} DITANDAI MATI`); b.healthy = false; };
  req.on('timeout', () => { req.destroy(); down(); });
  req.on('error', down);
}
setInterval(() => backends.forEach(check), 1000);
backends.forEach(check);

function pick(tried) {
  for (let i = 0; i < backends.length; i++) {
    const b = backends[(rr + i) % backends.length];
    if (b.healthy && !tried.has(b)) { rr = (rr + i + 1) % backends.length; return b; }
  }
  return null;
}

function forward(req, res, body, tried) {
  const b = pick(tried);
  if (!b) {
    return res.writeHead(503, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ error: 'NO_BACKEND', message: 'Tidak ada backend yang tersedia.' }));
  }
  tried.add(b);
  const headers = { ...req.headers, 'x-forwarded-for': req.socket.remoteAddress, 'content-length': Buffer.byteLength(body) };
  const preq = http.request({ host: b.host, port: b.port, path: req.url, method: req.method, headers, agent }, (pres) => {
    b.served++;
    res.writeHead(pres.statusCode, pres.headers);
    pres.pipe(res);
  });
  preq.on('error', (err) => {
    if (res.headersSent) return res.destroy();
    b.healthy = false;                      // backend tidak menjawab: keluarkan dari rotasi
    console.error(`[lb] ${b.host}:${b.port} gagal (${err.code}), coba backend lain`);
    forward(req, res, body, tried);         // retry ke backend lain (aman: Idempotency-Key)
  });
  preq.end(body);
}

http.createServer((req, res) => {
  if (req.url === '/lb/status') {
    return res.writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ backends: backends.map(({ host, port, healthy, served }) => ({ host, port, healthy, served })) }, null, 2));
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => forward(req, res, Buffer.concat(chunks), new Set()));
}).listen(PORT, () => console.log(`Load balancer di http://localhost:${PORT} -> ${backends.map((b) => b.host + ':' + b.port).join(', ')}`));

process.on('uncaughtException', (e) => console.error('[lb uncaught]', e));
