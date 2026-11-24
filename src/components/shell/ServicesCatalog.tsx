"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { ServiceSummary } from "@/console/registry";
import { filterServices, groupByCategory } from "./service-search";
import { useFavorites } from "./favorites";
import { ServiceIcon } from "./ServiceIcon";

function serviceHref(s: ServiceSummary): string {
  return s.firstResource ? `/${s.id}/${s.firstResource}` : `/${s.id}`;
}

export function ServicesCatalog({ services }: { services: ServiceSummary[] }) {
  const [query, setQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string>("All");
  const { favorites, toggleFavorite } = useFavorites();

  const categories = useMemo(() => {
    const set = new Set(services.map((s) => s.category));
    return ["All", ...Array.from(set).sort((a, b) => a.localeCompare(b))];
  }, [services]);

  const groups = useMemo(() => {
    const base = query.trim() === "" ? services : filterServices(services, query);
    const matched = base.filter((s) => selectedCategory === "All" || s.category === selectedCategory);
    return groupByCategory(matched);
  }, [services, query, selectedCategory]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-full max-w-md">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#545b64"
            strokeWidth="2"
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            type="search"
            aria-label="Filter all services"
            placeholder="Filter services by name, category, or description"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full rounded-[4px] border border-[#879596] bg-white py-1.5 pl-8 pr-3 text-[13px] text-ink placeholder:text-[#879596] focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {categories.map((cat) => {
            const active = selectedCategory === cat;
            return (
              <button
                key={cat}
                type="button"
                onClick={() => setSelectedCategory(cat)}
                className={`rounded-full border px-3 py-0.5 text-[12px] font-medium transition-colors ${
                  active
                    ? "border-primary bg-info-bg text-primary"
                    : "border-line bg-white text-muted hover:bg-shade hover:text-ink"
                }`}
              >
                {cat}
              </button>
            );
          })}
        </div>
      </div>

      {groups.length === 0 ? (
        <p className="py-6 text-center text-[13px] text-muted">No services match your filter.</p>
      ) : (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
          {groups.map((g) => (
            <div key={g.category} className="space-y-2">
              <h3 className="border-b border-line-soft pb-1.5 text-[12px] font-bold tracking-wider text-muted uppercase">
                {g.category} <span className="font-normal">({g.services.length})</span>
              </h3>
              <ul className="space-y-1">
                {g.services.map((s) => {
                  const starred = favorites.includes(s.id);
                  return (
                    <li key={s.id} className="group flex items-start gap-1 rounded-[4px] hover:bg-[#f2f8fd]">
                      <Link
                        href={serviceHref(s)}
                        className="flex min-w-0 flex-1 items-start gap-2.5 px-2 py-1.5 hover:no-underline"
                      >
                        <ServiceIcon serviceId={s.id} category={s.category} size={22} className="mt-0.5" />
                        <span className="min-w-0">
                          <span className="block text-[13px] font-semibold text-link group-hover:text-link-hover group-hover:underline">
                            {s.name}
                          </span>
                          <span className="block text-[12px] leading-4 text-muted">{s.description}</span>
                        </span>
                      </Link>
                      <button
                        type="button"
                        onClick={() => toggleFavorite(s.id)}
                        aria-label={starred ? `Remove ${s.name} from favorites` : `Add ${s.name} to favorites`}
                        title={starred ? "Unpin from favorites bar" : "Pin to favorites bar"}
                        className={`mt-1.5 mr-1.5 rounded p-1 text-[14px] leading-none transition-opacity ${
                          starred ? "text-[#ff9900] opacity-100" : "text-muted opacity-30 hover:opacity-100"
                        }`}
                      >
                        {starred ? "★" : "☆"}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
