import { useEffect, useRef, useState } from "react";

type CameraPhotoButtonProps = {
  label?: string;
  fileNamePrefix?: string;
  disabled?: boolean;
  onCapture: (file: File) => void | Promise<void>;
  onError?: (message: string) => void;
};

type VideoInputDevice = {
  deviceId: string;
  label: string;
};

const cameraUnavailableText =
  "当前浏览器无法调用摄像头，请确认已允许摄像头权限，或改用选择图片。";

export function CameraPhotoButton({
  label = "摄像头拍照",
  fileNamePrefix = "camera-photo",
  disabled = false,
  onCapture,
  onError,
}: CameraPhotoButtonProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deviceId, setDeviceId] = useState("");
  const [devices, setDevices] = useState<VideoInputDevice[]>([]);
  const [message, setMessage] = useState("");

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
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", 0.88),
      );
      if (!blob) throw new Error("blob unavailable");
      const file = new File([blob], `${fileNamePrefix}-${Date.now()}.jpg`, {
        type: "image/jpeg",
      });
      await onCapture(file);
      closeCamera();
    } catch {
      showError("拍照失败，请重新拍摄或改用选择图片。");
    } finally {
      setBusy(false);
    }
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
            <video
              ref={videoRef}
              className="camera-photo-video"
              autoPlay
              playsInline
              muted
            />
            <div className="camera-photo-controls">
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
              <button
                type="button"
                className="button"
                onClick={() => void captureFrame()}
                disabled={busy}
              >
                {busy ? "处理中…" : "拍照并使用"}
              </button>
            </footer>
          </div>
        </div>
      )}
    </>
  );
}
