"use client";

import Link from "next/link";
import type { ServiceSummary } from "@/console/registry";
import { useFavorites } from "./favorites";
import { ServiceIcon } from "./ServiceIcon";

function serviceHref(s: ServiceSummary): string {
  return s.firstResource ? `/${s.id}/${s.firstResource}` : `/${s.id}`;
}

function shortLabel(name: string): string {
  return name.replace(/^(Amazon|AWS)\s+/i, "");
}

export function FavoritesBar({ services }: { services: ServiceSummary[] }) {
  const { favorites } = useFavorites();
  const byId = new Map(services.map((s) => [s.id, s]));
  const pinned = favorites.map((id) => byId.get(id)).filter((s): s is ServiceSummary => s !== undefined);

  if (pinned.length === 0) return null;

  return (
    <nav
      aria-label="Favorite services"
      className="sticky top-[40px] z-30 flex h-[32px] items-center gap-1 overflow-x-auto border-b border-[#2a3441] bg-[#161e2d] px-3 text-[12px] text-[#d5dbdb] select-none"
    >
      {pinned.map((s) => (
        <Link
          key={s.id}
          href={serviceHref(s)}
          className="flex shrink-0 items-center gap-1.5 rounded-[4px] px-2 py-0.5 font-medium text-[#e9ebed] transition-colors hover:bg-white/10 hover:text-white hover:no-underline"
          title={s.name}
        >
          <ServiceIcon serviceId={s.id} category={s.category} size={16} />
          <span>{shortLabel(s.name)}</span>
        </Link>
      ))}
    </nav>
  );
}
