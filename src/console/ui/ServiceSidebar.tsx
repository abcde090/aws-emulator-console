"use client";

import Link from "next/link";
import { useState } from "react";
import type { ServiceMeta } from "../types.ts";
import { ServiceIcon } from "@/components/shell/ServiceIcon";

interface ServiceSidebarProps {
  meta: ServiceMeta;
  activeResource?: string;
}

export function ServiceSidebar({ meta, activeResource }: ServiceSidebarProps) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside
      aria-label={`${meta.name} navigation`}
      className={`sticky top-[72px] hidden h-[calc(100vh-72px)] shrink-0 flex-col self-start border-r border-line bg-white transition-all duration-150 md:flex ${
        collapsed ? "w-[40px]" : "w-[236px]"
      }`}
    >
      <div className="flex h-[42px] shrink-0 items-center justify-between border-b border-line-soft px-3">
        {!collapsed && (
          <Link
            href={`/${meta.id}`}
            className="flex min-w-0 items-center gap-2 font-bold text-ink hover:text-ink hover:no-underline"
          >
            <ServiceIcon serviceId={meta.id} category={meta.category} size={20} />
            <span className="truncate text-[14px]">{meta.name}</span>
          </Link>
        )}
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className={`flex size-7 items-center justify-center rounded-[2px] text-muted hover:bg-page hover:text-ink ${
            collapsed ? "mx-auto" : ""
          }`}
          aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
          title={collapsed ? "Expand navigation" : "Collapse navigation"}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M3 12h18M3 6h18M3 18h18" />
          </svg>
        </button>
      </div>

      {!collapsed && (
        <nav className="min-h-0 flex-1 overflow-y-auto py-2">
          <ul className="space-y-0.5">
            {meta.resources.map((r) => {
              const active = r.id === activeResource;
              return (
                <li key={r.id}>
                  <Link
                    href={`/${meta.id}/${r.id}`}
                    className={`block truncate border-l-[3px] px-4 py-1.5 text-[13px] transition-colors hover:no-underline ${
                      active
                        ? "border-accent bg-[#f2f8fd] font-semibold text-accent"
                        : "border-transparent text-ink hover:bg-page hover:text-ink"
                    }`}
                  >
                    {r.name}
                  </Link>
                </li>
              );
            })}
            {meta.extraNav.map((e) => {
              const active = activeResource !== undefined && (e.href === activeResource || e.label === activeResource);
              return (
                <li key={`${e.href}-${e.label}`}>
                  <Link
                    href={e.href}
                    className={`block truncate border-l-[3px] px-4 py-1.5 text-[13px] transition-colors hover:no-underline ${
                      active
                        ? "border-accent bg-[#f2f8fd] font-semibold text-accent"
                        : "border-transparent text-ink hover:bg-page hover:text-ink"
                    }`}
                  >
                    {e.label}
                  </Link>
                </li>
              );
            })}
          </ul>
          {meta.notSupported.length > 0 && (
            <div className="mx-4 mt-6 border-t border-line-soft pt-3 text-[12px] text-muted">
              <p className="font-semibold text-ink">AWS Emulator doesn&apos;t support yet</p>
              <ul className="mt-1.5 list-disc space-y-1 pl-4">
                {meta.notSupported.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </div>
          )}
        </nav>
      )}
    </aside>
  );
}
