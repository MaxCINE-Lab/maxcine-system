import type { SessionUser } from '@maxcine/shared';

export type Env = {
  DB: D1Database;
  ASSETS?: R2Bucket;
  SESSION_SECRET: string;
  APP_ORIGIN: string;
  COOKIE_SAMESITE?: 'Lax' | 'None' | 'Strict';
  EMAIL_PROVIDER: 'mock' | 'resend';
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
