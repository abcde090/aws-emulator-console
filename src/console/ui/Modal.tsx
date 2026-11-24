"use client";

import { useEffect, useRef, type ReactNode } from "react";

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}

export function Modal({ title, onClose, children, footer, wide = false }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    ref.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-[rgba(0,7,22,0.55)] p-6 pt-20">
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`w-full ${wide ? "max-w-5xl" : "max-w-xl"} rounded-[2px] border border-line bg-white shadow-2xl outline-none`}
      >
        <div className="flex items-center justify-between border-b border-line-soft bg-shade px-5 py-3">
          <h2 className="text-[16px] font-bold text-ink">{title}</h2>
          <button type="button" aria-label="Close" className="rounded px-1.5 py-0.5 text-muted hover:bg-page hover:text-ink" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="space-y-4 px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line-soft bg-shade px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}
