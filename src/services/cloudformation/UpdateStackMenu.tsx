"use client";

/**
 * The stack page's "Update stack" button: like the console, it offers a direct update
 * (UpdateStack wizard) or a change set (preview the changes first).
 */

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { buttonClass } from "@/console/ui/primitives";

export function UpdateStackMenu({ stack }: { stack: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const base = `/cloudformation/stacks/${encodeURIComponent(stack)}`;
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
  return (
    <div className="relative" ref={ref}>
      <button type="button" className={buttonClass("normal")} data-testid="update-stack-menu" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span>Update stack</span>
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <ul role="menu" className="absolute right-0 z-30 mt-1 min-w-56 rounded-[2px] border border-line bg-white py-1 text-[13px] shadow-lg">
          <li role="none">
            <Link role="menuitem" href={`${base}/update`} className="block px-3.5 py-1.5 text-ink hover:bg-[#f2f8fd]">
              Make a direct update
            </Link>
          </li>
          <li role="none">
            <Link role="menuitem" href={`${base}/changesets/create`} className="block px-3.5 py-1.5 text-ink hover:bg-[#f2f8fd]">
              Create a change set
            </Link>
          </li>
        </ul>
      )}
    </div>
  );
}
