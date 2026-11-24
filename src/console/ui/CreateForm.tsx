"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { createResource } from "../actions.ts";
import { callServer } from "../call.ts";
import { groupBySection, initialValues, isFieldVisible, visibleValues } from "../form-state.ts";
import { detailPath } from "../meta.ts";
import type { FieldMeta, FieldValues, ResourceMeta } from "../types.ts";
import { FormFields } from "./FormFields.tsx";
import { Button, buttonClass, Container, ErrorBanner, PageHeader } from "./primitives.tsx";
import { useHydrated } from "./useHydrated.ts";

interface CreateFormProps {
  serviceId: string;
  resource: ResourceMeta;
  fields: FieldMeta[];
}

export function CreateForm({ serviceId, resource, fields }: CreateFormProps) {
  const router = useRouter();
  const [values, setValues] = useState<FieldValues>(() => initialValues(fields));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const hydrated = useHydrated();
  const listHref = `/${serviceId}/${resource.id}`;
  // CQ-5: a visible field whose options failed to load (it shows why) blocks the create.
  const optionsFailed = fields.some((f) => f.optionsError && isFieldVisible(f, values, fields));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || optionsFailed) return;
    setBusy(true);
    setError(null);
    const r = await callServer(() => createResource(serviceId, resource.id, visibleValues(fields, values)));
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    const target = resource.canGet || resource.detailHref ? detailPath(serviceId, resource, r.data.id) : listHref;
    router.push(`${target}?created=${encodeURIComponent(r.data.id)}`);
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="max-w-4xl space-y-5" data-testid="create-form">
      <PageHeader title={resource.createTitle ?? `Create ${resource.singular}`} description={resource.createDescription} />
      {groupBySection(fields).map((g) => (
        <Container key={g.section || "main"} title={g.section || undefined}>
          <FormFields fields={g.fields} values={values} onChange={(name, v) => setValues((prev) => ({ ...prev, [name]: v }))} />
        </Container>
      ))}
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {optionsFailed && <p className="text-right text-[13px] text-muted" data-testid="create-blocked">Some choices could not be loaded (shown above), so the form cannot be submitted.</p>}
      <div className="flex justify-end gap-2">
        <Link href={listHref} className={buttonClass("link")}>
          Cancel
        </Link>
        <Button variant="primary" type="submit" disabled={busy || !hydrated || optionsFailed} data-testid="create-submit">
          {busy ? "Creating…" : resource.createTitle ?? `Create ${resource.singular}`}
        </Button>
      </div>
    </form>
  );
}
