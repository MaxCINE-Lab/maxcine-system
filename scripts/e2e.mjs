import { mkdtempSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import net from 'node:net';

const root = resolve(import.meta.dirname, '..');
const persistence = mkdtempSync(join(tmpdir(), 'maxcine-e2e-'));
if (!process.env.E2E_PASSWORD) { console.error('请通过环境变量 E2E_PASSWORD 提供仅限本机的演示账户密码。'); process.exit(1); }
function run(command, args, cwd = root, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} 执行失败（退出码 ${result.status ?? 1}）`);
}
function waitFor(url, deadline = Date.now() + 30_000) { return new Promise((resolveWait, reject) => { const attempt = async () => { try { if ((await fetch(url)).ok) return resolveWait(); } catch { /* service is still starting */ } if (Date.now() > deadline) return reject(new Error(`等待服务超时：${url}`)); setTimeout(attempt, 250); }; void attempt(); }); }
function available(port) { return new Promise((resolveCheck) => { const server = net.createServer(); server.once('error', () => resolveCheck(false)); server.listen(port, '127.0.0.1', () => server.close(() => resolveCheck(true))); }); }

if (!await available(5175) || !await available(8791)) { console.error('浏览器验收端口 5175 或 8791 已被占用，请先处理对应测试进程。'); process.exit(1); }
run('npx', ['wrangler', 'd1', 'migrations', 'apply', 'maxcine-db', '--local', '--persist-to', persistence, '--config', 'apps/api/wrangler.toml']);
run('npx', ['wrangler', 'd1', 'execute', 'maxcine-db', '--local', '--persist-to', persistence, '--file', 'apps/api/seed/0001_demo.sql', '--config', 'apps/api/wrangler.toml']);
const api = spawn(process.execPath, [join(root, 'node_modules/wrangler/wrangler-dist/cli.js'), 'dev', '--config', 'wrangler.toml', '--local', '--port', '8791', '--persist-to', persistence, '--var', 'APP_ORIGIN:http://127.0.0.1:5175'], { cwd: join(root, 'apps/api'), stdio: 'inherit' });
const web = spawn(join(root, 'node_modules/.bin/vite'), ['--host', '127.0.0.1', '--port', '5175', '--strictPort'], { cwd: join(root, 'apps/web'), stdio: 'inherit', env: { ...process.env, VITE_API_BASE_URL: 'http://127.0.0.1:8791' } });
const stopOne = async (child) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGINT');
  await Promise.race([exited, new Promise((resolveStop) => setTimeout(resolveStop, 2_000))]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
};
const stop = async () => { await Promise.all([stopOne(api), stopOne(web)]); };
try {
  await waitFor('http://127.0.0.1:8791/health');
  await waitFor('http://127.0.0.1:5175');
  run('npx', ['playwright', 'test', '--config=e2e/playwright.config.mjs'], root, { ...process.env, E2E_D1_PERSISTENCE: persistence });
} finally { await stop(); }
