"use client";

/**
 * The console's stack wizard: specify template -> stack details (parameters generated from
 * the template) -> stack options -> review. In "changeset" mode it builds a change set for an
 * existing stack instead, and in "update" mode it makes a direct update (UpdateStack).
 * Submits through the engine's createResource / runAction.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { createResource, runAction } from "@/console/actions";
import { FormFields } from "@/console/ui/FormFields";
import { Button, buttonClass, Container, ErrorBanner, PageHeader } from "@/console/ui/primitives";
import type { FieldMeta, FieldValue, FieldValues, Tag } from "@/console/types";
import { CAPABILITY_TEXT, changeSetHref, isCapability, parameterFields, parameterList, type CurrentParameter } from "./helpers";
import { summarizeTemplate, type TemplateSummary } from "./stack-actions";

interface StackWizardProps {
  mode: "create" | "changeset" | "update";
  stackName?: string;
  currentParameters?: CurrentParameter[];
}

const STEPS_CREATE = ["Specify template", "Specify stack details", "Configure stack options", "Review and create"];
const STEPS_CHANGESET = ["Specify template", "Specify change set details", "Review"];
const STEPS_UPDATE = ["Specify template", "Specify stack details", "Review"];

function templateFields(mode: StackWizardProps["mode"]): FieldMeta[] {
  const options =
    mode !== "create"
      ? [
          { value: "current", label: "Use current template" },
          { value: "body", label: "Replace current template: paste a template (JSON or YAML)" },
          { value: "url", label: "Replace current template: Amazon S3 URL" },
        ]
      : [
          { value: "body", label: "Paste a template (JSON or YAML)" },
          { value: "url", label: "Amazon S3 URL" },
        ];
  return [
    { name: "templateSource", label: mode !== "create" ? "Prepare template" : "Template source", kind: "radio", options, default: options[0].value },
    { name: "templateBody", label: "Template body", kind: "textarea", placeholder: '{"Resources": {...}}', showIf: { field: "templateSource", equals: "body" }, help: "A CloudFormation template in JSON or YAML, at most 51,200 bytes." },
    { name: "templateUrl", label: "Amazon S3 URL", kind: "text", placeholder: "https://bucket.s3.amazonaws.com/template.yaml", showIf: { field: "templateSource", equals: "url" }, help: "The template must be in an S3 bucket in the emulator." },
  ];
}

const optionFields: FieldMeta[] = [
  { name: "tags", label: "Tags", kind: "tags", help: "Tags are applied to the stack and to every resource it creates that supports tags.", section: "Tags" },
  { name: "terminationProtection", label: "Termination protection", kind: "checkbox", default: false, help: "Prevents the stack from being accidentally deleted.", section: "Stack failure options" },
  {
    name: "onFailure", label: "Behavior on provisioning failure", kind: "radio", default: "ROLLBACK", section: "Stack failure options",
    options: [
      { value: "ROLLBACK", label: "Roll back all stack resources" },
      { value: "DO_NOTHING", label: "Preserve successfully provisioned resources" },
      { value: "DELETE", label: "Delete all stack resources" },
    ],
  },
];

function initial(fields: FieldMeta[]): FieldValues {
  return Object.fromEntries(fields.map((f) => [f.name, f.default !== undefined ? f.default : f.kind === "checkbox" ? false : f.kind === "tags" ? [] : f.kind === "radio" ? f.options?.[0]?.value ?? "" : ""]));
}

export function StackWizard({ mode, stackName, currentParameters = [] }: StackWizardProps) {
  const router = useRouter();
  const steps = mode === "create" ? STEPS_CREATE : mode === "update" ? STEPS_UPDATE : STEPS_CHANGESET;
  const tFields = useMemo(() => templateFields(mode), [mode]);
  const [step, setStep] = useState(0);
  const [values, setValues] = useState<FieldValues>(() => initial([...tFields, ...optionFields]));
  const [summary, setSummary] = useState<TemplateSummary | null>(null);
  const [acks, setAcks] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cancelHref = mode === "create" ? "/cloudformation/stacks" : `/cloudformation/stacks/${encodeURIComponent(stackName ?? "")}`;

  const nameFields: FieldMeta[] =
    mode === "create"
      ? [{ name: "stackName", label: "Stack name", kind: "text", required: true, placeholder: "Enter a stack name", help: "Can include letters (A-Z and a-z), numbers (0-9), and dashes (-). Must start with a letter." }]
      : mode === "update"
        ? []
        : [
            { name: "changeSetName", label: "Change set name", kind: "text", required: true, placeholder: "Enter a change set name", help: "Letters, numbers and dashes. Must start with a letter." },
            { name: "description", label: "Description", kind: "textarea" },
          ];
  const pFields = useMemo(() => (summary ? parameterFields(summary.parameters, currentParameters) : []), [summary, currentParameters]);
  const set = (name: string, v: FieldValue) => setValues((prev) => ({ ...prev, [name]: v }));

  async function loadTemplate() {
    setBusy(true);
    setError(null);
    const r = await summarizeTemplate({ source: String(values.templateSource), body: String(values.templateBody ?? ""), url: String(values.templateUrl ?? ""), stackName });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setSummary(r.data);
    setValues((prev) => ({ ...initial(parameterFields(r.data.parameters, currentParameters)), ...Object.fromEntries(Object.entries(prev).filter(([k]) => !k.startsWith("param:"))) }));
    setAcks([]);
    setStep(1);
  }

  function checkDetails(): boolean {
    if (mode === "update") return true;
    const key = mode === "create" ? "stackName" : "changeSetName";
    const v = String(values[key] ?? "").trim();
    if (!/^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(v)) {
      setError(`${mode === "create" ? "Stack" : "Change set"} name: start with a letter and use only letters, numbers and dashes (up to 128 characters).`);
      return false;
    }
    setError(null);
    return true;
  }

  async function submit() {
    if (!summary) return;
    const missing = summary.capabilities.filter((c) => !acks.includes(c));
    if (missing.length) return setError(`Acknowledge the required capabilities: ${missing.join(", ")}.`);
    const parameters = JSON.stringify(parameterList(summary.parameters, values, currentParameters));
    const template = { templateSource: values.templateSource, templateBody: values.templateBody, templateUrl: values.templateUrl };
    const capabilities = acks.filter(isCapability);
    setBusy(true);
    setError(null);
    if (mode === "create") {
      const r = await createResource("cloudformation", "stacks", {
        stackName: String(values.stackName ?? "").trim(),
        ...template,
        parameters,
        tags: (values.tags as Tag[]).filter((t) => t.Key.trim() !== ""),
        terminationProtection: values.terminationProtection === true,
        onFailure: values.onFailure,
        capabilities,
      });
      setBusy(false);
      if (!r.ok) return setError(r.error);
      router.push(`/cloudformation/stacks/${encodeURIComponent(r.data.id)}?created=${encodeURIComponent(r.data.id)}`);
      router.refresh();
      return;
    }
    if (mode === "update") {
      const u = await runAction("cloudformation", "stacks", stackName ?? "", "update-stack", { ...template, parameters, capabilities });
      setBusy(false);
      if (!u.ok) return setError(u.error);
      router.push(`/cloudformation/stacks/${encodeURIComponent(stackName ?? "")}?updated=1`);
      router.refresh();
      return;
    }
    const name = String(values.changeSetName ?? "").trim();
    const r = await runAction("cloudformation", "stacks", stackName ?? "", "create-change-set", {
      changeSetName: name,
      description: values.description ?? "",
      ...template,
      parameters,
      capabilities,
    });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    router.push(`${changeSetHref(stackName ?? "", name)}?created=1`);
    router.refresh();
  }

  const last = step === steps.length - 1;
  return (
    <div className="max-w-4xl space-y-5" data-testid="stack-wizard">
      <PageHeader
        title={mode === "create" ? "Create stack" : mode === "update" ? `Update stack ${stackName}` : `Create change set for ${stackName}`}
        description={`Step ${step + 1} of ${steps.length}: ${steps[step]}`}
      />
      <ol className="flex flex-wrap gap-4 text-[13px]">
        {steps.map((s, i) => (
          <li key={s} className={i === step ? "font-bold text-primary" : "text-muted"}>
            Step {i + 1}: {s}
          </li>
        ))}
      </ol>

      {step === 0 && (
        <Container title={mode === "create" ? "Specify template" : "Prerequisite - Prepare template"} description="A template is a JSON or YAML file that describes your stack's resources and properties.">
          <FormFields fields={tFields} values={values} onChange={set} />
        </Container>
      )}

      {step === 1 && (
        <>
          {nameFields.length > 0 && (
            <Container title={mode === "create" ? "Provide a stack name" : "Change set name"}>
              <FormFields fields={nameFields} values={values} onChange={set} />
            </Container>
          )}
          <Container title="Parameters" description="Parameters are defined in your template and let you input custom values when you create or update a stack.">
            {pFields.length === 0 ? <p className="text-muted">No parameters. There are no parameters defined in your template.</p> : <FormFields fields={pFields} values={values} onChange={set} />}
          </Container>
        </>
      )}

      {mode === "create" && step === 2 && (
        <>
          <Container title="Tags - optional">
            <FormFields fields={optionFields.filter((f) => f.section === "Tags")} values={values} onChange={set} />
          </Container>
          <Container title="Stack failure options">
            <FormFields fields={optionFields.filter((f) => f.section === "Stack failure options")} values={values} onChange={set} />
          </Container>
        </>
      )}

      {last && summary && (
        <>
          <Container title="Review">
            <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2" data-testid="wizard-review">
              <dt className="font-bold">{mode === "changeset" ? "Change set name" : "Stack name"}</dt>
              <dd>{mode === "update" ? stackName : String(values[mode === "create" ? "stackName" : "changeSetName"] ?? "")}</dd>
              <dt className="font-bold">Template</dt>
              <dd>{values.templateSource === "url" ? String(values.templateUrl) : values.templateSource === "current" ? "Current template" : "Pasted template"}</dd>
              <dt className="font-bold">Template description</dt>
              <dd>{summary.description ?? "-"}</dd>
              <dt className="font-bold">Resource types</dt>
              <dd>{summary.resourceTypes.join(", ") || "-"}</dd>
              {summary.parameters.map((p) => (
                <div key={p.key} className="contents">
                  <dt className="font-bold">Parameter {p.key}</dt>
                  <dd>{p.noEcho ? "****" : String(values[`param:${p.key}`] ?? "") || "-"}</dd>
                </div>
              ))}
              {mode === "create" && (
                <>
                  <dt className="font-bold">Termination protection</dt>
                  <dd>{values.terminationProtection === true ? "Activated" : "Deactivated"}</dd>
                  <dt className="font-bold">Behavior on provisioning failure</dt>
                  <dd>{String(values.onFailure)}</dd>
                </>
              )}
            </dl>
          </Container>
          {summary.capabilities.length > 0 && (
            <Container title="Capabilities" description={summary.capabilitiesReason ?? "The template contains resources that need your acknowledgement."}>
              <div className="space-y-2">
                {summary.capabilities.map((c) => (
                  <label key={c} className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-1 size-4"
                      checked={acks.includes(c)}
                      onChange={(e) => setAcks((prev) => (e.target.checked ? [...prev, c] : prev.filter((x) => x !== c)))}
                    />
                    <span>{isCapability(c) ? CAPABILITY_TEXT[c] : c}</span>
                  </label>
                ))}
              </div>
            </Container>
          )}
        </>
      )}

      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      <div className="flex justify-end gap-2">
        <Link href={cancelHref} className={buttonClass("link")}>
          Cancel
        </Link>
        {step > 0 && (
          <Button disabled={busy} onClick={() => { setError(null); setStep(step - 1); }}>
            Previous
          </Button>
        )}
        {step === 0 && (
          <Button variant="primary" disabled={busy} onClick={loadTemplate}>
            {busy ? "Reading template…" : "Next"}
          </Button>
        )}
        {step > 0 && !last && (
          <Button variant="primary" disabled={busy} onClick={() => { if (step !== 1 || checkDetails()) setStep(step + 1); }}>
            Next
          </Button>
        )}
        {last && (
          <Button variant="primary" disabled={busy} onClick={submit}>
            {busy ? "Submitting…" : mode === "create" ? "Submit" : mode === "update" ? "Update stack" : "Create change set"}
          </Button>
        )}
      </div>
    </div>
  );
}
