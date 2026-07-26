import net from 'node:net';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const stateFile = resolve(root, '.maxcine-dev.json');
const ports = [5173, 8787];

function state() { return existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : null; }
function canBind(port) { return new Promise((resolveCheck) => { const server = net.createServer(); server.once('error', () => resolveCheck(false)); server.listen(port, '127.0.0.1', () => server.close(() => resolveCheck(true))); }); }
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function clearState() { if (existsSync(stateFile)) unlinkSync(stateFile); }

async function start() {
  const existing = state();
  if (existing?.pids?.some(alive)) { console.error('MaxCINE 开发服务已启动。请先运行 npm run dev:status 或 npm run dev:stop。'); process.exitCode = 1; return; }
  clearState();
  const unavailable = []; for (const port of ports) if (!await canBind(port)) unavailable.push(port);
  if (unavailable.length) { console.error(`端口 ${unavailable.join('、')} 已被占用。请确认现有 MaxCINE 服务后运行 npm run dev:stop；脚本不会终止未由它启动的进程。`); process.exitCode = 1; return; }
  const web = spawn('npm', ['run', 'dev', '-w', '@maxcine/web'], { cwd: root, stdio: 'inherit' });
  const api = spawn('npm', ['run', 'dev', '-w', '@maxcine/api'], { cwd: root, stdio: 'inherit' });
  writeFileSync(stateFile, JSON.stringify({ pids: [web.pid, api.pid], startedAt: new Date().toISOString() }));
  console.log('MaxCINE 本地开发服务已启动：Web http://localhost:5173；API http://localhost:8787；D1 apps/api/.wrangler/state/v3/d1。');
  const stop = () => { for (const pid of [web.pid, api.pid]) { try { process.kill(pid, 'SIGTERM'); } catch { /* child already exited */ } } clearState(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}

function status() { const current = state(); if (!current) return console.log('未发现由 MaxCINE 开发脚本启动的服务。'); console.log(`记录时间：${current.startedAt}`); for (const pid of current.pids) console.log(`PID ${pid}：${alive(pid) ? '运行中' : '已退出'}`); }
function stop() { const current = state(); if (!current) return console.log('没有可停止的 MaxCINE 开发服务。'); for (const pid of current.pids) { if (alive(pid)) process.kill(pid, 'SIGTERM'); } clearState(); console.log('已停止由 MaxCINE 开发脚本启动的服务。'); }

const action = process.argv[2] ?? 'start';
if (action === 'start') await start(); else if (action === 'status') status(); else if (action === 'stop') stop(); else { console.error('用法：node scripts/dev.mjs [start|status|stop]'); process.exitCode = 1; }
