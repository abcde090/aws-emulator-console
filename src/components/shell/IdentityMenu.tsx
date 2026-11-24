"use client";

import { useEffect, useRef, useState } from "react";
import { listIdentities } from "./actions";
import type { IdentityChoice, SwitchResult } from "@/lib/identity";

export interface IdentityView {
  type: "admin" | "user" | "role" | "invalid";
  name: string;
  arn: string;
  label: string;
  loadErrors: string[];
}

export type SwitchFn = (target: { type: "admin" } | { type: "user" | "role"; name: string }) => Promise<SwitchResult>;

export function IdentityMenu({ identity, switchIdentity }: { identity: IdentityView; switchIdentity: SwitchFn }) {
  const [open, setOpen] = useState(false);
  const [choices, setChoices] = useState<IdentityChoice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next) {
      setChoices(null);
      setError(null);
      const r = await listIdentities();
      if (r.ok) setChoices(r.data);
      else setError(r.error);
    }
  }

  async function choose(target: Parameters<SwitchFn>[0]) {
    setBusy(true);
    const r = await switchIdentity(target);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    window.location.reload();
  }

  function copyArn() {
    void navigator.clipboard?.writeText(identity.arn).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  const isCurrent = (c: IdentityChoice) => identity.type === c.type && identity.name === c.name;
  return (
    <div className="relative h-full" ref={ref}>
      <button
        type="button"
        className={`flex h-full items-center gap-1.5 px-3 text-[13px] font-medium transition-colors hover:bg-white/10 ${
          open ? "bg-white/15" : ""
        } ${identity.type !== "admin" ? "text-[#ff9900]" : "text-nav-text"}`}
        aria-expanded={open}
        onClick={() => void toggle()}
        data-testid="identity-button"
      >
        <span className="max-w-[180px] truncate">{identity.label}</span>
        <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div
          className="absolute right-0 top-[40px] z-50 w-96 border border-line bg-white text-ink shadow-2xl"
          role="menu"
          aria-label="Identity"
        >
          <div className="border-b border-line-soft bg-shade px-4 py-3">
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-bold tracking-wider text-muted uppercase">Account &amp; Identity</p>
              <span className="rounded bg-[#eaeded] px-1.5 py-0.5 font-mono text-[11px] text-ink">0000-0000-0000</span>
            </div>
            <div className="mt-1.5 flex items-start justify-between gap-2">
              <p className="font-mono text-[12px] font-semibold break-all text-ink">{identity.arn}</p>
              <button
                type="button"
                onClick={copyArn}
                className="shrink-0 rounded-[2px] border border-line bg-white px-1.5 py-0.5 text-[11px] text-muted hover:bg-shade hover:text-ink"
                title="Copy ARN"
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <p className="mt-1.5 text-[12px] leading-4 text-muted">
              {identity.type === "admin"
                ? "Emulator admin: every API call is allowed."
                : "Simulated identity: calls are evaluated against this identity's IAM policies before reaching the emulator."}
            </p>
          </div>
          <div className="p-3">
            <p className="mb-2 px-1 text-[11px] font-bold tracking-wider text-muted uppercase">Switch identity</p>
            {error && <p className="mb-2 px-1 text-[13px] text-bad">{error}</p>}
            {choices === null && !error && <p className="px-1 py-2 text-[13px] text-muted">Loading IAM users and roles…</p>}
            <ul className="max-h-72 space-y-0.5 overflow-auto">
              <li>
                <button
                  type="button"
                  disabled={busy || identity.type === "admin"}
                  className={`flex w-full items-center justify-between rounded-[2px] px-2.5 py-1.5 text-left text-[13px] transition-colors ${
                    identity.type === "admin" ? "bg-[#f2f8fd] font-semibold text-accent" : "hover:bg-shade"
                  }`}
                  onClick={() => void choose({ type: "admin" })}
                >
                  <span>Emulator admin</span>
                  {identity.type === "admin" && <span className="text-[11px] font-normal text-accent">current</span>}
                </button>
              </li>
              {choices?.length === 0 && (
                <li className="px-2.5 py-2 text-[12px] text-muted">No IAM users or roles exist yet. Create them in IAM first.</li>
              )}
              {choices?.map((c) => (
                <li key={`${c.type}:${c.name}`}>
                  <button
                    type="button"
                    disabled={busy || isCurrent(c)}
                    className={`flex w-full items-center justify-between rounded-[2px] px-2.5 py-1.5 text-left text-[13px] transition-colors ${
                      isCurrent(c) ? "bg-[#f2f8fd] font-semibold text-accent" : "hover:bg-shade"
                    }`}
                    onClick={() => void choose({ type: c.type, name: c.name })}
                  >
                    <span>
                      <span className="mr-1.5 rounded bg-[#eaeded] px-1.5 py-0.5 text-[11px] font-semibold text-muted uppercase">{c.type}</span>{" "}
                      {c.name}
                    </span>
                    {isCurrent(c) && <span className="text-[11px] font-normal text-accent">current</span>}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
