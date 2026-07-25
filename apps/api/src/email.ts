export type EmailKind = 'order_submitted' | 'order_approved' | 'order_rejected' | 'order_shipped' | 'after_sales_created' | 'after_sales_updated';

export type MailMessage = {
  from: 'orders@maxcine.cn' | 'support@maxcine.cn';
  to: string;
  subject: string;
  html: string;
};

export interface EmailAdapter {
  send(message: MailMessage): Promise<void>;
}

export class MockEmailAdapter implements EmailAdapter {
  async send(_message: MailMessage): Promise<void> {
    // Deliberately no-op. Production providers must be separately configured and approved.
  }
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

export function emailTemplate(kind: EmailKind, data: { reference: string; status?: string; trackingNumber?: string; note?: string; logoUrl: string }): Pick<MailMessage, 'from' | 'subject' | 'html'> {
  const content: Record<EmailKind, { from: MailMessage['from']; subject: string; heading: string; detail: string }> = {
    order_submitted: { from: 'orders@maxcine.cn', subject: `订单已提交 · ${data.reference}`, heading: '订单已提交', detail: '您的订单已进入审核队列。' },
    order_approved: { from: 'orders@maxcine.cn', subject: `订单审核通过 · ${data.reference}`, heading: '订单审核通过', detail: '订单已转入仓库处理流程。' },
    order_rejected: { from: 'orders@maxcine.cn', subject: `订单审核结果 · ${data.reference}`, heading: '订单未获批准', detail: data.note || '请联系管理员了解详情。' },
    order_shipped: { from: 'orders@maxcine.cn', subject: `订单已发货 · ${data.reference}`, heading: '订单已发货', detail: `顺丰运单号：${data.trackingNumber ?? '待补充'}` },
    after_sales_created: { from: 'support@maxcine.cn', subject: `售后工单已创建 · ${data.reference}`, heading: '售后工单已创建', detail: '我们已收到您的请求。' },
    after_sales_updated: { from: 'support@maxcine.cn', subject: `售后工单状态更新 · ${data.reference}`, heading: '售后工单状态更新', detail: data.status ? `当前状态：${data.status}` : '工单已有更新。' }
  };
  const copy = content[kind];
  return {
    from: copy.from,
    subject: copy.subject,
    html: `<!doctype html><html lang="zh-CN"><body style="margin:0;background:#f5f5f7;color:#1d1d1f;font:16px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"><main style="max-width:600px;margin:0 auto;background:#fff;padding:36px 28px"><img src="${escapeHtml(data.logoUrl)}" alt="MaxCINE" width="150" style="display:block;background:#111;padding:10px;margin-bottom:32px"/><h1 style="font-size:24px;margin:0 0 12px">${escapeHtml(copy.heading)}</h1><p style="margin:0 0 24px;line-height:1.55">${escapeHtml(copy.detail)}</p><table style="border-collapse:collapse;width:100%;font-size:14px"><tr><td style="padding:12px 0;border-top:1px solid #d2d2d7;color:#6e6e73">参考编号</td><td style="padding:12px 0;border-top:1px solid #d2d2d7;text-align:right">${escapeHtml(data.reference)}</td></tr></table><p style="margin:32px 0 0;color:#6e6e73;font-size:12px">MaxCINE · 这是一封事务通知邮件。</p></main></body></html>`
  };
}
