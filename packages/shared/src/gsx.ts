export const HISTORICAL_WARRANTY_COLUMNS = [
  '序号', '销售渠道', '版本', '购买日期', '购买价格', 'SN', '保修状态', '发出单号', '发货仓库', '用户画像', '到账状态', '保修开始', '保修结束',
  '维修记录1', '维修记录2', '维修记录3', '维修记录4', '备注1', '备注2', '备注3', '备注4', '备注5'
] as const;

export type HistoricalWarrantyValues = Record<string, string | number | boolean | null>;
export type ImportIssue = { severity: 'warning' | 'error'; code: string; message: string };
export type AssetEventDraft = { eventType: string; title: string; description: string; visibility: 'admin_private' | 'service_center'; occurredAt: string | null; newValue?: unknown };
export type AssetNoteDraft = { category: 'private_admin' | 'data_quality' | 'general'; content: string; visibility: 'admin_private' };

export type NormalizedWarrantyRecord = {
  sourceRowNumber: number;
  sequence: string;
  sourceChannel: string;
  version: string;
  purchaseDate: string | null;
  purchaseDateAnnotation: string;
  purchasePriceRaw: string;
  unitPriceCents: number | null;
  quantity: number | null;
  totalPriceCents: number | null;
  paymentStatus: 'received' | 'shipped' | 'unknown';
  paymentAmountCents: number | null;
  paymentRaw: string;
  trackingNumber: string | null;
  shippingWarehouse: string;
  currentSn: string | null;
  originalSn: string | null;
  assetStatus: 'active' | 'refurbished' | 'scrapped' | 'unknown';
  warrantyPolicy: 'standard' | 'none' | 'unknown';
  warrantyStartAt: string | null;
  warrantyEndAt: string | null;
  warrantyOverrideStatus: 'no_warranty' | 'denied' | 'exception' | 'cancelled' | 'scrapped' | null;
  warrantyOverrideReason: string;
  dataQualityStatus: 'normal' | 'warning' | 'duplicate_identifier' | 'invalid_identifier' | 'missing_identifier';
  identifiers: Array<{ type: 'current_sn' | 'original_sn' | 'replacement_sn' | 'duplicate_label' | 'invalid_label'; value: string; isCurrent: boolean; reason: string }>;
  events: AssetEventDraft[];
  notes: AssetNoteDraft[];
  issues: ImportIssue[];
};

const text = (value: unknown) => value === null || value === undefined ? '' : String(value).trim();
const cny = (value: number) => Math.round(value * 100);
const dateToken = /^(\d{4})\s*[./-]?\s*(\d{1,2})\s*[./-]?\s*(\d{1,2})(?:\s*[（(]([^）)]*)[）)])?$/;
const trackingToken = /^SF\d{10,}$/i;
const validSn = /^\d{10,}$/;
const sensitivePattern = /(?:事多|白嫖|低质量|低认知|没钱|没脑子|恶意|骗保|穷|骚扰|\b1\d{10}\b)/;

function validIsoDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` : null;
}

export function parseHistoricalDate(value: unknown): { date: string | null; annotation: string; special: 'none' | 'no_warranty' | 'denied'; invalid: boolean } {
  const raw = text(value).replace(/\s+/g, ' ');
  if (!raw) return { date: null, annotation: '', special: 'none', invalid: false };
  if (/^无保修$/.test(raw)) return { date: null, annotation: '', special: 'no_warranty', invalid: false };
  if (/不得保修|拒保/.test(raw)) return { date: null, annotation: '', special: 'denied', invalid: false };
  const match = raw.match(dateToken);
  if (!match) return { date: null, annotation: '', special: 'none', invalid: true };
  const date = validIsoDate(Number(match[1]), Number(match[2]), Number(match[3]));
  return { date, annotation: (match[4] ?? '').trim(), special: 'none', invalid: !date };
}

export function parseHistoricalPrice(value: unknown): { raw: string; unitPriceCents: number | null; quantity: number | null; totalPriceCents: number | null } {
  const raw = text(value);
  if (!raw) return { raw, unitPriceCents: null, quantity: null, totalPriceCents: null };
  const simple = Number(raw);
  if (Number.isFinite(simple)) return { raw, unitPriceCents: cny(simple), quantity: 1, totalPriceCents: cny(simple) };
  const expression = raw.match(/^(\d+(?:\.\d+)?)\s*[xX×*]\s*(\d+)\s*=\s*(\d+(?:\.\d+)?)$/);
  if (!expression) return { raw, unitPriceCents: null, quantity: null, totalPriceCents: null };
  return { raw, unitPriceCents: cny(Number(expression[1])), quantity: Number(expression[2]), totalPriceCents: cny(Number(expression[3])) };
}

export function parseHistoricalPayment(value: unknown): { raw: string; status: 'received' | 'shipped' | 'unknown'; amountCents: number | null } {
  const raw = text(value);
  const received = raw.match(/^已到账\s*(\d+(?:\.\d+)?)?$/);
  if (received) return { raw, status: 'received', amountCents: received[1] ? cny(Number(received[1])) : null };
  if (/^已发货$/.test(raw)) return { raw, status: 'shipped', amountCents: null };
  return { raw, status: 'unknown', amountCents: null };
}

function overrideFor(status: string, warrantyStart: ReturnType<typeof parseHistoricalDate>, warrantyEnd: ReturnType<typeof parseHistoricalDate>): NormalizedWarrantyRecord['warrantyOverrideStatus'] {
  if (/报废/.test(status)) return 'scrapped';
  if (/注销/.test(status)) return 'cancelled';
  if (/拒保/.test(status) || warrantyStart.special === 'denied' || warrantyEnd.special === 'denied') return 'denied';
  if (/无保修/.test(status) || warrantyStart.special === 'no_warranty' || warrantyEnd.special === 'no_warranty') return 'no_warranty';
  if (/异常/.test(status)) return 'exception';
  return null;
}

function repairEvent(record: string, purchaseDate: string | null): AssetEventDraft {
  const eventType = /(?:新\s*SN|序列号.*(?:更换|变更)|换新|更换)/.test(record) ? 'sn_changed'
    : /翻新/.test(record) ? 'refurbished'
      : /返厂/.test(record) ? 'service_received'
        : /维修|故障|检测|修复/.test(record) ? 'repaired' : 'note_added';
  const replacement = [...record.matchAll(/(?:新\s*SN|序列号(?:更换|变更)?(?:为|：|:))\s*[：:]?\s*(\d{10,})/gi)].map((match) => match[1]);
  return { eventType, title: '历史维修记录', description: record, occurredAt: purchaseDate, visibility: sensitivePattern.test(record) ? 'admin_private' : 'service_center', ...(replacement.length ? { newValue: { replacementSn: replacement } } : {}) };
}

function firstReplacementSn(records: string[]): string | null {
  for (const record of records) {
    const value = record.match(/(?:新\s*SN|序列号(?:更换|变更)?(?:为|：|:))\s*[：:]?\s*(\d{10,})/i)?.[1];
    if (value) return value;
  }
  return null;
}

export function normalizeHistoricalWarrantyRecord(input: { rowNumber: number; values: HistoricalWarrantyValues }, duplicateSns: ReadonlySet<string> = new Set()): NormalizedWarrantyRecord {
  const value = (key: string) => text(input.values[key]);
  const issues: ImportIssue[] = [];
  const sourceSn = value('SN').toUpperCase();
  const purchaseDate = parseHistoricalDate(value('购买日期'));
  const warrantyStart = parseHistoricalDate(value('保修开始'));
  const warrantyEnd = parseHistoricalDate(value('保修结束'));
  const price = parseHistoricalPrice(value('购买价格'));
  const payment = parseHistoricalPayment(value('到账状态'));
  const repairRecords = ['维修记录1', '维修记录2', '维修记录3', '维修记录4'].map(value).filter(Boolean);
  const notes = ['备注1', '备注2', '备注3', '备注4', '备注5'].map(value).filter(Boolean);
  const replacementSn = firstReplacementSn([...repairRecords, ...notes]);
  let currentSn: string | null = sourceSn || null;
  const originalSn: string | null = sourceSn || null;
  let quality: NormalizedWarrantyRecord['dataQualityStatus'] = 'normal';
  const identifiers: NormalizedWarrantyRecord['identifiers'] = [];

  if (!sourceSn) {
    quality = 'missing_identifier';
    issues.push({ severity: 'warning', code: 'missing_sn', message: '缺少 SN；将创建可补充标识的历史资产。' });
  } else if (trackingToken.test(sourceSn)) {
    currentSn = replacementSn;
    quality = 'invalid_identifier';
    identifiers.push({ type: 'invalid_label', value: sourceSn, isCurrent: false, reason: '原表 SN 字段实际为顺丰单号' });
    issues.push({ severity: 'warning', code: 'tracking_as_sn', message: 'SN 字段疑似顺丰单号，已保留为错误标签，不作为当前 SN。' });
    if (replacementSn) identifiers.push({ type: 'replacement_sn', value: replacementSn, isCurrent: true, reason: '从历史维修或备注中识别的新 SN' });
  } else if (!validSn.test(sourceSn)) {
    quality = 'invalid_identifier';
    identifiers.push({ type: 'invalid_label', value: sourceSn, isCurrent: false, reason: '历史 SN 格式异常' });
    issues.push({ severity: 'warning', code: 'invalid_sn_format', message: 'SN 格式异常，已保留原值并标记待核验。' });
  }
  if (currentSn && duplicateSns.has(currentSn)) {
    quality = 'duplicate_identifier';
    identifiers.push({ type: 'duplicate_label', value: currentSn, isCurrent: true, reason: '同一历史文件中存在重复 SN' });
    issues.push({ severity: 'warning', code: 'duplicate_sn', message: '同一 SN 对应多条历史销售记录，将分别保留并标记为重复标签。' });
  } else if (currentSn) {
    identifiers.push({ type: 'current_sn', value: currentSn, isCurrent: true, reason: '历史销售记录当前 SN' });
  }
  if (originalSn && originalSn !== currentSn) identifiers.push({ type: 'original_sn', value: originalSn, isCurrent: false, reason: '原表 SN 原始值' });

  for (const [label, parsed] of [['购买日期', purchaseDate], ['保修开始', warrantyStart], ['保修结束', warrantyEnd]] as const) {
    if (parsed.invalid) issues.push({ severity: 'error', code: 'invalid_date', message: `${label}无法解析；可跳过此行或修正源数据后重试。` });
    if (parsed.annotation) issues.push({ severity: 'warning', code: 'date_annotation', message: `${label}中的括号说明会保留为导入备注。` });
  }
  if (price.raw && price.unitPriceCents === null) issues.push({ severity: 'warning', code: 'unparsed_price', message: '购买价格无法识别为金额，已保留原始文本。' });
  if (value('到账状态') && payment.status === 'unknown') issues.push({ severity: 'warning', code: 'unparsed_payment', message: '到账状态未识别为收款状态，已保留原始文本。' });

  const override = overrideFor(value('保修状态'), warrantyStart, warrantyEnd);
  const privateNotes = [
    value('用户画像') ? { category: 'private_admin' as const, content: `用户画像：${value('用户画像')}`, visibility: 'admin_private' as const } : null,
    ...notes.map((content) => ({ category: sensitivePattern.test(content) ? 'private_admin' as const : 'general' as const, content, visibility: 'admin_private' as const })),
    ...[purchaseDate.annotation, warrantyStart.annotation, warrantyEnd.annotation].filter(Boolean).map((content) => ({ category: 'data_quality' as const, content: `原表日期附注：${content}`, visibility: 'admin_private' as const }))
  ].filter((note): note is AssetNoteDraft => Boolean(note));

  const assetStatus: NormalizedWarrantyRecord['assetStatus'] = override === 'scrapped' ? 'scrapped' : /翻新/.test([...repairRecords, ...notes].join(' ')) ? 'refurbished' : currentSn ? 'active' : 'unknown';
  return {
    sourceRowNumber: input.rowNumber,
    sequence: value('序号'), sourceChannel: value('销售渠道'), version: value('版本'),
    purchaseDate: purchaseDate.date, purchaseDateAnnotation: purchaseDate.annotation, purchasePriceRaw: price.raw,
    unitPriceCents: price.unitPriceCents, quantity: price.quantity, totalPriceCents: price.totalPriceCents,
    paymentStatus: payment.status, paymentAmountCents: payment.amountCents, paymentRaw: payment.raw,
    trackingNumber: value('发出单号') || (trackingToken.test(sourceSn) ? sourceSn : null), shippingWarehouse: value('发货仓库'),
    currentSn, originalSn, assetStatus, warrantyPolicy: override === 'no_warranty' ? 'none' : warrantyStart.date || warrantyEnd.date ? 'standard' : 'unknown',
    warrantyStartAt: warrantyStart.date, warrantyEndAt: warrantyEnd.date, warrantyOverrideStatus: override,
    warrantyOverrideReason: override ? `原表保修状态：${value('保修状态') || '未填写'}` : '', dataQualityStatus: quality,
    identifiers, events: repairRecords.map((record) => repairEvent(record, purchaseDate.date)), notes: privateNotes, issues
  };
}

export function normalizeHistoricalWarrantyRecords(records: Array<{ rowNumber: number; values: HistoricalWarrantyValues }>): NormalizedWarrantyRecord[] {
  const counts = new Map<string, number>();
  for (const record of records) {
    const sn = text(record.values.SN).toUpperCase();
    if (sn) counts.set(sn, (counts.get(sn) ?? 0) + 1);
  }
  const duplicates = new Set([...counts].filter(([, count]) => count > 1).map(([sn]) => sn));
  return records.map((record) => normalizeHistoricalWarrantyRecord(record, duplicates));
}

export function warrantyDisplayStatus(asset: { warrantyEndAt: string | null; warrantyStartAt: string | null; warrantyOverrideStatus: string | null }, now = new Date()): '保修中' | '已过保' | '待生效' | '无有效日期' | '无保修' | '拒保' | '异常' | '注销' | '报废' {
  const overrides: Record<string, '无保修' | '拒保' | '异常' | '注销' | '报废'> = { no_warranty: '无保修', denied: '拒保', exception: '异常', cancelled: '注销', scrapped: '报废' };
  if (asset.warrantyOverrideStatus && overrides[asset.warrantyOverrideStatus]) return overrides[asset.warrantyOverrideStatus];
  if (!asset.warrantyStartAt || !asset.warrantyEndAt) return '无有效日期';
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  if (today < asset.warrantyStartAt) return '待生效';
  return today > asset.warrantyEndAt ? '已过保' : '保修中';
}
