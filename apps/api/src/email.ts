export const FUNCTIONAL_EMAILS = {
  support: 'support@maxcine.cn',
  notifications: 'notification@maxcine.cn'
} as const;

export type MailTemplateKey = 'system_test' | 'after_sales_quote' | 'service_report' | 'shipment_notice' | 'password_reset';

export type MailMessage = {
  from: string;
  fromName?: string;
  replyTo?: string;
  replyToName?: string;
  to: string;
  subject: string;
  html: string;
  text?: string;
};

export interface EmailAdapter {
  send(message: MailMessage): Promise<void>;
}

export class DisabledEmailAdapter implements EmailAdapter {
  async send(_message: MailMessage): Promise<void> {
    throw new Error('Email delivery is disabled in this local-only build');
  }
}

export type EmailDeliveryEnv = {
  EMAIL_PROVIDER: 'mock' | 'resend';
  RESEND_API_KEY?: string;
};

export type EmailDeliveryResult = {
  sent: boolean;
  provider: string;
  providerMessageId: string;
  failureReason: string;
};

export async function sendEmail(env: EmailDeliveryEnv, message: MailMessage, idempotencyKey: string): Promise<EmailDeliveryResult> {
  if (env.EMAIL_PROVIDER !== 'resend' || !env.RESEND_API_KEY) {
    return {
      sent: false,
      provider: env.EMAIL_PROVIDER || 'mock',
      providerMessageId: '',
      failureReason: env.EMAIL_PROVIDER === 'resend' ? 'Resend 密钥未配置' : '邮件服务未配置'
    };
  }
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey
      },
      body: JSON.stringify({
      from: `${message.fromName || '【请勿回复】MaxCINE 服务中心'} <${message.from}>`,
        reply_to: message.replyTo ? `${message.replyToName || 'MaxCINE 客户支持'} <${message.replyTo}>` : undefined,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text ?? ''
      })
    });
    const payload = await response.json().catch(() => ({})) as { id?: string; message?: string; name?: string };
    if (!response.ok || !payload.id) {
      return { sent: false, provider: 'resend', providerMessageId: '', failureReason: payload.message || `邮件服务返回 ${response.status}` };
    }
    return { sent: true, provider: 'resend', providerMessageId: payload.id, failureReason: '' };
  } catch {
    return { sent: false, provider: 'resend', providerMessageId: '', failureReason: '邮件服务连接失败，请稍后重试' };
  }
}

export function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

export type MailTemplateData = {
  title: string;
  preheader?: string;
  logoUrl: string;
  reference?: string;
  fields?: Array<[string, string]>;
  sections?: Array<{ heading: string; body: string }>;
  actionText?: string;
  actionUrl?: string;
};

export const mailTemplates: Record<MailTemplateKey, { name: string; subject: string; description: string }> = {
  system_test: { name: '系统测试邮件', subject: '系统测试邮件', description: '用于验证 Resend、发件人、Reply-To 和模板渲染。' },
  after_sales_quote: { name: '售后报价', subject: '售后报价通知', description: '发送售后报价或产品服务报告书。' },
  service_report: { name: '售后服务报告', subject: '售后服务报告书', description: '发送检测结果、处理方式和审批结论。' },
  shipment_notice: { name: '发货通知', subject: '发货通知', description: '通知经销商或客户订单已发货。' },
  password_reset: { name: '密码重置', subject: '密码重置', description: '发送员工账号密码重置通知。' }
};

export function mailSubject(template: MailTemplateKey, envName: 'local' | 'staging' | 'production', suffix = ''): string {
  const prefix = envName === 'staging' ? '【STAGING】' : '';
  return `${prefix}【MaxCINE】${mailTemplates[template].subject}${suffix ? ` ${suffix}` : ''}`;
}

export function renderMailHtml(data: MailTemplateData): string {
  const fields = (data.fields ?? []).map(([label, value]) => `<tr><td style="width:126px;padding:10px 0;color:#6b7280;vertical-align:top">${escapeHtml(label)}</td><td style="padding:10px 0;color:#111827">${escapeHtml(value || '暂无数据')}</td></tr>`).join('');
  const sections = (data.sections ?? []).map((section) => `<section style="padding:0 0 22px"><h2 style="margin:0 0 10px;color:#111827;font-size:17px;line-height:1.35">${escapeHtml(section.heading)}</h2><p style="margin:0;color:#374151;line-height:1.75;white-space:pre-wrap">${escapeHtml(section.body || '暂无数据')}</p></section>`).join('');
  const action = data.actionText && data.actionUrl ? `<p style="margin:24px 0 0"><a href="${escapeHtml(data.actionUrl)}" style="display:inline-block;padding:12px 18px;border-radius:999px;background:#121315;color:#fff;text-decoration:none;font-weight:700">${escapeHtml(data.actionText)}</a></p>` : '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(data.title)}</title></head>
  <body style="margin:0;background:#f3f4f6;color:#111827;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',Arial,sans-serif">
  <div style="display:none;max-height:0;overflow:hidden;color:transparent">${escapeHtml(data.preheader || data.title)}</div>
  <main style="max-width:720px;margin:0 auto;padding:28px 14px"><section style="overflow:hidden;border:1px solid #e5e7eb;border-radius:18px;background:#fff">
  <header style="padding:30px 34px 24px;border-bottom:1px solid #e5e7eb"><img src="${escapeHtml(data.logoUrl)}" alt="MaxCINE" width="188" style="display:block;width:188px;max-width:54%;height:auto;margin-bottom:26px"><h1 style="margin:0;color:#111827;font-size:26px;line-height:1.25">${escapeHtml(data.title)}</h1>${data.reference ? `<p style="margin:8px 0 0;color:#6b7280;font-size:14px">${escapeHtml(data.reference)}</p>` : ''}</header>
  <section style="padding:26px 34px">${fields ? `<table role="presentation" style="width:100%;border-collapse:collapse;margin:0 0 24px;font-size:14px">${fields}</table>` : ''}${sections}${action}</section>
  <footer style="padding:22px 34px 28px;background:#f9fafb;color:#4b5563;font-size:13px;line-height:1.7">
    <p style="margin:0">本邮件由 MaxCINE 系统自动发送。</p>
    <p style="margin:0">请勿直接回复。</p>
    <p style="margin:0">如需帮助：support@maxcine.cn</p>
    <p style="margin:18px 0 0;color:#9ca3af">© ${new Date().getFullYear()} MaxCINE. All rights reserved.</p>
  </footer>
  </section></main></body></html>`;
}

export function renderMailText(data: MailTemplateData): string {
  const fields = (data.fields ?? []).map(([label, value]) => `${label}：${value || '暂无数据'}`).join('\n');
  const sections = (data.sections ?? []).map((section) => `${section.heading}\n${section.body || '暂无数据'}`).join('\n\n');
  return `${data.title}\n${data.reference ? `${data.reference}\n` : ''}${fields}\n\n${sections}\n\n本邮件由 MaxCINE 系统自动发送。\n请勿直接回复。\n如需帮助：support@maxcine.cn`;
}
