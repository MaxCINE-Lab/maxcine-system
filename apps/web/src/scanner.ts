import { BrowserMultiFormatReader, type IScannerControls } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';
import {
  canAcceptScan,
  MultiFrameConsensus,
  parseScannedValue,
  WAREHOUSE_SCANNER_FORMATS,
  type ScannerSymbology
} from '@maxcine/shared';

export type ScanResult = { value: string; source: 'camera' | 'manual'; raw: string; format: ScannerSymbology; kind: string };

export type ScannerStartOptions = {
  continuous?: boolean;
  validate?: (result: ScanResult) => Promise<void> | void;
};

export interface BarcodeScannerAdapter {
  isSupported(): boolean;
  start(onResult: (result: ScanResult) => void, options?: ScannerStartOptions): Promise<void>;
  stop(): void;
}

type BarcodeDetectorLike = {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string; format?: string }>>;
};

type BarcodeDetectorConstructor = new (options?: { formats?: string[] }) => BarcodeDetectorLike;
type SupportedBarcodeDetectorConstructor = BarcodeDetectorConstructor & {
  getSupportedFormats?: () => Promise<string[]>;
};

declare global {
  interface Window {
    BarcodeDetector?: BarcodeDetectorConstructor;
  }
}

const detectorFormats = WAREHOUSE_SCANNER_FORMATS.filter((format) => format !== 'unknown');

function detectorFormat(format?: string): ScannerSymbology {
  if (!format) return 'unknown';
  const normalized = format.toLowerCase().replace('-', '_') as ScannerSymbology;
  return WAREHOUSE_SCANNER_FORMATS.includes(normalized) ? normalized : 'unknown';
}

function zxingFormat(format: BarcodeFormat | undefined): ScannerSymbology {
  switch (format) {
    case BarcodeFormat.EAN_13: return 'ean_13';
    case BarcodeFormat.EAN_8: return 'ean_8';
    case BarcodeFormat.CODE_128: return 'code_128';
    case BarcodeFormat.CODE_39: return 'code_39';
    case BarcodeFormat.UPC_A: return 'upc_a';
    case BarcodeFormat.UPC_E: return 'upc_e';
    case BarcodeFormat.ITF: return 'itf';
    case BarcodeFormat.QR_CODE: return 'qr_code';
    case BarcodeFormat.DATA_MATRIX: return 'data_matrix';
    default: return 'unknown';
  }
}

function feedbackSuccess(): void {
  try {
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = 880;
    gain.gain.value = 0.035;
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    window.setTimeout(() => {
      oscillator.stop();
      void context.close();
    }, 78);
  } catch {
    // Audio feedback is optional.
  }
  navigator.vibrate?.(45);
}

export class BrowserBarcodeScanner implements BarcodeScannerAdapter {
  private stream: MediaStream | null = null;
  private overlay: HTMLDivElement | null = null;
  private active = false;
  private zxingControls: IScannerControls | null = null;
  private readonly scanTimeoutMs = 90000;
  private readonly acceptedAt: Record<string, number> = {};
  private torchEnabled = false;
  private committed = false;

  isSupported(): boolean {
    return Boolean(navigator.mediaDevices?.getUserMedia);
  }

  async start(onResult: (result: ScanResult) => void, options: ScannerStartOptions = {}): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前设备无法使用摄像头，请改用扫描枪或手动输入。');
    this.stop();
    this.committed = false;
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    this.stream = stream;
    this.active = true;

