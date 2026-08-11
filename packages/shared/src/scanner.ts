export type ScannerSymbology =
  | 'ean_13'
  | 'ean_8'
  | 'code_128'
  | 'code_39'
  | 'upc_a'
  | 'upc_e'
  | 'itf'
  | 'qr_code'
  | 'data_matrix'
  | 'unknown';

export type ParsedScanKind = 'serial' | 'tracking' | 'order' | 'material' | 'url' | 'json' | 'text';

export type ParsedScan =
  | { ok: true; value: string; kind: ParsedScanKind; format: ScannerSymbology; raw: string; warning?: string }
  | { ok: false; reason: string; raw: string; format: ScannerSymbology };

export const WAREHOUSE_SCANNER_FORMATS: ScannerSymbology[] = ['ean_13', 'ean_8', 'code_128', 'code_39', 'upc_a', 'upc_e', 'itf', 'qr_code', 'data_matrix'];

const MAXCINE_ALLOWED_URL_HOSTS = ['maxcine.cn', 'www.maxcine.cn', 'dealer.maxcine.cn', 'staging.maxcine.cn', 'maxcine-web-staging.pages.dev'];

export function normalizeScanText(input: string): string {
  return input.replace(/[\r\n\t]/g, '').trim();
}

export function normalizeScannerValue(input: string): string {
  return normalizeScanText(input).toUpperCase();
}

export function eanCheckDigit(payload: string): number {
  const digits = payload.split('').map((char) => Number(char));
  const sum = digits.reduce((total, digit, index) => {
    const positionFromRight = payload.length - index;
    return total + digit * (positionFromRight % 2 === 1 ? 3 : 1);
  }, 0);
  return (10 - (sum % 10)) % 10;
}

export function isValidEan(value: string): boolean {
  if (!/^\d{8}$|^\d{12}$|^\d{13}$/.test(value)) return false;
  return eanCheckDigit(value.slice(0, -1)) === Number(value.at(-1));
}

function isScannerSafeCode(value: string): boolean {
  return /^[A-Z0-9._\-/]+$/.test(value) && value.length >= 3 && value.length <= 100;
}

function inferTextKind(value: string): ParsedScanKind {
  if (/^CAS-[A-Z0-9]{5}-[A-Z0-9]{5}$/i.test(value)) return 'order';
  if (/^MC-[A-Z0-9-]+$/i.test(value)) return 'order';
  if (/^(?:CG|W)\.[A-Z0-9. -]+$/i.test(value) || /^W\d{3,}$/i.test(value)) return 'material';
  if (/^(?:SF|JD|YT|STO|ZTO|YTO)?[A-Z0-9._\-/]{8,40}$/i.test(value)) return 'serial';
  return 'text';
}

export function parseQrPayload(raw: string, format: ScannerSymbology = 'qr_code'): ParsedScan {
  const text = normalizeScanText(raw);
  if (!text) return { ok: false, reason: '二维码内容为空', raw, format };
  if (isScannerSafeCode(normalizeScannerValue(text))) {
    const value = normalizeScannerValue(text);
    return { ok: true, value, kind: inferTextKind(value), format, raw };
  }
  try {
    const url = new URL(text);
    if (!MAXCINE_ALLOWED_URL_HOSTS.includes(url.hostname.toLowerCase()) && !url.hostname.toLowerCase().endsWith('.maxcine.cn')) {
      return { ok: false, reason: '已识别二维码，但内容不是可用的 MaxCINE 数据', raw, format };
    }
    const candidate = url.searchParams.get('sn') || url.searchParams.get('serial') || url.searchParams.get('order') || url.pathname.split('/').filter(Boolean).at(-1) || '';
    const value = normalizeScannerValue(candidate);
    if (!isScannerSafeCode(value)) return { ok: false, reason: '已识别二维码，但链接中没有可用的 SN 或订单号', raw, format };
    return { ok: true, value, kind: inferTextKind(value), format, raw };
  } catch {
    // Not a URL.
  }
  try {
    const payload = JSON.parse(text) as Record<string, unknown>;
    const candidate = [payload.sn, payload.serial, payload.serialNumber, payload.orderNo, payload.order, payload.materialCode].find((value) => typeof value === 'string') as string | undefined;
    const value = normalizeScannerValue(candidate ?? '');
    if (!isScannerSafeCode(value)) return { ok: false, reason: '已识别二维码，但内容不是可用的 MaxCINE 数据', raw, format };
    return { ok: true, value, kind: inferTextKind(value), format, raw };
  } catch {
    return { ok: false, reason: '已识别二维码，但内容不是可用的 MaxCINE 数据', raw, format };
  }
}

export function parseScannedValue(raw: string, format: ScannerSymbology = 'unknown'): ParsedScan {
  const text = normalizeScanText(raw);
  if (!text) return { ok: false, reason: '扫码内容为空', raw, format };
  const normalized = normalizeScannerValue(text);
  if (format === 'qr_code' || format === 'data_matrix') return parseQrPayload(text, format);
  if (['ean_13', 'ean_8', 'upc_a', 'upc_e'].includes(format) && !isValidEan(normalized)) {
    return { ok: false, reason: '条形码校验位错误，已丢弃本次识别结果', raw, format };
  }
  if (format === 'code_39' && !/^[A-Z0-9 .$/+%-]+$/.test(normalized)) {
    return { ok: false, reason: 'Code 39 字符集校验失败', raw, format };
  }
  if (format === 'code_128' && (normalized.length < 3 || normalized.length > 100)) {
    return { ok: false, reason: 'Code 128 长度不符合要求', raw, format };
  }
  if (!isScannerSafeCode(normalized)) return { ok: false, reason: '扫码内容不是可用的 MaxCINE 数据', raw, format };
  return { ok: true, value: normalized, kind: inferTextKind(normalized), format, raw };
}

export class MultiFrameConsensus {
  private readonly frames: string[] = [];

  constructor(private readonly windowSize = 5, private readonly consecutiveRequired = 3, private readonly majorityRequired = 4) {}

  push(value: string): string | null {
    this.frames.push(value);
    while (this.frames.length > this.windowSize) this.frames.shift();
    const tail = this.frames.slice(-this.consecutiveRequired);
    if (tail.length === this.consecutiveRequired && tail.every((item) => item === value)) return value;
    const count = this.frames.filter((item) => item === value).length;
    return count >= this.majorityRequired ? value : null;
  }

  reset(): void {
    this.frames.splice(0);
  }
}

export function canAcceptScan(lastAcceptedAt: Record<string, number>, value: string, now = Date.now(), cooldownMs = 2000): boolean {
  const previous = lastAcceptedAt[value];
  if (previous !== undefined && now - previous < cooldownMs) return false;
  lastAcceptedAt[value] = now;
  return true;
}
