"use client";

import { AlertTriangle, X } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

function createClientIdempotencyKey(prefix: string): string {
  const rand =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replace(/-/g, "")
      : `${String(Date.now())}_${Math.random().toString(36).slice(2, 12)}`;
  return `${prefix}_${rand}`.slice(0, 96);
}

export interface DangerConfirmDialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  readonly tone?: "primary" | "danger";
  readonly intentPrefix?: string;
  readonly children?: ReactNode;
  readonly onClose: () => void;
  readonly onConfirm: (idempotencyKey: string) => Promise<void>;
}

export function DangerConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = "Annulla",
  tone = "primary",
  intentPrefix = "idem_ui",
  children,
  onClose,
  onConfirm,
}: DangerConfirmDialogProps) {
  const titleId = useId();
  const descId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const cancelBtnRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  // Retained stable Idempotency-Key per user intent (AC-020):
  // If a transient network error occurs and the user clicks confirm again in the same open modal,
  // the exact same Idempotency-Key is reused so upstream never creates duplicate operations.
  const [idempotencyKey, setIdempotencyKey] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setIdempotencyKey(createClientIdempotencyKey(intentPrefix));
    setErrorMessage(null);
    setSubmitting(false);

    const focusTimer = setTimeout(() => {
      cancelBtnRef.current?.focus();
    }, 0);

    return () => {
      clearTimeout(focusTimer);
      previousFocusRef.current?.focus();
    };
  }, [open, intentPrefix]);

  if (!open) {
    return null;
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape" && !submitting) {
      event.stopPropagation();
      onClose();
      return;
    }

    if (event.key === "Tab" && dialogRef.current) {
      const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) {
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first && last) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last && first) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  const handleConfirmClick = async (): Promise<void> => {
    if (submitting) {
      return;
    }
    const stableKey = idempotencyKey || createClientIdempotencyKey(intentPrefix);
    if (!idempotencyKey) {
      setIdempotencyKey(stableKey);
    }
    setSubmitting(true);
    setErrorMessage(null);

    try {
      await onConfirm(stableKey);
      onClose();
    } catch (err: unknown) {
      const msg =
        err instanceof Error
          ? err.message
          : "Errore imprevisto durante l'invio dell'operazione. Puoi riprovare in sicurezza.";
      setErrorMessage(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const confirmBtnClasses =
    tone === "danger"
      ? "bg-rose-600 text-white hover:bg-rose-700 focus-visible:outline-rose-600"
      : "bg-indigo-600 text-white hover:bg-indigo-700 focus-visible:outline-indigo-600";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4 backdrop-blur-[1px]"
      onKeyDown={handleKeyDown}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !submitting) {
          onClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-xl"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span
              className={`inline-flex h-9 w-9 items-center justify-center rounded-lg ${
                tone === "danger"
                  ? "bg-rose-100 text-rose-700"
                  : "bg-indigo-100 text-indigo-700"
              }`}
            >
              <AlertTriangle className="h-5 w-5" aria-hidden="true" />
            </span>
            <h2 id={titleId} className="text-base font-semibold text-slate-900">
              {title}
            </h2>
          </div>
          <button
            type="button"
            disabled={submitting}
            onClick={onClose}
            aria-label="Chiudi finestra di conferma"
            className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p id={descId} className="mt-3 text-sm leading-relaxed text-slate-600">
          {description}
        </p>

        {children && <div className="mt-4">{children}</div>}

        {errorMessage && (
          <div
            role="alert"
            className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900"
          >
            <p className="font-semibold">Operazione non avviata</p>
            <p className="mt-0.5">{errorMessage}</p>
            <p className="mt-1 text-[11px] text-rose-700">
              Chiave idempotenza mantenuta (<code>{idempotencyKey}</code>): puoi
              riprovare senza rischio di duplicazioni.
            </p>
          </div>
        )}

        <div className="mt-6 flex items-center justify-end gap-2.5">
          <button
            ref={cancelBtnRef}
            type="button"
            disabled={submitting}
            onClick={onClose}
            className="rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => {
              void handleConfirmClick();
            }}
            className={`rounded-lg px-4 py-2 text-sm font-semibold shadow-xs focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50 ${confirmBtnClasses}`}
          >
            {submitting ? "Invio in corso..." : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
