import type { SessionUser } from '@maxcine/shared';

const baseUrl = import.meta.env.VITE_API_BASE_URL || '/api';

export function apiResourceUrl(path: string): string {
  return path.startsWith('http://') || path.startsWith('https://') ? path : `${baseUrl}${path}`;
}

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

export function uploadFormData<T>(path: string, form: FormData, onProgress: (percent: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', `${baseUrl}${path}`);
    request.withCredentials = true;
    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    });
    request.addEventListener('load', () => {
      const body = (() => { try { return JSON.parse(request.responseText) as T & { error?: { message?: string; code?: string } }; } catch { return null; } })();
      if (request.status >= 200 && request.status < 300 && body) {
        onProgress(100);
        resolve(body);
        return;
      }
      const error = body && 'error' in body ? body.error : undefined;
      reject(new ApiClientError(error?.message ?? '上传未能完成', error?.code));
    });
    request.addEventListener('error', () => reject(new ApiClientError('网络中断，照片上传失败')));
    request.addEventListener('abort', () => reject(new ApiClientError('照片上传已取消')));
    request.send(form);
  });
}

export type CurrentUserResponse = { user: SessionUser };
export type LoginResponse = { user: SessionUser };
