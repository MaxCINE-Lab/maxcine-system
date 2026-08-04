import type { SessionUser } from '@maxcine/shared';

export type Env = {
  DB: D1Database;
  ASSETS: R2Bucket;
  SESSION_SECRET: string;
  APP_ORIGIN: string;
  EMAIL_PROVIDER: 'mock' | 'resend' | 'ses';
  RESEND_API_KEY?: string;
  NOTIFICATION_EMAIL_FROM?: string;
  NOTIFICATION_EMAIL_NAME?: string;
  SUPPORT_EMAIL_REPLY_TO?: string;
  SUPPORT_EMAIL_REPLY_TO_NAME?: string;
  SUPPORT_EMAIL_FROM?: string;
  SUPPORT_EMAIL_NAME?: string;
};

export type Variables = {
  user: SessionUser;
  requestId: string;
};
