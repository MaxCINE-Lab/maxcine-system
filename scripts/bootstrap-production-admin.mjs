import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID, pbkdf2Sync } from 'node:crypto';
import { readFileSync } from 'node:fs';

const email = (process.env.PRODUCTION_ADMIN_EMAIL ?? 'yukyinchew@maxcine.cn').trim().toLowerCase();
const name = (process.env.PRODUCTION_ADMIN_NAME ?? '管理员').trim();
const databaseName = process.env.PRODUCTION_D1_NAME ?? 'maxcine-production-db';
const password = process.env.PRODUCTION_ADMIN_PASSWORD_FILE
  ? readFileSync(process.env.PRODUCTION_ADMIN_PASSWORD_FILE, 'utf8').trim()
  : (process.env.PRODUCTION_ADMIN_PASSWORD ?? '');

if (!email.includes('@')) {
  throw new Error('PRODUCTION_ADMIN_EMAIL 必须是有效邮箱。');
}

if (password.length < 10) {
  throw new Error('请通过 PRODUCTION_ADMIN_PASSWORD 或 PRODUCTION_ADMIN_PASSWORD_FILE 提供至少 10 位的生产管理员初始密码。');
}

function base64Url(buffer) {
  return Buffer.from(buffer).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

const iterations = 100000;
const salt = randomBytes(16);
const hash = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
const passwordHash = `pbkdf2$${iterations}$${base64Url(salt)}$${base64Url(hash)}`;
const userId = randomUUID();
const adminRoleId = '21000000-0000-4000-8000-000000000001';

const sql = `
PRAGMA foreign_keys = ON;
INSERT INTO users (id, email, password_hash, name, role, dealer_id, is_active, session_version, watermark_enabled, updated_at)
VALUES (${sqlString(userId)}, ${sqlString(email)}, ${sqlString(passwordHash)}, ${sqlString(name)}, 'admin', NULL, 1, 1, 1, CURRENT_TIMESTAMP)
ON CONFLICT(email) DO UPDATE SET
  password_hash = excluded.password_hash,
  name = excluded.name,
  role = 'admin',
  dealer_id = NULL,
  is_active = 1,
  session_version = users.session_version + 1,
  watermark_enabled = 1,
  updated_at = CURRENT_TIMESTAMP;
INSERT OR IGNORE INTO user_roles (user_id, role_id, assigned_by)
SELECT id, ${sqlString(adminRoleId)}, id FROM users WHERE email = ${sqlString(email)};
`;

execFileSync('npx', [
  'wrangler',
  'd1',
  'execute',
  databaseName,
  '--remote',
  '--env',
  'production',
  '--config',
  'apps/api/wrangler.toml',
  '--command',
  sql
], { stdio: 'inherit' });

console.log(`Production admin initialized: ${email}`);
