"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatCount } from "@/console/format";
import { Modal } from "@/console/ui/Modal";
import { Button, Container, EmptyState, ErrorBanner, Flash } from "@/console/ui/primitives";
import type { QuotaRow } from "./helpers";
import { requestIncrease } from "./quota-actions";

const input = "rounded-[4px] border border-[#879596] bg-white px-2.5 py-1.5 text-[13px] focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary";

/** A service's quotas with applied and AWS default values, and "Request increase at account level". */
export function QuotaTable({ serviceCode, quotas }: { serviceCode: string; quotas: QuotaRow[] }) {
  const router = useRouter();
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<QuotaRow | null>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const q = filter.trim().toLowerCase();
  const rows = quotas.filter((r) => q === "" || r.name.toLowerCase().includes(q) || r.code.toLowerCase().includes(q));

  async function submit() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    const r = await requestIncrease(serviceCode, selected.code, Number(value));
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setNotice(`Requested ${selected.name} = ${value}. Request ${r.data.id} is ${r.data.status}.`);
    setSelected(null);
    setValue("");
    router.refresh();
  }

  return (
    <Container title="Service quotas" counter={`(${quotas.length})`} description="Applied quota value is the value for this account; AWS default is the value new accounts start with.">
      {notice && <Flash kind="success" message={notice} onDismiss={() => setNotice(null)} />}
      <input type="search" aria-label="Find quotas" placeholder="Find quotas" className={`${input} my-3 w-full max-w-md`} value={filter} onChange={(e) => setFilter(e.target.value)} />
      {quotas.length === 0 ? (
        <EmptyState title="No quotas">AWS Emulator lists no quotas for this service.</EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left" data-testid="quota-table">
            <thead>
              <tr className="border-b-2 border-line-soft">
                <th className="px-2 py-2">Quota name</th>
                <th className="px-2 py-2">Applied account-level quota value</th>
                <th className="px-2 py-2">AWS default quota value</th>
                <th className="px-2 py-2">Adjustability</th>
                <th className="px-2 py-2">Quota code</th>
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.code} className="border-b border-line-soft align-top hover:bg-shade">
                  <td className="px-2 py-1.5">{r.name}</td>
                  <td className="px-2 py-1.5">
                    {r.applied === null ? "Not available" : formatCount(r.applied)} {r.unit ?? ""}
                    {r.applied !== null && r.defaultValue !== null && r.applied !== r.defaultValue && <span className="ml-1 text-muted">(increased)</span>}
                  </td>
                  <td className="px-2 py-1.5">
                    {formatCount(r.defaultValue)} {r.unit ?? ""}
                  </td>
                  <td className="px-2 py-1.5">{r.adjustable ? "Account level" : "Not adjustable"}</td>
                  <td className="px-2 py-1.5 font-mono text-[13px]">{r.code}</td>
                  <td className="px-2 py-1.5">
                    {r.adjustable && (
                      <Button aria-label={`Request increase for ${r.name}`} onClick={() => { setSelected(r); setValue(""); setError(null); }}>
                        Request increase
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <EmptyState title="No matches">No quotas match the filter.</EmptyState>}
        </div>
      )}
      <p className="mt-3 text-muted">
        Past requests are in <Link href="/servicequotas/history">Quota request history</Link>.
      </p>
      {selected && (
        <Modal
          title="Request quota increase"
          onClose={() => setSelected(null)}
          footer={
            <>
              <Button variant="link" onClick={() => setSelected(null)}>
                Cancel
              </Button>
              <Button variant="primary" disabled={busy || value === ""} onClick={() => void submit()} data-testid="submit-increase">
                {busy ? "Requesting…" : "Request"}
              </Button>
            </>
          }
        >
          <p>
            <strong>{selected.name}</strong> ({selected.code})
          </p>
          <p className="text-muted">Current applied value: {selected.applied ?? selected.defaultValue ?? "-"}</p>
          <label className="block space-y-1">
            <span className="font-bold">Increase quota value</span>
            <input aria-label="Increase quota value" type="number" className={`${input} w-full`} value={value} onChange={(e) => setValue(e.target.value)} />
          </label>
          {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
        </Modal>
      )}
    </Container>
  );
}
