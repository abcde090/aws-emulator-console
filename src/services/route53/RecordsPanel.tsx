"use client";

/**
 * The hosted zone's Records tab: the records table, a record editor for every routing
 * policy (simple, weighted, geolocation, latency, failover, multivalue) and alias records,
 * and record deletion. Everything goes through the server actions in record-actions.ts.
 */

import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Modal } from "@/console/ui/Modal";
import { Button, Container, EmptyState, ErrorBanner, Flash } from "@/console/ui/primitives";
import { deleteRecords, listRecords, saveRecord, type EditorOptions, type RecordListing } from "./record-actions";
import { ALIAS_TYPES, CONTINENTS, EMPTY_RECORD_INPUT, LATENCY_REGIONS, RECORD_TYPES, ROUTING_POLICIES, type RecordInput, type RoutingPolicy } from "./records";

interface RecordsPanelProps {
  zoneId: string;
  initial: RecordListing | null;
  initialError: string | null;
  options: EditorOptions | null;
}

type Editor = { mode: "create" } | { mode: "edit"; key: string };

const inputClass = "w-full rounded-[4px] border border-[#879596] bg-white px-2.5 py-1.5 text-[13px] focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary";

const VALUE_HELP: Record<string, string> = {
  A: "IPv4 address, such as 192.0.2.235. One per line.",
  AAAA: "IPv6 address, such as 2001:0db8:85a3::8a2e:0370:7334. One per line.",
  CNAME: "The domain name to route to, such as www.example.com.",
  MX: "Priority and mail server, such as 10 mailserver.example.com. One per line.",
  TXT: 'Text in quotation marks, such as "v=spf1 -all". One per line.',
  NS: "Name server domain names. One per line.",
  SRV: "Priority weight port target, such as 1 10 5269 xmpp-server.example.com. One per line.",
  CAA: 'Flags tag "value", such as 0 issue "amazon.com". One per line.',
  PTR: "The domain name, such as www.example.com.",
};

function Field({ id, label, help, children }: { id: string; label: string; help?: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block font-bold">
        {label}
      </label>
      {help && <p className="text-[13px] text-muted">{help}</p>}
      {children}
    </div>
  );
}

