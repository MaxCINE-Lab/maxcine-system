export type ScanResult = { value: string; source: 'camera' | 'manual' };

export interface BarcodeScannerAdapter {
  isSupported(): boolean;
  start(onResult: (result: ScanResult) => void): Promise<void>;
  stop(): void;
}

// Browser barcode APIs are unevenly supported. This adapter intentionally exposes a stable seam;
// manual entry remains the operational fallback until a production scanner implementation is approved.
export class BrowserBarcodeScanner implements BarcodeScannerAdapter {
  isSupported(): boolean {
    return 'mediaDevices' in navigator && 'getUserMedia' in navigator.mediaDevices;
  }

  async start(_onResult: (result: ScanResult) => void): Promise<void> {
    if (!this.isSupported()) throw new Error('当前设备无法使用摄像头；请改用手动录入。');
    throw new Error('摄像头扫码适配层已预留，首版请使用手动录入或企业扫描枪。');
  }

  stop(): void {}
}
