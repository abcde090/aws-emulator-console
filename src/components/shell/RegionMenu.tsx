"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { callServer } from "@/console/call";
import { CONSOLE_REGIONS, isGlobalPage, pathSegments, regionName, regionSwitchTarget, type ConsoleRegion } from "@/lib/regions";
import { switchRegion } from "./actions";

interface RegionMenuProps {
  /** The Region chosen (server-validated cookie). */
  region: string;
  /** Service names by id, for the "<service> does not require Region selection" note. */
  serviceNames: Record<string, string>;
}

/** "N. Virginia" for "US East (N. Virginia)". */
function shortName(name: string): string {
  return /\(([^)]+)\)/.exec(name)?.[1] ?? name;
}

/** The AWS console's Region groups. */
function groupOf(r: ConsoleRegion): string {
  if (r.name.startsWith("US ")) return "United States";
  return r.name.split(" (")[0];
}

function groups(): { label: string; regions: ConsoleRegion[] }[] {
  const out: { label: string; regions: ConsoleRegion[] }[] = [];
  for (const r of CONSOLE_REGIONS) {
    const label = groupOf(r);
    const g = out.find((x) => x.label === label);
    if (g) g.regions.push(r);
    else out.push({ label, regions: [r] });
  }
  return out;
}

const GlobeIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#aab7b8" strokeWidth="2" aria-hidden="true">
    <circle cx="12" cy="12" r="10" />
    <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
  </svg>
);

export function RegionMenu({ region, serviceNames }: RegionMenuProps) {
  const pathname = usePathname() ?? "/";
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const { serviceId, resourceId } = pathSegments(pathname);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (isGlobalPage(serviceId, resourceId)) {
    const service = (serviceId && serviceNames[serviceId]) || "This service";
    return (
      <span
        className="flex h-full cursor-default items-center gap-1.5 border-l border-white/10 px-3 text-[13px] text-nav-text"
        title={`${service} does not require Region selection.`}
        data-testid="region"
        data-region="global"
      >
        <GlobeIcon />
        <span>Global</span>
      </span>
    );
  }

  async function choose(code: string) {
    if (code === region) return setOpen(false);
    setBusy(true);
    setError(null);
    const r = await callServer(() => switchRegion(code));
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setOpen(false);
    // The server action revalidated every page; a detail page goes to its list (the resource
    // belongs to the old Region), any other page is drawn again with the new Region's data.
    const target = regionSwitchTarget(pathname);
    if (target !== pathname) router.push(target);
    else router.refresh();
  }

  return (
    <div className="relative h-full border-l border-white/10" ref={ref}>
      <button
        type="button"
        className={`flex h-full items-center gap-1.5 px-3 text-[13px] text-nav-text hover:bg-white/10 ${open ? "bg-white/15" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Region: ${regionName(region)} ${region}`}
        title={`${regionName(region)} ${region}`}
        data-testid="region"
        data-region={region}
        onClick={() => {
          setError(null);
          setOpen((o) => !o);
        }}
      >
        <GlobeIcon />
        <span>{shortName(regionName(region))}</span>
        <span className="hidden text-[11px] text-[#9ba7b6] sm:inline">({region})</span>
        <span aria-hidden="true" className="text-[10px]">▾</span>
      </button>
      {open && (
        <div
          className="absolute right-0 top-[40px] z-50 max-h-[calc(100vh-56px)] w-[19rem] overflow-y-auto border border-line bg-white py-1 text-ink shadow-2xl"
          role="menu"
          aria-label="Regions"
        >
          {error && (
            <p className="mx-3 my-1.5 rounded border border-bad bg-bad-bg px-2 py-1 text-[12px] text-bad" role="alert">
              {error}
            </p>
          )}
          {groups().map((g) => (
            <div key={g.label} className="py-1">
              <p className="px-3 pb-0.5 pt-1 text-[11px] font-bold tracking-wider text-muted uppercase">{g.label}</p>
              {g.regions.map((r) => {
                const current = r.code === region;
                return (
                  <button
                    key={r.code}
                    type="button"
                    role="menuitemradio"
                    aria-checked={current}
                    disabled={busy}
                    data-testid={`region-option-${r.code}`}
                    onClick={() => void choose(r.code)}
                    className={`flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-[13px] hover:bg-[#f2f8fd] disabled:opacity-60 ${
                      current ? "bg-[#f2f8fd] font-semibold" : ""
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <span className="w-3 text-primary" aria-hidden="true">
                        {current ? "✓" : ""}
                      </span>
                      {r.name}
                    </span>
                    <span className="text-[12px] text-muted">{r.code}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
