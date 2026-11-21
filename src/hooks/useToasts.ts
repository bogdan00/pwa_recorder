import { useCallback, useEffect, useRef, useState } from 'react';
import { createId } from '../utils/format';

export interface ToastItem {
  id: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}

export function useToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timersRef = useRef<Map<string, number>>(new Map());

  const showToast = useCallback(
    (message: string, actionLabel?: string, onAction?: () => void) => {
      const id = createId('toast');
      setToasts((prev) => [
        ...prev.slice(-2),
        { id, message, actionLabel, onAction },
      ]);
      const timer = window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
        timersRef.current.delete(id);
      }, 4200);
      timersRef.current.set(id, timer);
    },
    [],
  );

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, []);

  return { toasts, showToast };
}
