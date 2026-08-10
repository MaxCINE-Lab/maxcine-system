import { useEffect, useRef, useState, type PointerEvent } from "react";

type CameraPhotoButtonProps = {
  label?: string;
  fileNamePrefix?: string;
  watermarkLines?: string[];
  disabled?: boolean;
  onCapture: (file: File) => void | Promise<void>;
  onError?: (message: string) => void;
};

type VideoInputDevice = {
  deviceId: string;
  label: string;
};

type AnnotationTool = "none" | "rect" | "arrow";
type Annotation = {
  id: string;
  type: "rect" | "arrow";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};
type CapturedImage = {
  dataUrl: string;
  width: number;
  height: number;
};

const cameraUnavailableText =
  "当前浏览器无法调用摄像头，请确认已允许摄像头权限，或改用选择图片。";

const formatCaptureTime = (value: Date) => {
  const pad = (input: number) => String(input).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
};

export function CameraPhotoButton({
  label = "摄像头拍照",
  fileNamePrefix = "camera-photo",
  watermarkLines = [],
  disabled = false,
  onCapture,
  onError,
}: CameraPhotoButtonProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deviceId, setDeviceId] = useState("");
  const [devices, setDevices] = useState<VideoInputDevice[]>([]);
  const [message, setMessage] = useState("");
  const [captured, setCaptured] = useState<CapturedImage | null>(null);
  const [tool, setTool] = useState<AnnotationTool>("none");
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [draftAnnotation, setDraftAnnotation] = useState<Annotation | null>(null);

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  };

  const showError = (text: string) => {
    setMessage(text);
    onError?.(text);
  };

  const loadDevices = async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const list = await navigator.mediaDevices.enumerateDevices();
    setDevices(
      list
        .filter((item) => item.kind === "videoinput")
        .map((item, index) => ({
          deviceId: item.deviceId,
          label: item.label || `摄像头 ${index + 1}`,
        })),
    );
  };

  const startCamera = async (nextDeviceId = deviceId) => {
    if (!navigator.mediaDevices?.getUserMedia) {
      showError(cameraUnavailableText);
      return;
    }
    setBusy(true);
    setMessage("正在打开摄像头…");
    try {
      stopCamera();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          deviceId: nextDeviceId ? { exact: nextDeviceId } : undefined,
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          facingMode: nextDeviceId ? undefined : { ideal: "environment" },
        },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      await loadDevices();
      setMessage("摄像头已打开，请对准需要拍摄的位置。");
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "";
      const text =
        name === "NotAllowedError"
          ? "摄像头权限被拒绝，请在浏览器地址栏允许摄像头访问。"
          : name === "NotFoundError"
            ? "没有检测到可用摄像头，请确认外置摄像头已连接并处于摄像头模式。"
            : cameraUnavailableText;
      showError(text);
      stopCamera();
    } finally {
      setBusy(false);
    }
  };

  const openCamera = () => {
    setOpen(true);
    setMessage("");
  };

  const closeCamera = () => {
    stopCamera();
    setOpen(false);
    setBusy(false);
    setMessage("");
    setCaptured(null);
    setTool("none");
    setAnnotations([]);
    setDraftAnnotation(null);
  };

  const captureFrame = async () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) {
      showError("摄像头画面还未准备好，请稍等一秒后再拍照。");
      return;
    }
    setBusy(true);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("canvas unavailable");
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      if (watermarkLines.length) {
        const lines = [formatCaptureTime(new Date()), ...watermarkLines];
        const padding = Math.max(22, Math.round(canvas.width * 0.026));
        const fontSize = Math.max(22, Math.round(canvas.width * 0.03));
        const lineHeight = Math.round(fontSize * 1.35);
        context.save();
        context.globalAlpha = 0.5;
        context.fillStyle = "rgb(229, 231, 235)";
        context.shadowColor = "rgb(17, 24, 39)";
        context.shadowBlur = Math.max(2, Math.round(fontSize * 0.18));
        context.shadowOffsetX = 1;
        context.shadowOffsetY = 1;
        context.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", sans-serif`;
        context.textBaseline = "bottom";
        const startY = canvas.height - padding - lineHeight * (lines.length - 1);
        lines.forEach((line, index) => {
          context.fillText(line, padding, startY + index * lineHeight);
        });
        context.restore();
      }
      setCaptured({
        dataUrl: canvas.toDataURL("image/jpeg", 0.9),
        width: canvas.width,
        height: canvas.height,
      });
      setAnnotations([]);
      setDraftAnnotation(null);
      setTool("rect");
      setMessage("照片已生成，可预览水印并添加红框或红箭头。");
      stopCamera();
    } catch {
      showError("拍照失败，请重新拍摄或改用选择图片。");
    } finally {
      setBusy(false);
    }
  };

  const pointFromEvent = (event: PointerEvent<HTMLDivElement>) => {
    if (!captured || !previewRef.current) return null;
    const rect = previewRef.current.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(captured.width, ((event.clientX - rect.left) / rect.width) * captured.width)),
      y: Math.max(0, Math.min(captured.height, ((event.clientY - rect.top) / rect.height) * captured.height)),
    };
  };

  const beginAnnotation = (event: PointerEvent<HTMLDivElement>) => {
    if (!captured || tool === "none") return;
    const point = pointFromEvent(event);
    if (!point) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDraftAnnotation({
      id: `${tool}-${Date.now()}`,
      type: tool,
      x1: point.x,
      y1: point.y,
      x2: point.x,
      y2: point.y,
    });
  };

  const moveAnnotation = (event: PointerEvent<HTMLDivElement>) => {
    if (!draftAnnotation) return;
    const point = pointFromEvent(event);
    if (!point) return;
    setDraftAnnotation({ ...draftAnnotation, x2: point.x, y2: point.y });
  };

  const finishAnnotation = () => {
    if (!draftAnnotation) return;
    const dx = Math.abs(draftAnnotation.x2 - draftAnnotation.x1);
    const dy = Math.abs(draftAnnotation.y2 - draftAnnotation.y1);
    if (dx > 8 || dy > 8) setAnnotations((current) => [...current, draftAnnotation]);
    setDraftAnnotation(null);
  };

  const drawArrow = (context: CanvasRenderingContext2D, annotation: Annotation) => {
    const angle = Math.atan2(annotation.y2 - annotation.y1, annotation.x2 - annotation.x1);
    const headLength = Math.max(22, Math.round(Math.max(context.canvas.width, context.canvas.height) * 0.018));
    context.beginPath();
    context.moveTo(annotation.x1, annotation.y1);
    context.lineTo(annotation.x2, annotation.y2);
    context.lineTo(
      annotation.x2 - headLength * Math.cos(angle - Math.PI / 6),
      annotation.y2 - headLength * Math.sin(angle - Math.PI / 6),
    );
    context.moveTo(annotation.x2, annotation.y2);
    context.lineTo(
      annotation.x2 - headLength * Math.cos(angle + Math.PI / 6),
      annotation.y2 - headLength * Math.sin(angle + Math.PI / 6),
    );
    context.stroke();
  };

  const saveCapturedImage = async () => {
    if (!captured) return;
    setBusy(true);
    try {
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("preview image unavailable"));
        image.src = captured.dataUrl;
      });
      const canvas = document.createElement("canvas");
      canvas.width = captured.width;
      canvas.height = captured.height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("canvas unavailable");
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const finalAnnotations = draftAnnotation ? [...annotations, draftAnnotation] : annotations;
      context.save();
      context.strokeStyle = "#ef1111";
      context.lineWidth = Math.max(6, Math.round(canvas.width * 0.006));
      context.lineCap = "round";
      context.lineJoin = "round";
      finalAnnotations.forEach((annotation) => {
        if (annotation.type === "rect") {
          context.strokeRect(
            Math.min(annotation.x1, annotation.x2),
            Math.min(annotation.y1, annotation.y2),
            Math.abs(annotation.x2 - annotation.x1),
            Math.abs(annotation.y2 - annotation.y1),
          );
        } else {
          drawArrow(context, annotation);
        }
      });
      context.restore();
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", 0.9),
      );
      if (!blob) throw new Error("blob unavailable");
      const file = new File([blob], `${fileNamePrefix}-${Date.now()}.jpg`, {
        type: "image/jpeg",
      });
      await onCapture(file);
      closeCamera();
    } catch {
      showError("照片保存失败，请重新拍摄或改用选择图片。");
    } finally {
      setBusy(false);
    }
  };

  const retake = () => {
    setCaptured(null);
    setAnnotations([]);
    setDraftAnnotation(null);
    setTool("none");
    void startCamera();
  };

  useEffect(() => {
    if (open) void startCamera();
    return () => stopCamera();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <>
      <button
        type="button"
        className="button button--secondary camera-photo-trigger"
        disabled={disabled}
        onClick={openCamera}
      >
        {label}
      </button>
      {open && (
        <div className="camera-photo-backdrop" role="dialog" aria-modal="true">
          <div className="camera-photo-dialog">
            <header className="camera-photo-header">
              <div>
                <h2>摄像头拍照</h2>
                <p>可选择电脑内置摄像头、外置网络摄像头或有线连接的摄像头。</p>
              </div>
              <button type="button" onClick={closeCamera} aria-label="关闭拍照">
                ×
              </button>
            </header>
            {captured ? (
              <div className="camera-photo-preview-wrap">
                <div
                  ref={previewRef}
                  className={`camera-photo-preview ${tool !== "none" ? "is-drawing" : ""}`}
                  onPointerDown={beginAnnotation}
                  onPointerMove={moveAnnotation}
                  onPointerUp={finishAnnotation}
                  onPointerCancel={finishAnnotation}
                >
                  <img src={captured.dataUrl} alt="拍照预览" draggable={false} />
                  <svg viewBox={`0 0 ${captured.width} ${captured.height}`} aria-hidden="true">
                    {[...annotations, ...(draftAnnotation ? [draftAnnotation] : [])].map((annotation) =>
                      annotation.type === "rect" ? (
                        <rect
                          key={annotation.id}
                          x={Math.min(annotation.x1, annotation.x2)}
                          y={Math.min(annotation.y1, annotation.y2)}
                          width={Math.abs(annotation.x2 - annotation.x1)}
                          height={Math.abs(annotation.y2 - annotation.y1)}
                        />
                      ) : (
                        <line
                          key={annotation.id}
                          x1={annotation.x1}
                          y1={annotation.y1}
                          x2={annotation.x2}
                          y2={annotation.y2}
                          markerEnd="url(#camera-arrow-head)"
                        />
                      ),
                    )}
                    <defs>
                      <marker id="camera-arrow-head" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto" markerUnits="strokeWidth">
                        <path d="M2,2 L10,6 L2,10 Z" />
                      </marker>
                    </defs>
                  </svg>
                </div>
              </div>
            ) : (
              <video
                ref={videoRef}
                className="camera-photo-video"
                autoPlay
                playsInline
                muted
              />
            )}
            <div className="camera-photo-controls">
              {!captured ? (
                <label>
                  摄像头
                  <select
                    value={deviceId}
                    onChange={(event) => {
                      const next = event.target.value;
                      setDeviceId(next);
                      void startCamera(next);
                    }}
                  >
                    <option value="">自动选择</option>
                    {devices.map((item) => (
                      <option key={item.deviceId} value={item.deviceId}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <div className="camera-annotation-tools" role="group" aria-label="照片标注工具">
                  <button type="button" className={tool === "rect" ? "is-active" : ""} onClick={() => setTool("rect")}>红色方框</button>
                  <button type="button" className={tool === "arrow" ? "is-active" : ""} onClick={() => setTool("arrow")}>红色箭头</button>
                  <button type="button" onClick={() => setTool("none")}>移动/查看</button>
                  <button type="button" onClick={() => { setAnnotations([]); setDraftAnnotation(null); }}>清除标注</button>
                </div>
              )}
              <p>{message || "打开后请确认画面清晰，再点击拍照。"}</p>
            </div>
            <footer className="camera-photo-actions">
              <button
                type="button"
                className="button button--secondary"
                onClick={closeCamera}
                disabled={busy}
              >
                取消
              </button>
              {captured && (
                <button
                  type="button"
                  className="button button--secondary"
                  onClick={retake}
                  disabled={busy}
                >
                  重新拍摄
                </button>
              )}
              <button
                type="button"
                className="button"
                onClick={() => void (captured ? saveCapturedImage() : captureFrame())}
                disabled={busy}
              >
                {busy ? "处理中…" : captured ? "保存并使用" : "拍照"}
              </button>
            </footer>
          </div>
        </div>
      )}
    </>
  );
}
