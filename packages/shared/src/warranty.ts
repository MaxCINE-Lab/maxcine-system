export type ShipmentWarrantyRule = {
  sku: string;
  durationDays: number;
  label: string;
};

// W114 is intentionally absent: the supplied rule set assigns it both 180 and
// 365 days. Shipping it without an automatic end date is safer than applying
// the wrong customer warranty. Add it only after the business rule is confirmed.
const shipmentWarrantyRules: Record<string, ShipmentWarrantyRule> = {
  W101: { sku: 'W101', durationDays: 90, label: '标准保修 90 天' },
  W113: { sku: 'W113', durationDays: 90, label: '标准保修 90 天' },
  W102: { sku: 'W102', durationDays: 180, label: '增强保修 180 天' },
  W103: { sku: 'W103', durationDays: 365, label: '创作保修 365 天' },
  W124: { sku: 'W124', durationDays: 90, label: 'ND 滤镜保修 90 天' }
};

export function shipmentWarrantyRule(sku: string): ShipmentWarrantyRule | null {
  return shipmentWarrantyRules[sku.trim().toUpperCase()] ?? null;
}

export function shipmentWarrantyDates(shippedAt: string | Date, durationDays: number): { startAt: string; endAt: string } {
  const value = typeof shippedAt === 'string' ? new Date(`${shippedAt.replace(' ', 'T')}Z`) : shippedAt;
  const shippedDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);
  const [year, month, day] = shippedDate.split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 1, day + 3));
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + durationDays - 1);
  return { startAt: start.toISOString().slice(0, 10), endAt: end.toISOString().slice(0, 10) };
}
