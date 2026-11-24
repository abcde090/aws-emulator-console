"use client";

/** Create layer: upload a .zip with PublishLayerVersion. Publishing again with the same name creates a new version. */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, buttonClass, Container, ErrorBanner } from "@/console/ui/primitives";
import { publishLayerFromForm } from "./code-actions";
import { RUNTIMES } from "./helpers";

const inputClass = "w-full rounded-[4px] border border-[#879596] bg-white px-2.5 py-1.5 text-[13px] focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary";

export function LayerCreate() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await publishLayerFromForm(new FormData(e.currentTarget));
    setBusy(false);
    if (!r.ok) return setError(r.error);
    router.push(`/lambda/layers/${encodeURIComponent(r.data.name)}?created=${encodeURIComponent(`${r.data.name}:${r.data.version ?? ""}`)}`);
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="max-w-4xl space-y-5" data-testid="layer-form">
      <Container title="Layer configuration">
        <div className="space-y-4">
          <label className="block space-y-1">
            <span className="font-bold">Name</span>
            <input name="name" aria-label="Name" required pattern="[a-zA-Z0-9_-]{1,64}" className={inputClass} placeholder="my-layer" />
            <span className="block text-[13px] text-muted">Up to 64 letters, numbers, hyphens and underscores. Using an existing name publishes a new version.</span>
          </label>
          <label className="block space-y-1">
            <span className="font-bold">Description</span> <span className="italic text-muted">- optional</span>
            <input name="description" aria-label="Description" maxLength={256} className={inputClass} />
          </label>
          <label className="block space-y-1">
            <span className="font-bold">Upload a .zip file</span>
            <input name="zip" aria-label="Upload a .zip file" type="file" accept=".zip,application/zip" required className="block" />
            <span className="block text-[13px] text-muted">For files larger than 10 MB, consider uploading using Amazon S3. Direct uploads are limited to 50 MB.</span>
          </label>
          <fieldset className="space-y-1">
            <legend className="font-bold">Compatible architectures - optional</legend>
            <label className="mr-4"><input type="checkbox" name="architectures" value="x86_64" /> x86_64</label>
            <label><input type="checkbox" name="architectures" value="arm64" /> arm64</label>
          </fieldset>
          <label className="block space-y-1">
            <span className="font-bold">Compatible runtimes</span> <span className="italic text-muted">- optional (up to 15)</span>
            <select name="runtimes" aria-label="Compatible runtimes" multiple className={`${inputClass} min-h-32`}>
              {RUNTIMES.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1">
            <span className="font-bold">License</span> <span className="italic text-muted">- optional</span>
            <input name="license" aria-label="License" maxLength={512} className={inputClass} placeholder="MIT or https://opensource.org/licenses/MIT" />
          </label>
        </div>
      </Container>
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      <div className="flex justify-end gap-2">
        <Link href="/lambda/layers" className={buttonClass("link")}>
          Cancel
        </Link>
        <Button variant="primary" type="submit" disabled={busy}>
          {busy ? "Creating…" : "Create"}
        </Button>
      </div>
    </form>
  );
}
