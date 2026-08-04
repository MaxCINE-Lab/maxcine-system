import { AppError, PERMISSIONS, ROLES, type Permission, type Role, type SessionUser } from '@maxcine/shared';
import type { Context, MiddlewareHandler } from 'hono';
import type { Env, Variables } from './types';
import { all, one } from './db';

type TokenPayload = { id: string; email: string; name: string; sessionVersion: number; exp: number };

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function hmac(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value))));
}

function constantTimeEqual(first: string, second: string): boolean {
  if (first.length !== second.length) return false;
  let mismatch = 0;
  for (let index = 0; index < first.length; index += 1) mismatch |= first.charCodeAt(index) ^ second.charCodeAt(index);
  return mismatch === 0;
}

export async function createSessionToken(user: SessionUser, secret: string): Promise<string> {
  // Authorization is deliberately not embedded in the token. Each protected
  // request reloads role, permission and scope relationships from D1.
  const payload: TokenPayload = { id: user.id, email: user.email, name: user.name, sessionVersion: user.sessionVersion, exp: Math.floor(Date.now() / 1000) + 60 * 60 * 8 };
  const encoded = toBase64Url(encoder.encode(JSON.stringify(payload)));
  return `${encoded}.${await hmac(encoded, secret)}`;
}

export async function verifySessionToken(token: string, secret: string): Promise<Omit<TokenPayload, 'exp'> | null> {
  const [encoded, signature] = token.split('.');
  if (!encoded || !signature || !constantTimeEqual(await hmac(encoded, secret), signature)) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(encoded))) as TokenPayload;
    if (payload.exp < Math.floor(Date.now() / 1000) || !payload.id || !payload.email || !payload.name || !Number.isInteger(payload.sessionVersion)) return null;
    return { id: payload.id, email: payload.email, name: payload.name, sessionVersion: payload.sessionVersion };
  } catch {
    return null;
  }
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [algorithm, iterationsText, saltText, hashText] = storedHash.split('$');
  const iterations = Number(iterationsText);
  if (algorithm !== 'pbkdf2' || !Number.isInteger(iterations) || iterations < 210000 || !saltText || !hashText) return false;
  const salt = fromBase64Url(saltText);
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as unknown as BufferSource, iterations }, key, 256);
  return constantTimeEqual(toBase64Url(new Uint8Array(bits)), hashText);
}

export async function hashPassword(password: string): Promise<string> {
  const iterations = 210000;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as unknown as BufferSource, iterations }, key, 256);
  return `pbkdf2$${iterations}$${toBase64Url(salt)}$${toBase64Url(new Uint8Array(bits))}`;
}

export async function hashIdentifier(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return toBase64Url(new Uint8Array(digest));
}

export async function loadSessionUser(db: D1Database, userId: string): Promise<SessionUser | null> {
  const account = await one<{ id: string; email: string; name: string; isActive: number; sessionVersion: number; watermarkEnabled: number }>(db,
    'SELECT id, email, name, is_active AS isActive, session_version AS sessionVersion, watermark_enabled AS watermarkEnabled FROM users WHERE id = ?', userId);
  if (!account?.isActive) return null;
  const [roleRows, permissionRows, dealerRows, serviceCenterRows, storeRows] = await Promise.all([
    all<{ code: string }>(db, `SELECT roles.code FROM user_roles JOIN roles ON roles.id = user_roles.role_id
      WHERE user_roles.user_id = ? AND roles.is_active = 1 ORDER BY roles.code`, userId),
    all<{ code: string }>(db, `SELECT DISTINCT permissions.code FROM user_roles
      JOIN roles ON roles.id = user_roles.role_id AND roles.is_active = 1
      JOIN role_permissions ON role_permissions.role_id = roles.id
      JOIN permissions ON permissions.code = role_permissions.permission_code
      WHERE user_roles.user_id = ? ORDER BY permissions.code`, userId),
    all<{ dealerId: string }>(db, `SELECT dealer_id AS dealerId FROM dealer_user_assignments
      WHERE user_id = ? AND status = 'active' ORDER BY dealer_id`, userId),
    all<{ serviceCenterId: string }>(db, `SELECT service_center_id AS serviceCenterId FROM service_center_user_assignments
      WHERE user_id = ? AND status = 'active' ORDER BY service_center_id`, userId),
    all<{ storeId: string }>(db, `SELECT store_id AS storeId FROM store_user_assignments
      WHERE user_id = ? AND status = 'active' ORDER BY store_id`, userId)
  ]);
  const roles = roleRows.map((row) => row.code).filter((code): code is Role => (ROLES as readonly string[]).includes(code));
  const dealerIds = dealerRows.map((row) => row.dealerId);
  return {
    id: account.id,
    email: account.email,
    name: account.name,
    role: roles[0] ?? 'dealer',
    dealerId: dealerIds[0] ?? null,
    roles,
    permissions: permissionRows.map((row) => row.code).filter((code): code is Permission => (PERMISSIONS as readonly string[]).includes(code)),
    dealerIds,
    serviceCenterIds: serviceCenterRows.map((row) => row.serviceCenterId),
    storeIds: storeRows.map((row) => row.storeId),
    sessionVersion: account.sessionVersion,
    watermarkEnabled: Boolean(account.watermarkEnabled)
  };
}

function tokenFromRequest(c: Context<{ Bindings: Env; Variables: Variables }>): string | null {
  const authorization = c.req.header('Authorization');
  if (authorization?.startsWith('Bearer ')) return authorization.slice(7);
  return c.req.header('Cookie')?.split(';').map((part) => part.trim()).find((part) => part.startsWith('mc_session='))?.slice('mc_session='.length) ?? null;
}

export const requireAuth: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (c, next) => {
  const token = tokenFromRequest(c);
  const identity = token ? await verifySessionToken(token, c.env.SESSION_SECRET) : null;
  if (!identity) throw new AppError(401, 'UNAUTHENTICATED', '请先登录后再继续');
  const user = await loadSessionUser(c.env.DB, identity.id);
  if (!user || user.sessionVersion !== identity.sessionVersion) throw new AppError(401, 'UNAUTHENTICATED', '登录状态已失效，请重新登录');
  c.set('user', user);
  await next();
};

export function hasRole(user: SessionUser, ...roles: Role[]): boolean {
  return roles.some((role) => user.roles.includes(role));
}
