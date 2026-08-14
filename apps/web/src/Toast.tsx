/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

type ToastTone = 'success' | 'error' | 'warning' | 'info';
type ToastItem = { id: string; tone: ToastTone; text: string };
type ToastInput = { tone?: ToastTone; text: string };

const ToastContext = createContext<((toast: ToastInput) => void) | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((toast: ToastInput) => {
    const normalized = toast.text.trim();
    if (!normalized) return;
    const id = crypto.randomUUID();
    setItems((current) => [{ id, tone: toast.tone ?? 'info', text: normalized }, ...current.filter((item) => item.text !== normalized).slice(0, 3)]);
    window.setTimeout(() => setItems((current) => current.filter((item) => item.id !== id)), toast.tone === 'error' ? 5200 : 3600);
  }, []);
  const value = useMemo(() => push, [push]);
  return <ToastContext.Provider value={value}>{children}<div className="toast-stack" aria-live="polite" aria-atomic="false">{items.map((item) => <div className={`toast toast--${item.tone}`} role={item.tone === 'error' ? 'alert' : 'status'} key={item.id}><span>{item.tone === 'success' ? '✓' : item.tone === 'error' ? '✕' : item.tone === 'warning' ? '!' : 'i'}</span><p>{item.text}</p><button type="button" aria-label="关闭提示" onClick={() => setItems((current) => current.filter((row) => row.id !== item.id))}>×</button></div>)}</div></ToastContext.Provider>;
}

export function useToast() {
  const push = useContext(ToastContext);
  return push ?? (() => undefined);
}
