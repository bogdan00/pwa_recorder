import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useOptionalAppNavigation } from '../navigation/AppNavigationContext';
import { ConfirmDialog } from './ConfirmDialog';

export interface ConfirmRequest {
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: 'danger' | 'warning';
  onConfirm: () => Promise<void> | void;
}

type ConfirmFn = (req: ConfirmRequest) => void;

const ConfirmContext = createContext<ConfirmFn | null>(null);

export const ConfirmProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const nav = useOptionalAppNavigation();
  const navRef = useRef(nav);
  navRef.current = nav;

  const [pending, setPending] = useState<ConfirmRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const transientIdRef = useRef<string | null>(null);

  const dismissHistoryToken = useCallback(() => {
    const id = transientIdRef.current;
    if (!id) return;
    transientIdRef.current = null;
    navRef.current?.dismissTransient(id);
  }, []);

  useEffect(() => {
    return () => {
      transientIdRef.current = null;
    };
  }, []);

  const confirm = useCallback(
    (req: ConfirmRequest) => {
      if (transientIdRef.current) {
        navRef.current?.dismissTransient(transientIdRef.current);
        transientIdRef.current = null;
      }
      setPending(req);
      if (navRef.current) {
        transientIdRef.current = navRef.current.pushTransient('confirm', () => {
          transientIdRef.current = null;
          setPending(null);
          setBusy(false);
        });
      }
    },
    [],
  );

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <ConfirmDialog
        open={pending !== null}
        title={pending?.title ?? ''}
        description={pending?.description ?? ''}
        confirmLabel={pending?.confirmLabel ?? 'Confirm'}
        cancelLabel={pending?.cancelLabel}
        tone={pending?.tone ?? 'danger'}
        isBusy={busy}
        onCancel={() => {
          setPending(null);
          dismissHistoryToken();
        }}
        onConfirm={async () => {
          if (!pending) return;
          setBusy(true);
          try {
            await pending.onConfirm();
            setPending(null);
            dismissHistoryToken();
          } finally {
            setBusy(false);
          }
        }}
      />
    </ConfirmContext.Provider>
  );
};

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) {
    throw new Error('useConfirm must be used within ConfirmProvider');
  }
  return ctx;
}
