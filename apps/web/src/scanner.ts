import { BrowserMultiFormatReader, type IScannerControls } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';

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
  private zxingControls: IScannerControls | null = null;
  private readonly scanTimeoutMs = 90000;

  isSupported(): boolean {
    return Boolean(navigator.mediaDevices?.getUserMedia);
  }

  async start(onResult: (result: ScanResult) => void): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前设备无法使用摄像头，请改用扫描枪或手动输入。');
    this.stop();
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    this.stream = stream;
    this.active = true;

    const overlay = document.createElement('div');
    overlay.className = 'scanner-overlay';
    overlay.innerHTML = `
      <div class="scanner-dialog" role="dialog" aria-modal="true" aria-label="摄像头扫码">
        <video class="scanner-video" autoplay playsinline muted></video>
        <div class="scanner-frame"><span></span></div>
        <p class="scanner-status">请将条码横向放入取景框内，避免反光。识别较慢时可拍照识别。</p>
        <label class="scanner-photo">
          拍照 / 选择图片识别
          <input type="file" accept="image/png,image/jpeg,image/webp" capture="environment" />
        </label>
        <button type="button" class="scanner-cancel">取消扫码</button>
      </div>
    `;
    document.body.appendChild(overlay);
    this.overlay = overlay;
    const video = overlay.querySelector<HTMLVideoElement>('video');
    const cancel = overlay.querySelector<HTMLButtonElement>('.scanner-cancel');
    const photoInput = overlay.querySelector<HTMLInputElement>('.scanner-photo input');
    if (!video || !cancel || !photoInput) {
      this.stop();
      throw new Error('摄像头扫码窗口初始化失败。');
    }
    video.srcObject = stream;
    cancel.addEventListener('click', () => this.stop(), { once: true });
    await video.play();

    if (!window.BarcodeDetector) {
      await this.startZxing(stream, video, photoInput, onResult);
      return;
    }

    const detector = new window.BarcodeDetector({ formats: ['code_128', 'code_39', 'ean_13', 'ean_8', 'qr_code', 'data_matrix'] });
    await new Promise<void>((resolve, reject) => {
      let pending = false;
      const startedAt = Date.now();
      photoInput.addEventListener('change', () => {
        const file = photoInput.files?.[0];
        if (!file) return;
        this.decodeImageFile(file, detector).then((value) => {
          onResult({ value, source: 'camera' });
          this.stop();
          resolve();
        }).catch(() => this.setStatus('这张照片未识别到条码，请重新拍摄清晰盒面或继续实时扫描。'));
      });
      const tick = () => {
        if (!this.active) {
          resolve();
          return;
        }
        if (Date.now() - startedAt > this.scanTimeoutMs) {
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

  private createZxingReader(): BrowserMultiFormatReader {
    const hints = new Map<DecodeHintType, unknown>();
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [
      BarcodeFormat.CODE_128,
      BarcodeFormat.CODE_39,
      BarcodeFormat.CODE_93,
      BarcodeFormat.CODABAR,
      BarcodeFormat.EAN_13,
      BarcodeFormat.EAN_8,
      BarcodeFormat.UPC_A,
      BarcodeFormat.UPC_E,
      BarcodeFormat.ITF,
      BarcodeFormat.QR_CODE,
      BarcodeFormat.DATA_MATRIX,
      BarcodeFormat.PDF_417
    ]);
    hints.set(DecodeHintType.TRY_HARDER, true);
    hints.set(DecodeHintType.CHARACTER_SET, 'UTF-8');
    return new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 120 });
  }

  private async decodeImageFile(file: File, detector?: BarcodeDetectorLike): Promise<string> {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('请选择 PNG、JPG 或 WebP 图片。');
    const objectUrl = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.src = objectUrl;
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('图片无法读取。'));
      });
      if (detector) {
        const codes = await detector.detect(image);
        const value = codes[0]?.rawValue?.trim();
        if (value) return value;
      }
      const result = await this.createZxingReader().decodeFromImageElement(image);
      const value = result.getText().trim();
      if (!value) throw new Error('未识别到条码。');
      return value;
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  private setStatus(message: string): void {
    const status = this.overlay?.querySelector<HTMLElement>('.scanner-status');
    if (status) status.textContent = message;
  }

  private async startZxing(stream: MediaStream, video: HTMLVideoElement, photoInput: HTMLInputElement, onResult: (result: ScanResult) => void): Promise<void> {
    const reader = this.createZxingReader();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };
      const timeout = window.setTimeout(() => {
        this.stop();
        finish(new Error('未识别到条码，请调整光线或改用手动输入。'));
      }, this.scanTimeoutMs);
      photoInput.addEventListener('change', () => {
        const file = photoInput.files?.[0];
        if (!file) return;
        this.decodeImageFile(file).then((value) => {
          onResult({ value, source: 'camera' });
          this.stop();
          finish();
        }).catch(() => this.setStatus('这张照片未识别到条码，请重新拍摄清晰盒面或继续实时扫描。'));
      });
      reader.decodeFromStream(stream, video, (result, error, controls) => {
        this.zxingControls = controls;
        if (!this.active) {
          finish();
          return;
        }
        const value = result?.getText().trim();
        if (value) {
          onResult({ value, source: 'camera' });
          this.stop();
          finish();
        } else if (error) {
          // ZXing emits ordinary per-frame errors while the camera is still
          // searching (NotFound, Checksum, Format, etc.). They are not fatal:
          // keep the preview open until a result, cancel, or timeout.
        }
      }).catch((error: unknown) => {
        this.stop();
        finish(error instanceof Error ? error : new Error('摄像头扫码失败，请改用扫描枪或手动输入。'));
      });
    });
  }

  stop(): void {
    this.active = false;
    this.zxingControls?.stop();
    this.zxingControls = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.overlay?.remove();
    this.overlay = null;
  }
}
