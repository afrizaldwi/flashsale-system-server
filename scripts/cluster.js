// Menjalankan 2 backend + load balancer sekaligus (satu perintah: npm run start:cluster).
// Untuk mematikan satu server saat demo: kill <PID> yang ditampilkan, lalu amati sistem tetap jalan.
const { spawn } = require('child_process');
const path = require('path');
const root = path.join(__dirname, '..');
const procs = [
  { name: 'backend-1', file: 'src/server.js', env: { PORT: '3001', INSTANCE_ID: 'backend-1' } },
  { name: 'backend-2', file: 'src/server.js', env: { PORT: '3002', INSTANCE_ID: 'backend-2' } },
  { name: 'lb',        file: 'src/lb.js',     env: { LB_PORT: process.env.LB_PORT || '3000', BACKENDS: 'localhost:3001,localhost:3002' } },
].map((p) => {
  const c = spawn(process.execPath, [p.file], { cwd: root, env: { ...process.env, ...p.env } });
  const tag = (d) => d.toString().split('\n').filter(Boolean).forEach((l) => console.log(`[${p.name}] ${l}`));
  c.stdout.on('data', tag); c.stderr.on('data', tag);
  c.on('exit', (code, sig) => console.log(`[${p.name}] berhenti (code=${code} signal=${sig})`));
  console.log(`[${p.name}] PID ${c.pid}`);
  return c;
});
const stop = () => { procs.forEach((c) => c.kill()); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
