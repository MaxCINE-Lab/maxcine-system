import { AppError, type Role, type SessionUser } from '@maxcine/shared';
import type { Context, MiddlewareHandler } from 'hono';
import type { Env, Variables } from './types';
import { one } from './db';

type TokenPayload = SessionUser & { exp: number };

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
  const payload: TokenPayload = { ...user, exp: Math.floor(Date.now() / 1000) + 60 * 60 * 8 };
  const encoded = toBase64Url(encoder.encode(JSON.stringify(payload)));
  return `${encoded}.${await hmac(encoded, secret)}`;
}

export async function verifySessionToken(token: string, secret: string): Promise<SessionUser | null> {
  const [encoded, signature] = token.split('.');
  if (!encoded || !signature || !constantTimeEqual(await hmac(encoded, secret), signature)) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(encoded))) as TokenPayload;
    if (payload.exp < Math.floor(Date.now() / 1000) || !['admin', 'dealer', 'warehouse'].includes(payload.role)) return null;
    return { id: payload.id, email: payload.email, role: payload.role, dealerId: payload.dealerId, name: payload.name };
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

function tokenFromRequest(c: Context<{ Bindings: Env; Variables: Variables }>): string | null {
  const authorization = c.req.header('Authorization');
  if (authorization?.startsWith('Bearer ')) return authorization.slice(7);
  return c.req.header('Cookie')?.split(';').map((part) => part.trim()).find((part) => part.startsWith('mc_session='))?.slice('mc_session='.length) ?? null;
}

export const requireAuth: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (c, next) => {
  const token = tokenFromRequest(c);
  const user = token ? await verifySessionToken(token, c.env.SESSION_SECRET) : null;
  if (!user) throw new AppError(401, 'UNAUTHENTICATED', 'Please sign in to continue');
  const active = await one<{ is_active: number }>(c.env.DB, 'SELECT is_active FROM users WHERE id = ?', user.id);
  if (!active?.is_active) throw new AppError(401, 'UNAUTHENTICATED', 'Your session is no longer active');
  c.set('user', user);
  await next();
};

export function hasRole(user: SessionUser, ...roles: Role[]): boolean {
  return roles.includes(user.role);
}
