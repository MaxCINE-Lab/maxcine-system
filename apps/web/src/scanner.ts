export type ScanResult = { value: string; source: 'camera' | 'manual' };

export interface BarcodeScannerAdapter {
  isSupported(): boolean;
  start(onResult: (result: ScanResult) => void): Promise<void>;
  stop(): void;
}

type BarcodeDetectorLike = {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
};

type BarcodeDetectorConstructor = new (options?: { formats?: string[] }) => BarcodeDetectorLike;

declare global {
  interface Window {
    BarcodeDetector?: BarcodeDetectorConstructor;
  }
}

export class BrowserBarcodeScanner implements BarcodeScannerAdapter {
  private stream: MediaStream | null = null;
  private overlay: HTMLDivElement | null = null;
  private active = false;

  isSupported(): boolean {
    return Boolean(navigator.mediaDevices && window.BarcodeDetector);
  }

  async start(onResult: (result: ScanResult) => void): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前设备无法使用摄像头，请改用扫描枪或手动输入。');
    if (!window.BarcodeDetector) throw new Error('当前浏览器不支持摄像头识别条码，请使用 Chrome 或改用扫描枪。');
    this.stop();
    const detector = new window.BarcodeDetector({ formats: ['code_128', 'code_39', 'ean_13', 'ean_8', 'qr_code', 'data_matrix'] });
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    this.stream = stream;
    this.active = true;

    const overlay = document.createElement('div');
    overlay.className = 'scanner-overlay';
    overlay.innerHTML = `
      <div class="scanner-dialog" role="dialog" aria-modal="true" aria-label="摄像头扫码">
        <video class="scanner-video" autoplay playsinline muted></video>
        <div class="scanner-frame"><span></span></div>
        <p>请将条码或 SN 放入取景框内</p>
        <button type="button" class="scanner-cancel">取消扫码</button>
      </div>
    `;
    document.body.appendChild(overlay);
    this.overlay = overlay;
    const video = overlay.querySelector<HTMLVideoElement>('video');
    const cancel = overlay.querySelector<HTMLButtonElement>('.scanner-cancel');
    if (!video || !cancel) {
      this.stop();
      throw new Error('摄像头扫码窗口初始化失败。');
    }
    video.srcObject = stream;
    cancel.addEventListener('click', () => this.stop(), { once: true });
    await video.play();

    await new Promise<void>((resolve, reject) => {
      let pending = false;
      const startedAt = Date.now();
      const tick = () => {
        if (!this.active) {
          resolve();
          return;
        }
        if (Date.now() - startedAt > 45000) {
          this.stop();
          reject(new Error('未识别到条码，请调整光线或改用手动输入。'));
          return;
        }
        if (!pending && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          pending = true;
          detector.detect(video).then((codes) => {
            pending = false;
            const value = codes[0]?.rawValue?.trim();
            if (value) {
              onResult({ value, source: 'camera' });
              this.stop();
              resolve();
            } else {
              requestAnimationFrame(tick);
            }
          }).catch((error: unknown) => {
            this.stop();
            reject(error instanceof Error ? error : new Error('摄像头扫码失败。'));
          });
        } else {
          requestAnimationFrame(tick);
        }
      };
      requestAnimationFrame(tick);
    });
  }

  stop(): void {
    this.active = false;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.overlay?.remove();
    this.overlay = null;
  }
}
