"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import { readRecent, RECENT_KEY, type RecentEntry } from "@/console/recent";
import { ServiceIcon } from "./ServiceIcon";

function subscribe(onChange: () => void): () => void {
  const handler = (e: StorageEvent) => e.key === RECENT_KEY && onChange();
  window.addEventListener("storage", handler);
  return () => window.removeEventListener("storage", handler);
}

let cache: { raw: string | null; list: RecentEntry[] } = { raw: null, list: [] };
function snapshot(): RecentEntry[] {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(RECENT_KEY);
  } catch {
    raw = null;
  }
  if (raw !== cache.raw) cache = { raw, list: readRecent() };
  return cache.list;
}
const EMPTY: RecentEntry[] = [];

export interface KnownServiceLink {
  id: string;
  href: string;
  category?: string;
}

export function RecentlyVisited({ known }: { known: KnownServiceLink[] }) {
  const recent = useSyncExternalStore(subscribe, snapshot, () => EMPTY);
  const byId = new Map(known.map((k) => [k.id, k]));
  const shown = recent.filter((r) => byId.has(r.id));

  if (shown.length === 0) {
    return (
      <div className="py-4 text-[13px] text-muted">
        No recently visited services yet. Open any service from the catalog below or the Services menu and it will appear here.
      </div>
    );
  }

  return (
    <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {shown.map((r) => {
        const meta = byId.get(r.id);
        return (
          <li key={r.id}>
            <Link
              href={meta?.href ?? `/${r.id}`}
              className="flex items-center gap-2.5 rounded-[2px] border border-transparent px-2 py-1.5 text-[13px] font-medium text-link transition-colors hover:border-line-soft hover:bg-[#f2f8fd] hover:text-link-hover"
            >
              <ServiceIcon serviceId={r.id} category={meta?.category} size={22} />
              <span className="truncate">{r.name}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
