"use client";

import { useEffect, useRef, useState } from "react";
import { buttonClass } from "./primitives.tsx";
import { useHydrated } from "./useHydrated.ts";

export interface MenuItem {
  id: string;
  label: string;
  danger?: boolean;
  disabled?: boolean;
}

export function ActionsMenu({ items, onSelect, disabled = false, label = "Actions" }: { items: MenuItem[]; onSelect: (id: string) => void; disabled?: boolean; label?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const hydrated = useHydrated();
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  if (items.length === 0) return null;
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        className={buttonClass("normal")}
        disabled={disabled || !hydrated}
        data-testid="actions-menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span>{label}</span>
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <ul role="menu" className="absolute right-0 z-30 mt-1 min-w-56 rounded-[2px] border border-line bg-white py-1 text-[13px] shadow-lg">
          {items.map((item) => (
            <li key={item.id} role="none">
              <button
                type="button"
                role="menuitem"
                disabled={item.disabled}
                className={`block w-full px-3.5 py-1.5 text-left transition-colors hover:bg-[#f2f8fd] disabled:text-[#aab7b8] ${item.danger ? "text-bad" : "text-ink"}`}
                onClick={() => {
                  setOpen(false);
                  onSelect(item.id);
                }}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
