import type { SessionUser } from '@maxcine/shared';

const baseUrl = import.meta.env.VITE_API_BASE_URL || '/api';

export class ApiClientError extends Error {
  constructor(message: string, public readonly code?: string, public readonly details?: Record<string, string[]>) { super(message); }
}

function validationMessage(message: string, details?: Record<string, string[]>): string {
  const first = Object.entries(details ?? {})[0];
  if (!first) return message;
  const [field, messages] = first;
  const text = messages.filter(Boolean).join('；');
  return text ? `${message}：${field} ${text}` : message;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const isFormData = init?.body instanceof FormData;
  const response = await fetch(`${baseUrl}${path}`, {
    credentials: 'include',
    headers: { ...(isFormData ? {} : { 'Content-Type': 'application/json' }), ...(init?.headers ?? {}) },
    ...init
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { message?: string; code?: string; details?: Record<string, string[]> } } | null;
    const message = body?.error?.message ?? '请求未能完成';
    throw new ApiClientError(validationMessage(message, body?.error?.details), body?.error?.code, body?.error?.details);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export type CurrentUserResponse = { user: SessionUser };
export type LoginResponse = { user: SessionUser };
