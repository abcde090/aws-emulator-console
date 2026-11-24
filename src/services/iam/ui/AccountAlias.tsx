"use client";

/** The Dashboard's "AWS Account" panel: account ID and the account alias (create / delete). */

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Container, ErrorBanner, Flash } from "@/console/ui/primitives";
import { KeyValue } from "@/console/ui/KeyValue";
import { createAccountAlias, deleteAccountAlias } from "../editor-actions";

export function AccountAlias({ accountId, alias }: { accountId: string; alias: string | null }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function run(fn: () => ReturnType<typeof createAccountAlias>) {
    setBusy(true);
    setError(null);
    const r = await fn();
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setNotice(r.data);
    setEditing(false);
    setValue("");
    router.refresh();
  }

  return (
    <Container
      title="AWS Account"
      actions={
        alias ? (
          <Button variant="danger" disabled={busy} onClick={() => run(() => deleteAccountAlias(alias))}>Delete alias</Button>
        ) : (
          !editing && <Button onClick={() => setEditing(true)}>Create alias</Button>
        )
      }
    >
      <div className="space-y-3">
        {notice && <Flash kind="success" message={notice} onDismiss={() => setNotice(null)} />}
        {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
        <KeyValue
          data={{
            "Account ID": accountId,
            "Account Alias": alias ?? "None",
            "Sign-in URL for IAM users in this account": `https://${alias ?? accountId}.signin.aws.amazon.com/console`,
          }}
        />
        {editing && (
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex-1 space-y-1">
              <span className="block font-bold">Preferred alias</span>
              <input aria-label="Preferred alias" className="w-full rounded-[4px] border border-[#879596] bg-white px-2.5 py-1" value={value} onChange={(e) => setValue(e.target.value)} />
            </label>
            <Button variant="link" onClick={() => setEditing(false)}>Cancel</Button>
            <Button variant="primary" disabled={busy || value.trim() === ""} onClick={() => run(() => createAccountAlias(value))}>Save changes</Button>
          </div>
        )}
      </div>
    </Container>
  );
}
