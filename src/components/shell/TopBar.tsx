"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ServiceSummary } from "@/console/registry";
import { filterServices, groupByCategory, moveActive } from "./service-search";
import { CloudShell } from "./CloudShell";
import { FavoritesBar } from "./FavoritesBar";
import { useFavorites } from "./favorites";
import { IdentityMenu, type IdentityView, type SwitchFn } from "./IdentityMenu";
import { RegionMenu } from "./RegionMenu";
import { ServiceIcon } from "./ServiceIcon";
import { ThemeToggle } from "./ThemeToggle";

interface TopBarProps {
  services: ServiceSummary[];
  identity: IdentityView;
  switchIdentity: SwitchFn;
  /** The Region chosen in the top bar (validated on the server). */
  region: string;
}

function useOutsideClose(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  return ref;
}

function serviceHref(s: ServiceSummary): string {
  return s.firstResource ? `/${s.id}/${s.firstResource}` : `/${s.id}`;
}

export function TopBar({ services, identity, switchIdentity, region }: TopBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuFilter, setMenuFilter] = useState("");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const router = useRouter();
  const [shellOpen, setShellOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const { favorites, toggleFavorite } = useFavorites();

  const closeMenu = () => {
    setMenuOpen(false);
    setMenuFilter("");
  };
  const menuRef = useOutsideClose(menuOpen, closeMenu);
  const searchRef = useOutsideClose(query !== "", () => setQuery(""));
  const changeQuery = (q: string) => {
    setQuery(q);
    setActive(0);
  };

  const filteredForMenu = useMemo(() => (menuFilter.trim() === "" ? services : filterServices(services, menuFilter)), [services, menuFilter]);
  const groups = useMemo(() => groupByCategory(filteredForMenu), [filteredForMenu]);
  const matches = useMemo(() => filterServices(services, query).slice(0, 12), [services, query]);
  const serviceNames = useMemo(() => Object.fromEntries(services.map((s) => [s.id, s.name])), [services]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <header className="sticky top-0 z-40 flex h-[40px] items-center gap-2 bg-nav px-2 text-[13px] text-nav-text select-none">
        {/* Console Home Logo */}
        <Link
          href="/"
          className="flex h-full items-center gap-1.5 px-2.5 text-nav-text hover:bg-white/10 hover:text-white hover:no-underline"
          aria-label="Console Home"
          title="AWS Emulator Console Home"
        >
          {/* Our own neutral mark: a console prompt in a rounded square (no AWS logo). */}
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect x="1" y="1" width="22" height="22" rx="5" fill="#232f3e" stroke="#539fe5" strokeWidth="1.5" />
            <path d="M6.5 8.5 10 12l-3.5 3.5" stroke="#ffffff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M12.5 16h5" stroke="#539fe5" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <span className="hidden text-[13px] font-semibold whitespace-nowrap text-white sm:inline">AWS Emulator Console</span>
        </Link>

        {/* Services Mega-Menu */}
        <div className="relative h-full" ref={menuRef}>
          <button
            type="button"
            className={`flex h-full items-center gap-1.5 px-2.5 text-[13px] font-medium text-nav-text transition-colors hover:bg-white/10 ${menuOpen ? "bg-white/15" : ""}`}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <rect x="1" y="1" width="3.5" height="3.5" rx="0.5" />
              <rect x="6.25" y="1" width="3.5" height="3.5" rx="0.5" />
              <rect x="11.5" y="1" width="3.5" height="3.5" rx="0.5" />
              <rect x="1" y="6.25" width="3.5" height="3.5" rx="0.5" />
              <rect x="6.25" y="6.25" width="3.5" height="3.5" rx="0.5" />
              <rect x="11.5" y="6.25" width="3.5" height="3.5" rx="0.5" />
              <rect x="1" y="11.5" width="3.5" height="3.5" rx="0.5" />
              <rect x="6.25" y="11.5" width="3.5" height="3.5" rx="0.5" />
              <rect x="11.5" y="11.5" width="3.5" height="3.5" rx="0.5" />
            </svg>
            <span>Services</span>
          </button>
          {menuOpen && (
            <div
              className="absolute left-0 top-[40px] z-50 flex max-h-[calc(100vh-56px)] w-[min(46rem,calc(100vw-1rem))] flex-col border border-line bg-white text-ink shadow-2xl"
              role="menu"
              aria-label="Services"
            >
              <div className="sticky top-0 z-10 border-b border-line-soft bg-shade px-4 py-2.5">
                <div className="relative">
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
                    aria-label="Filter services menu"
                    placeholder={`Filter ${services.length} services...`}
                    value={menuFilter}
                    onChange={(e) => setMenuFilter(e.target.value)}
                    autoFocus
                    className="w-full rounded-[4px] border border-[#879596] bg-white py-1 pl-8 pr-3 text-[13px] text-ink placeholder:text-[#879596] focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
              </div>
              <div className="overflow-y-auto p-4">
                {groups.length === 0 ? (
                  <p className="py-4 text-center text-muted">No services match &quot;{menuFilter}&quot;.</p>
                ) : (
                  <div className="space-y-4">
                    {groups.map((g) => (
                      <div key={g.category}>
                        <p className="mb-1.5 border-b border-line-soft pb-1 text-[11px] font-bold tracking-wider text-muted uppercase">
                          {g.category}
                        </p>
                        <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                          {g.services.map((s) => {
                            const starred = favorites.includes(s.id);
                            return (
                              <li key={s.id} className="group flex items-start gap-1 rounded-[4px] hover:bg-[#f2f8fd]">
                                <Link
                                  href={serviceHref(s)}
                                  className="flex min-w-0 flex-1 items-start gap-2.5 px-2 py-1.5 text-ink hover:no-underline"
                                  onClick={closeMenu}
                                >
                                  <ServiceIcon serviceId={s.id} category={s.category} size={22} className="mt-0.5" />
                                  <span className="min-w-0">
                                    <span className="block font-semibold text-link">{s.name}</span>
                                    <span className="block truncate text-[12px] text-muted">{s.description}</span>
                                  </span>
                                </Link>
                                <button
                                  type="button"
                                  onClick={() => toggleFavorite(s.id)}
                                  aria-label={starred ? `Remove ${s.name} from favorites` : `Add ${s.name} to favorites`}
                                  title={starred ? "Unpin from favorites bar" : "Pin to favorites bar"}
                                  className={`mt-1.5 mr-1.5 rounded p-1 text-[14px] leading-none transition-opacity ${
                                    starred ? "text-[#ff9900] opacity-100" : "text-muted opacity-40 hover:opacity-100"
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
            </div>
          )}
        </div>

        {/* Global Search Bar */}
        <div className="relative max-w-xl flex-1" ref={searchRef}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#aab7b8"
            strokeWidth="2"
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            ref={searchInputRef}
            type="search"
            aria-label="Search services"
            placeholder="Search for services [Alt+S]"
            className="h-[28px] w-full rounded-[4px] border border-[#414d5c] bg-[#161e2d] pl-8 pr-3 text-[13px] text-white placeholder:text-[#9ba7b6] focus:border-[#539fe5] focus:bg-[#1f2937] focus:outline-none"
            value={query}
            onChange={(e) => changeQuery(e.target.value)}
            role="combobox"
            aria-expanded={query !== ""}
            aria-controls="service-search-results"
            aria-activedescendant={matches[active] ? `service-search-${matches[active].id}` : undefined}
            onKeyDown={(e) => {
              // OG-11: arrows move through the results, Enter opens the highlighted one.
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setActive((i) => moveActive(i, e.key === "ArrowDown" ? 1 : -1, matches.length));
              } else if (e.key === "Enter" && matches[active]) {
                e.preventDefault();
                const target = serviceHref(matches[active]);
                changeQuery("");
                router.push(target);
              } else if (e.key === "Escape") {
                changeQuery("");
              }
            }}
          />
          {query !== "" && (
            <ul
              className="absolute left-0 right-0 top-[34px] z-50 max-h-[70vh] overflow-y-auto border border-line bg-white py-1 text-ink shadow-2xl"
              role="listbox"
              id="service-search-results"
              aria-label="Matching services"
            >
              {matches.length === 0 && <li className="px-4 py-2.5 text-muted">No services match &quot;{query}&quot;.</li>}
              {matches.map((s, i) => (
                <li key={s.id} id={`service-search-${s.id}`} role="option" aria-selected={i === active} onMouseEnter={() => setActive(i)}>
                  <Link
                    href={serviceHref(s)}
                    className={`flex items-center gap-2.5 px-3 py-2 hover:bg-[#f2f8fd] hover:no-underline ${i === active ? "bg-[#f2f8fd]" : ""}`}
                    onClick={() => changeQuery("")}
                  >
                    <ServiceIcon serviceId={s.id} category={s.category} size={22} />
                    <span className="min-w-0 flex-1">
                      <span className="font-semibold text-link">{s.name}</span>
                      <span className="ml-2 text-[12px] text-muted">{s.category}</span>
                      <span className="block truncate text-[12px] text-muted">{s.description}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Right Utility Cluster */}
        <div className="ml-auto flex h-full items-center">
          <button
            type="button"
            className={`flex h-full items-center gap-1.5 border-l border-white/10 px-3 text-nav-text transition-colors hover:bg-white/10 ${shellOpen ? "bg-white/15 text-[#ff9900]" : ""}`}
            aria-label="CloudShell"
            title="AWS CloudShell"
            onClick={() => setShellOpen((o) => !o)}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
          </button>

          <ThemeToggle />

          <RegionMenu region={region} serviceNames={serviceNames} />

          <div className="flex h-full items-center border-l border-white/10">
            <IdentityMenu identity={identity} switchIdentity={switchIdentity} />
          </div>
        </div>
      </header>

      <FavoritesBar services={services} />

      {identity.type !== "admin" && (
        <div
          className="flex flex-wrap items-center justify-between gap-3 border-b border-[#e0a800] bg-warn-bg px-4 py-1.5 text-[13px] text-ink"
          role="status"
          data-testid="identity-banner"
        >
          <span className="flex items-center gap-2">
            <span className="inline-block size-2 rounded-full bg-[#ec7211]" aria-hidden="true" />
            <span>
              Acting as{" "}
              <strong>{identity.type === "invalid" ? "an invalid identity (everything is denied)" : `IAM ${identity.type} ${identity.name}`}</strong>.
              The console&apos;s IAM simulator checks each call against its identity-based policies before sending it to the emulator.
              {identity.loadErrors.length > 0 && (
                <span className="text-bad"> Its policies could not all be loaded, so everything is denied: {identity.loadErrors.join("; ")}</span>
              )}
            </span>
          </span>
          <button
            type="button"
            className="font-semibold text-link hover:text-link-hover hover:underline"
            onClick={() => void switchIdentity({ type: "admin" }).then(() => window.location.reload())}
          >
            Switch back to admin
          </button>
        </div>
      )}
      <CloudShell open={shellOpen} onClose={() => setShellOpen(false)} identityLabel={identity.label} region={region} />
    </>
  );
}
