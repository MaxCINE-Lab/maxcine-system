import type { SessionUser } from '@maxcine/shared';

export type Env = {
  DB: D1Database;
  ASSETS: R2Bucket;
  SESSION_SECRET: string;
  APP_ORIGIN: string;
  EMAIL_PROVIDER: 'mock' | 'resend' | 'ses';
};

export type Variables = {
  user: SessionUser;
  requestId: string;
};