    const overlay = document.createElement('div');
    overlay.className = 'scanner-overlay';
    overlay.innerHTML = `
      <div class="scanner-dialog" role="dialog" aria-modal="true" aria-label="摄像头扫码">
        <header class="scanner-header">
          <strong>扫描条形码或二维码</strong>
          <button type="button" class="scanner-torch" hidden>闪光灯</button>
        </header>
        <video class="scanner-video" autoplay playsinline muted></video>
        <div class="scanner-frame"><span></span></div>
        <p class="scanner-status">请将条形码或二维码放入中央扫描框，系统会自动识别并进行多帧确认。</p>
        <div class="scanner-mode-row"><b>摄像头扫码</b><span>扫描枪</span><span>手动输入</span></div>
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
    const torch = overlay.querySelector<HTMLButtonElement>('.scanner-torch');
    if (!video || !cancel || !photoInput || !torch) {
      this.stop();
      throw new Error('摄像头扫码窗口初始化失败。');
    }
    video.srcObject = stream;
    cancel.addEventListener('click', () => this.stop(), { once: true });
    this.setupTorch(torch);
    await video.play();

    const detector = await this.createNativeDetector();
    if (!detector) {
      this.setStatus('当前浏览器未提供原生识别，将使用兼容识别模式。');
      await this.startZxing(stream, video, photoInput, onResult, options);
      return;
    }

    await this.startDetector(detector, video, photoInput, onResult, options);
  }

  private async createNativeDetector(): Promise<BarcodeDetectorLike | null> {
    if (!window.BarcodeDetector) return null;
    const detectorConstructor = window.BarcodeDetector as SupportedBarcodeDetectorConstructor;
    try {
      const supported = await detectorConstructor.getSupportedFormats?.();
      const formats = supported?.length ? detectorFormats.filter((format) => supported.includes(format)) : detectorFormats;
      if (!formats.length) return null;
      return new window.BarcodeDetector({ formats });
    } catch {
      return null;
    }
  }

  private setupTorch(button: HTMLButtonElement): void {
    const track = this.stream?.getVideoTracks()[0];
    const capabilities = track?.getCapabilities?.() as MediaTrackCapabilities & { torch?: boolean } | undefined;
    if (!track || !capabilities?.torch) return;
    button.hidden = false;
    button.addEventListener('click', () => {
      this.torchEnabled = !this.torchEnabled;
      void track.applyConstraints({ advanced: [{ torch: this.torchEnabled } as MediaTrackConstraintSet] }).catch(() => {
        this.torchEnabled = false;
        this.setStatus('当前摄像头无法开启闪光灯。');
      });
      button.classList.toggle('is-on', this.torchEnabled);
    });
  }

  private createZxingReader(): BrowserMultiFormatReader {
    const hints = new Map<DecodeHintType, unknown>();
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [
      BarcodeFormat.CODE_128,
      BarcodeFormat.CODE_39,
      BarcodeFormat.EAN_13,
      BarcodeFormat.EAN_8,
      BarcodeFormat.UPC_A,
      BarcodeFormat.UPC_E,
      BarcodeFormat.ITF,
      BarcodeFormat.QR_CODE,
      BarcodeFormat.DATA_MATRIX
    ]);
    hints.set(DecodeHintType.TRY_HARDER, true);
    hints.set(DecodeHintType.CHARACTER_SET, 'UTF-8');
    return new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 100 });
  }

  private async emitCandidate(raw: string, format: ScannerSymbology, source: 'camera' | 'manual', onResult: (result: ScanResult) => void, options: ScannerStartOptions): Promise<boolean> {
    if (this.committed && !options.continuous) return true;
    const parsed = parseScannedValue(raw, format);
    if (!parsed.ok) {
      this.setStatus(parsed.reason);
      return false;
    }
    if (!canAcceptScan(this.acceptedAt, parsed.value)) {
      this.setStatus(`已识别 ${parsed.value}，正在防重复录入。`);
      return false;
    }
    const result: ScanResult = { value: parsed.value, source, raw: parsed.raw, format: parsed.format, kind: parsed.kind };
    try {
      await options.validate?.(result);
    } catch (error) {
      this.setStatus(error instanceof Error ? error.message : '业务校验未通过，未录入。');
      return false;
    }
    if (this.committed && !options.continuous) return true;
    if (!options.continuous) this.committed = true;
    this.overlay?.querySelector('.scanner-frame')?.classList.add('scanner-frame--success');
    this.setStatus(`已识别：${parsed.value}`);
    feedbackSuccess();
    onResult(result);
    window.setTimeout(() => this.overlay?.querySelector('.scanner-frame')?.classList.remove('scanner-frame--success'), 650);
    if (!options.continuous) {
      this.stop();
    }
    return true;
  }

  private scheduleCandidateFallback(
    state: { value: string; raw: string; format: ScannerSymbology; timer: number | null },
    raw: string,
    format: ScannerSymbology,
    value: string,
    onResult: (result: ScanResult) => void,
    options: ScannerStartOptions,
    onAccepted: () => void
  ): void {
    if (options.continuous || this.committed) return;
    if (state.value !== value) {
      if (state.timer !== null) window.clearTimeout(state.timer);
      state.value = value;
      state.raw = raw;
      state.format = format;
      state.timer = window.setTimeout(() => {
        state.timer = null;
        if (!this.active || this.committed) return;
        this.setStatus(`已稳定识别：${value}，正在自动录入…`);
        void this.emitCandidate(state.raw, state.format, 'camera', onResult, options).then((accepted) => {
          if (accepted) onAccepted();
        });
      }, 900);
      return;
    }
    state.raw = raw;
    state.format = format;
  }

  private async startDetector(detector: BarcodeDetectorLike, video: HTMLVideoElement, photoInput: HTMLInputElement, onResult: (result: ScanResult) => void, options: ScannerStartOptions): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let pending = false;
      const consensus = new MultiFrameConsensus();
      const fallback = { value: '', raw: '', format: 'unknown' as ScannerSymbology, timer: null as number | null };
      const startedAt = Date.now();
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d', { willReadFrequently: true });
      const finish = (error?: Error) => {
        if (fallback.timer !== null) window.clearTimeout(fallback.timer);
        if (error) reject(error);
        else resolve();
      };
      photoInput.addEventListener('change', () => {
        const file = photoInput.files?.[0];
        if (!file) return;
        this.decodeImageFile(file, detector).then((result) => this.emitCandidate(result.raw, result.format, 'camera', onResult, options)).catch(() => this.setStatus('这张照片未识别到可用条形码或二维码，请重新拍摄清晰盒面或继续实时扫描。'));
      });
      const tick = () => {
        if (!this.active) return finish();
        if (Date.now() - startedAt > this.scanTimeoutMs) {
          this.stop();
          return finish(new Error('未识别到条形码或二维码，请调整光线或改用扫描枪、手动输入。'));
        }
        if (!pending && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          pending = true;
          const roi = this.drawRoi(video, canvas, context);
          detector.detect(roi).then(async (codes) => {
            pending = false;
            const candidate = codes[0];
            const raw = candidate?.rawValue?.trim();
            if (raw) {
              const format = detectorFormat(candidate.format);
              const parsed = parseScannedValue(raw, format);
              if (parsed.ok) {
                const confirmed = consensus.push(parsed.value);
                this.scheduleCandidateFallback(fallback, raw, format, parsed.value, onResult, options, finish);
                this.setStatus(confirmed ? '多帧确认成功，正在校验…' : `识别候选：${parsed.value}，请保持稳定。`);
                if (confirmed) {
                  consensus.reset();
                  if (await this.emitCandidate(raw, format, 'camera', onResult, options)) return finish();
                }
              } else {
                this.setStatus(parsed.reason);
              }
            }
            requestAnimationFrame(tick);
          }).catch((error: unknown) => {
            this.stop();
            finish(error instanceof Error ? error : new Error('摄像头扫码失败。'));
          });
        } else {
          requestAnimationFrame(tick);
        }
      };
      requestAnimationFrame(tick);
    });
  }

  private drawRoi(video: HTMLVideoElement, canvas: HTMLCanvasElement, context: CanvasRenderingContext2D | null): CanvasImageSource {
    if (!context || !video.videoWidth || !video.videoHeight) return video;
    const sourceW = video.videoWidth;
    const sourceH = video.videoHeight;
    const roiW = Math.round(sourceW * 0.82);
    const roiH = Math.round(sourceH * 0.68);
    const sx = Math.round((sourceW - roiW) / 2);
    const sy = Math.round((sourceH - roiH) / 2);
    canvas.width = roiW;
    canvas.height = roiH;
    context.drawImage(video, sx, sy, roiW, roiH, 0, 0, roiW, roiH);
    return canvas;
  }

  private async decodeImageFile(file: File, detector?: BarcodeDetectorLike): Promise<{ raw: string; format: ScannerSymbology }> {
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
        if (value) return { raw: value, format: detectorFormat(codes[0]?.format) };
      }
      const result = await this.createZxingReader().decodeFromImageElement(image);
      const value = result.getText().trim();
      if (!value) throw new Error('未识别到条码。');
      return { raw: value, format: zxingFormat(result.getBarcodeFormat()) };
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  private setStatus(message: string): void {
    const status = this.overlay?.querySelector<HTMLElement>('.scanner-status');
    if (status) status.textContent = message;
  }

  private async startZxing(stream: MediaStream, video: HTMLVideoElement, photoInput: HTMLInputElement, onResult: (result: ScanResult) => void, options: ScannerStartOptions): Promise<void> {
    const reader = this.createZxingReader();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const consensus = new MultiFrameConsensus();
      const fallback = { value: '', raw: '', format: 'unknown' as ScannerSymbology, timer: null as number | null };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (fallback.timer !== null) window.clearTimeout(fallback.timer);
        window.clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };
      const timeout = window.setTimeout(() => {
        this.stop();
        finish(new Error('未识别到条形码或二维码，请调整光线或改用扫描枪、手动输入。'));
      }, this.scanTimeoutMs);
      photoInput.addEventListener('change', () => {
        const file = photoInput.files?.[0];
        if (!file) return;
        this.decodeImageFile(file).then((result) => this.emitCandidate(result.raw, result.format, 'camera', onResult, options)).catch(() => this.setStatus('这张照片未识别到可用条形码或二维码，请重新拍摄清晰盒面或继续实时扫描。'));
      });
      reader.decodeFromStream(stream, video, (result, error, controls) => {
        this.zxingControls = controls;
        if (!this.active) {
          finish();
          return;
        }
        const raw = result?.getText().trim();
        if (raw) {
          const format = zxingFormat(result?.getBarcodeFormat());
          const parsed = parseScannedValue(raw, format);
          if (!parsed.ok) return this.setStatus(parsed.reason);
          const confirmed = consensus.push(parsed.value);
          this.scheduleCandidateFallback(fallback, raw, format, parsed.value, onResult, options, finish);
          this.setStatus(confirmed ? '多帧确认成功，正在校验…' : `识别候选：${parsed.value}，请保持稳定。`);
          if (confirmed) {
            consensus.reset();
            void this.emitCandidate(raw, format, 'camera', onResult, options).then((accepted) => {
              if (accepted) finish();
            });
          }
        } else if (error) {
          // ZXing reports ordinary per-frame misses while searching.
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