function RecordEditor({ zoneName, input, setInput, options }: { zoneName: string; input: RecordInput; setInput: (p: Partial<RecordInput>) => void; options: EditorOptions | null }) {
  const zoneIds = (options?.zones ?? []).map((z) => z.value);
  const customZone = input.aliasZoneId !== "" && !zoneIds.includes(input.aliasZoneId);
  return (
    <div className="space-y-4" data-testid="record-editor">
      <Field id="rec-name" label="Record name" help={`Leave empty to create a record for the root domain. Full name: ${input.name.trim() ? `${input.name.trim().replace(/\.$/, "")}.` : ""}${zoneName}`}>
        <div className="flex items-center gap-2">
          <input id="rec-name" className={inputClass} value={input.name} placeholder="subdomain" onChange={(e) => setInput({ name: e.target.value })} />
          <span className="whitespace-nowrap text-muted">.{zoneName}</span>
        </div>
      </Field>
      <Field id="rec-type" label="Record type">
        <select id="rec-type" className={inputClass} value={input.type} onChange={(e) => setInput({ type: e.target.value })}>
          {RECORD_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </Field>
      <label className="flex items-start gap-2">
        <input type="checkbox" className="mt-1 size-4" checked={input.alias} disabled={!ALIAS_TYPES.includes(input.type as (typeof ALIAS_TYPES)[number])} onChange={(e) => setInput({ alias: e.target.checked, routing: e.target.checked && input.routing === "multivalue" ? "simple" : input.routing })} />
        <span>
          <span className="font-bold">Alias</span>
          <span className="block text-[13px] text-muted">Route traffic to an AWS resource or to another record in a hosted zone instead of to fixed values.</span>
        </span>
      </label>
      {input.alias ? (
        <>
          <Field id="rec-alias-zone" label="Route traffic to: hosted zone" help="Choose a hosted zone in this account, or enter another hosted zone ID (for example the one for a CloudFront distribution or load balancer).">
            <select id="rec-alias-zone" className={inputClass} value={customZone ? "__custom" : input.aliasZoneId} onChange={(e) => setInput({ aliasZoneId: e.target.value === "__custom" ? " " : e.target.value })}>
              <option value="">Choose a hosted zone</option>
              {(options?.zones ?? []).map((z) => (
                <option key={z.value} value={z.value}>
                  {z.label}
                </option>
              ))}
              <option value="__custom">Enter a hosted zone ID</option>
            </select>
          </Field>
          {customZone && (
            <Field id="rec-alias-zone-id" label="Hosted zone ID">
              <input id="rec-alias-zone-id" className={inputClass} value={input.aliasZoneId.trim()} onChange={(e) => setInput({ aliasZoneId: e.target.value || " " })} />
            </Field>
          )}
          <Field id="rec-alias-dns" label="Alias target DNS name" help="For a record in a hosted zone, its full name, such as www.example.com.">
            <input id="rec-alias-dns" className={inputClass} value={input.aliasDnsName} onChange={(e) => setInput({ aliasDnsName: e.target.value })} />
          </Field>
          <label className="flex items-center gap-2">
            <input type="checkbox" className="size-4" checked={input.evaluateTargetHealth} onChange={(e) => setInput({ evaluateTargetHealth: e.target.checked })} />
            <span className="font-bold">Evaluate target health</span>
          </label>
        </>
      ) : (
        <>
          <Field id="rec-value" label="Value" help={VALUE_HELP[input.type] ?? "One value per line."}>
            <textarea id="rec-value" rows={4} className={`${inputClass} font-mono`} value={input.values} onChange={(e) => setInput({ values: e.target.value })} />
          </Field>
          <Field id="rec-ttl" label="TTL (seconds)" help="Recommended values: 60 to 172800 (two days).">
            <input id="rec-ttl" inputMode="numeric" className={inputClass} value={input.ttl} onChange={(e) => setInput({ ttl: e.target.value })} />
          </Field>
        </>
      )}
      <Field id="rec-routing" label="Routing policy">
        <select id="rec-routing" className={inputClass} value={input.routing} onChange={(e) => setInput({ routing: e.target.value as RoutingPolicy })}>
          {ROUTING_POLICIES.filter((p) => !(input.alias && p.value === "multivalue")).map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </Field>
      {input.routing === "weighted" && (
        <Field id="rec-weight" label="Weight" help="0 to 255. Route 53 sends traffic in proportion to each record's weight.">
          <input id="rec-weight" inputMode="numeric" className={inputClass} value={input.weight} onChange={(e) => setInput({ weight: e.target.value })} />
        </Field>
      )}
      {input.routing === "latency" && (
        <Field id="rec-region" label="Region">
          <select id="rec-region" className={inputClass} value={input.region} onChange={(e) => setInput({ region: e.target.value })}>
            {LATENCY_REGIONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </Field>
      )}
      {input.routing === "failover" && (
        <Field id="rec-failover" label="Failover record type">
          <select id="rec-failover" className={inputClass} value={input.failover} onChange={(e) => setInput({ failover: e.target.value })}>
            <option value="PRIMARY">Primary</option>
            <option value="SECONDARY">Secondary</option>
          </select>
        </Field>
      )}
      {input.routing === "geolocation" && (
        <>
          <Field id="rec-geo" label="Location" help="Default answers queries from locations that no other geolocation record covers.">
            <select id="rec-geo" className={inputClass} value={input.geoContinent} onChange={(e) => setInput({ geoContinent: e.target.value })}>
              <option value="">Country (enter a code below)</option>
              <option value="*">Default</option>
              {CONTINENTS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </Field>
          {input.geoContinent === "" && (
            <div className="grid grid-cols-2 gap-3">
              <Field id="rec-country" label="Country code" help="Two letters, such as US.">
                <input id="rec-country" className={inputClass} value={input.geoCountry} onChange={(e) => setInput({ geoCountry: e.target.value })} />
              </Field>
              <Field id="rec-subdivision" label="Subdivision - optional" help="US states, such as WA.">
                <input id="rec-subdivision" className={inputClass} value={input.geoSubdivision} onChange={(e) => setInput({ geoSubdivision: e.target.value })} />
              </Field>
            </div>
          )}
        </>
      )}
      {input.routing !== "simple" && (
        <>
          <Field id="rec-health" label="Health check - optional">
            <select id="rec-health" className={inputClass} value={input.healthCheckId} onChange={(e) => setInput({ healthCheckId: e.target.value })}>
              <option value="">No health check</option>
              {(options?.healthChecks ?? []).map((h) => (
                <option key={h.value} value={h.value}>
                  {h.label}
                </option>
              ))}
            </select>
          </Field>
          <Field id="rec-set-id" label="Record ID" help="Distinguishes this record from others with the same name and type.">
            <input id="rec-set-id" className={inputClass} value={input.setIdentifier} onChange={(e) => setInput({ setIdentifier: e.target.value })} />
          </Field>
        </>
      )}
    </div>
  );
}

export function RecordsPanel({ zoneId, initial, initialError, options }: RecordsPanelProps) {
  const router = useRouter();
  const [listing, setListing] = useState<RecordListing | null>(initial);
  const [error, setError] = useState<string | null>(initialError);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [editor, setEditor] = useState<Editor | null>(null);
  const [input, setInputState] = useState<RecordInput>(EMPTY_RECORD_INPUT);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const r = await listRecords(zoneId);
    if (r.ok) {
      setListing(r.data);
      setError(null);
    } else setError(r.error);
    setSelected([]);
    router.refresh();
  }, [zoneId, router]);

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const all = listing?.rows ?? [];
    return q ? all.filter((r) => [r.name, r.type, r.routing, r.value, r.differentiator ?? "", r.setIdentifier ?? ""].some((v) => v.toLowerCase().includes(q))) : all;
  }, [listing, filter]);

  const zoneName = listing?.zoneName ?? "";
  const protectedSelected = selected.some((k) => listing?.rows.find((r) => r.key === k)?.protected);

  function openEditor(e: Editor) {
    setEditorError(null);
    setInputState(e.mode === "edit" ? listing?.inputs[e.key] ?? EMPTY_RECORD_INPUT : EMPTY_RECORD_INPUT);
    setEditor(e);
  }

  async function save() {
    if (!editor) return;
    setBusy(true);
    setEditorError(null);
    const r = await saveRecord(zoneId, input, editor.mode === "edit" ? editor.key : null);
    setBusy(false);
    if (!r.ok) return setEditorError(r.error);
    setEditor(null);
    setNotice(`${editor.mode === "edit" ? "Saved" : "Created"} record ${r.data.key.split("|").filter(Boolean).join(" ")}. Change status: ${r.data.status}.`);
    await reload();
  }

  async function remove() {
    setBusy(true);
    const r = await deleteRecords(zoneId, selected);
    setBusy(false);
    setConfirmDelete(false);
    if (!r.ok) return setError(r.error);
    setNotice(`Deleted ${r.data.deleted} record${r.data.deleted === 1 ? "" : "s"}. Change status: ${r.data.status}.`);
    await reload();
  }

  const toggle = (k: string, on: boolean) => setSelected((prev) => (on ? [...prev, k] : prev.filter((x) => x !== k)));

  return (
    <div className="space-y-4" data-testid="records-panel">
      {notice && <Flash kind="success" message={notice} onDismiss={() => setNotice(null)} />}
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      <Container
        title="Records"
        counter={`(${listing?.rows.length ?? 0})`}
        description="Records define how you want to route traffic for this domain and its subdomains. Route 53 created the NS and SOA records with the zone."
        actions={
          <>
            <Button aria-label="Refresh records" onClick={() => void reload()}>
              ⟳
            </Button>
            <Button disabled={selected.length === 0 || protectedSelected || busy} onClick={() => setConfirmDelete(true)}>
              Delete record
            </Button>
            <Button disabled={selected.length !== 1 || busy} onClick={() => openEditor({ mode: "edit", key: selected[0] })}>
              Edit record
            </Button>
            <Button variant="primary" disabled={!listing || busy} onClick={() => openEditor({ mode: "create" })}>
              Create record
            </Button>
          </>
        }
      >
        <input type="search" aria-label="Filter records" placeholder="Filter records by property or value" className={`${inputClass} mb-3 max-w-md`} value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left" data-testid="records-table">
            <thead>
              <tr className="border-b-2 border-line-soft">
                <th className="w-8" />
                {["Record name", "Type", "Routing policy", "Differentiator", "Alias", "Value/Route traffic to", "TTL (seconds)", "Health check ID", "Record ID"].map((h) => (
                  <th key={h} className="px-2 py-2 font-bold whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className={`border-b border-line-soft align-top ${selected.includes(r.key) ? "bg-[#f2f8fd]" : "hover:bg-shade"}`}>
                  <td className="px-2 py-2">
                    <input type="checkbox" aria-label={`Select ${r.name} ${r.type}${r.setIdentifier ? ` ${r.setIdentifier}` : ""}`} checked={selected.includes(r.key)} onChange={(e) => toggle(r.key, e.target.checked)} />
                  </td>
                  <td className="px-2 py-2 break-all">{r.name}</td>
                  <td className="px-2 py-2">{r.type}</td>
                  <td className="px-2 py-2">{r.routing}</td>
                  <td className="px-2 py-2">{r.differentiator ?? "-"}</td>
                  <td className="px-2 py-2">{r.alias}</td>
                  <td className="max-w-sm px-2 py-2 font-mono text-[13px] break-all whitespace-pre-wrap">{r.value || "-"}</td>
                  <td className="px-2 py-2">{r.ttl ?? "-"}</td>
                  <td className="px-2 py-2 font-mono text-[13px]">{r.healthCheckId ?? "-"}</td>
                  <td className="px-2 py-2">{r.setIdentifier ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {listing && listing.rows.length === 0 && <EmptyState title="No records" />}
          {listing && listing.rows.length > 0 && rows.length === 0 && <EmptyState title="No matches">No records match the filter.</EmptyState>}
        </div>
      </Container>
      {editor && (
        <Modal
          title={editor.mode === "edit" ? "Edit record" : "Create record"}
          wide
          onClose={() => setEditor(null)}
          footer={
            <>
              <Button variant="link" onClick={() => setEditor(null)}>
                Cancel
              </Button>
              <Button variant="primary" disabled={busy} onClick={() => void save()} data-testid="record-save">
                {busy ? "Working…" : editor.mode === "edit" ? "Save" : "Create records"}
              </Button>
            </>
          }
        >
          {editorError && <ErrorBanner message={editorError} onDismiss={() => setEditorError(null)} />}
          <RecordEditor zoneName={zoneName} input={input} setInput={(p) => setInputState((prev) => ({ ...prev, ...p }))} options={options} />
        </Modal>
      )}
      {confirmDelete && (
        <Modal
          title="Delete records"
          onClose={() => setConfirmDelete(false)}
          footer={
            <>
              <Button variant="link" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
              <Button variant="danger" disabled={busy} onClick={() => void remove()} data-testid="records-confirm-delete">
                {busy ? "Working…" : "Delete"}
              </Button>
            </>
          }
        >
          <p>
            Delete {selected.length} record{selected.length === 1 ? "" : "s"}? Route 53 stops answering DNS queries for {selected.length === 1 ? "it" : "them"}.
          </p>
          <ul className="list-disc pl-5 font-mono text-[13px]">
            {selected.map((k) => (
              <li key={k}>{k.split("|").filter(Boolean).join(" ")}</li>
            ))}
          </ul>
        </Modal>
      )}
    </div>
  );
}
