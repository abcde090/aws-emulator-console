/**
 * Lambda Functions. The detail screen is hand-built (src/app/lambda/functions/[name]) so it can
 * hold the Code editor and the Test tab; its Configuration tabs and actions come from here.
 */

import {
  CreateFunctionCommand,
  CreateFunctionUrlConfigCommand,
  DeleteFunctionCommand,
  GetFunctionCommand,
  GetFunctionConcurrencyCommand,
  GetFunctionEventInvokeConfigCommand,
  GetFunctionUrlConfigCommand,
  GetPolicyCommand,
  type Architecture,
  type FunctionConfiguration,
  type Runtime,
} from "@aws-sdk/client-lambda";
import { FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import JSZip from "jszip";
import type { Ctx, ResourceDef, Row, Tag } from "../../console/types.ts";
import { functionActions, optional } from "./function-actions.ts";
import { FUNCTION_NAME, lambdaDate, policyStatements, RUNTIMES, starterCode } from "./helpers.ts";
import { allAliases, allFunctions, allMappings, allProvisioned, allVersions, createBasicRole, roleOptions } from "./sources.ts";

/** A secondary lookup on the function page: denied or failing lookups show in their own tab, not the whole page. */
interface Part<T> {
  value: T | null;
  error: string | null;
}

async function part<T>(fn: () => Promise<T>): Promise<Part<T>> {
  try {
    return { value: await optional(fn), error: null };
  } catch (err: unknown) {
    return { value: null, error: err instanceof Error ? err.message : String(err) };
  }
}

const unavailable = (p: Part<unknown>, text?: string): string | undefined => (p.error ? `Unavailable: ${p.error}` : text);

function functionRow(f: FunctionConfiguration): Row {
  return {
    name: f.FunctionName ?? "",
    description: f.Description || null,
    packageType: f.PackageType ?? null,
    runtime: f.Runtime ?? null,
    lastModified: lambdaDate(f.LastModified),
    codeSize: f.CodeSize ?? null,
    memory: f.MemorySize ?? null,
    timeout: f.Timeout ?? null,
    architecture: (f.Architectures ?? []).join(", ") || null,
    arn: f.FunctionArn ?? null,
  };
}

export async function zipSingleFile(fileName: string, code: string): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(fileName, code, { unixPermissions: 0o644 });
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE", platform: "UNIX" });
}

const TAG_COLUMNS = [
  { key: "Key", label: "Key", kind: "text" as const },
  { key: "Value", label: "Value", kind: "text" as const },
];

async function recentLogs(ctx: Ctx, name: string): Promise<Row[]> {
  try {
    const r = await ctx.clients.logs.send(new FilterLogEventsCommand({ logGroupName: `/aws/lambda/${name}`, limit: 100, startTime: Date.now() - 24 * 3600 * 1000 }));
    return (r.events ?? []).slice(-50).reverse().map((e) => ({ time: e.timestamp ? new Date(e.timestamp).toISOString() : null, stream: e.logStreamName ?? null, message: e.message ?? "" }));
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "ResourceNotFoundException") return [];
    throw err;
  }
}

export const functions: ResourceDef = {
  id: "functions",
  name: "Functions",
  singular: "function",
  idField: "name",
  nameField: "Function name",
  description: "Run code without provisioning servers. Choose a function to edit its code, test it and configure it.",
  emptyText: "There is no data to display. Create a function to get started.",
  columns: [
    { key: "name", label: "Function name", kind: "link" },
    { key: "description", label: "Description", kind: "text" },
    { key: "packageType", label: "Package type", kind: "text" },
    { key: "runtime", label: "Runtime", kind: "text" },
    { key: "lastModified", label: "Last modified", kind: "date" },
    { key: "codeSize", label: "Code size", kind: "bytes" },
    { key: "memory", label: "Memory (MB)", kind: "count", hidden: true },
    { key: "architecture", label: "Architecture", kind: "text", hidden: true },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],
  async list(ctx) {
    return (await allFunctions(ctx)).map(functionRow);
  },
  async get(ctx, name) {
    const lambda = ctx.clients.lambda;
    const f = await lambda.send(new GetFunctionCommand({ FunctionName: name }));
    const c = f.Configuration ?? {};
    const [policyP, urlP, concurrencyP, provisionedP, versionsP, aliasesP, mappingsP, invokeP, logsP] = await Promise.all([
      part(() => lambda.send(new GetPolicyCommand({ FunctionName: name }))),
      part(() => lambda.send(new GetFunctionUrlConfigCommand({ FunctionName: name }))),
      part(() => lambda.send(new GetFunctionConcurrencyCommand({ FunctionName: name }))),
      part(() => allProvisioned(ctx, name)),
      part(() => allVersions(ctx, name)),
      part(() => allAliases(ctx, name)),
      part(() => allMappings(ctx, name)),
      part(() => lambda.send(new GetFunctionEventInvokeConfigCommand({ FunctionName: name }))),
      part(() => recentLogs(ctx, name)),
    ]);
    const url = urlP.value;
    const concurrency = concurrencyP.value;
    const invokeConfig = invokeP.value;
    const statements = policyStatements(policyP.value?.Policy);
    return {
      summary: {
        "Function name": c.FunctionName ?? name,
        Description: c.Description || null,
        "Function ARN": c.FunctionArn ?? null,
        Runtime: c.Runtime ?? c.PackageType ?? null,
        Handler: c.Handler ?? null,
        Architecture: (c.Architectures ?? []).join(", ") || null,
        State: c.State ?? null,
        "Last modified": lambdaDate(c.LastModified),
        "Function URL": urlP.error ? "Unavailable (access denied or error)" : url?.FunctionUrl ?? null,
        Layers: c.Layers?.length ?? 0,
      },
      tabs: [
        {
          id: "general",
          label: "General configuration",
          kind: "keyvalue",
          data: {
            Description: c.Description || null,
            Memory: c.MemorySize !== undefined ? `${c.MemorySize} MB` : null,
            "Ephemeral storage": c.EphemeralStorage?.Size !== undefined ? `${c.EphemeralStorage.Size} MB` : null,
            Timeout: c.Timeout !== undefined ? `${Math.floor(c.Timeout / 60)} min ${c.Timeout % 60} sec` : null,
            "Package type": c.PackageType ?? null,
            "Code size": c.CodeSize ?? null,
            "Code SHA-256": c.CodeSha256 ?? null,
            SnapStart: c.SnapStart?.ApplyOn ?? null,
            "Tracing (X-Ray)": c.TracingConfig?.Mode ?? null,
            "Log group": c.LoggingConfig?.LogGroup ?? `/aws/lambda/${name}`,
            "Log format": c.LoggingConfig?.LogFormat ?? null,
            "Last update status": c.LastUpdateStatus ?? null,
            "Revision ID": c.RevisionId ?? null,
          },
        },
        {
          id: "environment",
          label: "Environment variables",
          kind: "table",
          columns: TAG_COLUMNS,
          data: Object.entries(c.Environment?.Variables ?? {}).map(([Key, Value]) => ({ Key, Value })),
          emptyText: "No environment variables. Use Actions › Edit environment variables.",
        },
        {
          id: "permissions",
          label: "Permissions",
          kind: "table",
          description: `Execution role: ${c.Role ?? "-"}. ${unavailable(policyP, "Resource-based policy statements:")}`,
          columns: [
            { key: "sid", label: "Statement ID", kind: "text" },
            { key: "principal", label: "Principal", kind: "text" },
            { key: "action", label: "Action", kind: "text" },
            { key: "effect", label: "Effect", kind: "text" },
            { key: "conditions", label: "Conditions", kind: "code" },
          ],
          data: statements,
          emptyText: "No resource-based policy. Other accounts and AWS services can't invoke this function until you add a permission.",
        },
        {
          id: "triggers",
          label: "Triggers",
          kind: "table",
          description: [unavailable(mappingsP), unavailable(policyP), "Event source mappings that poll a queue or stream, plus AWS services allowed to invoke the function by its resource-based policy."].filter(Boolean).join(" "),
          columns: [
            { key: "trigger", label: "Trigger", kind: "text", href: "/lambda/event-source-mappings/{uuid}" },
            { key: "detail", label: "Details", kind: "text" },
            { key: "state", label: "State", kind: "status" },
          ],
          data: [
            ...(mappingsP.value ?? []).map((m) => ({ trigger: m.EventSourceArn ?? m.UUID ?? null, detail: `Event source mapping ${m.UUID}, batch size ${m.BatchSize ?? "-"}`, state: m.State ?? null, uuid: m.UUID ?? null })),
            ...statements.filter((s) => s.principal?.endsWith(".amazonaws.com")).map((s) => ({ trigger: s.principal, detail: `Permission ${s.sid}${s.conditions ? ` ${s.conditions}` : ""}`, state: null })),
          ],
          emptyText: "No triggers. Add an event source mapping on the Event source mappings page, or a permission for an AWS service.",
        },
        {
          id: "concurrency",
          label: "Concurrency",
          kind: "table",
          description: [
            concurrencyP.error ? `Function concurrency: unavailable (${concurrencyP.error}).` : `Function concurrency: ${concurrency?.ReservedConcurrentExecutions !== undefined ? `${concurrency.ReservedConcurrentExecutions} reserved` : "Use unreserved account concurrency"}.`,
            unavailable(provisionedP, "Provisioned concurrency configurations:"),
          ].join(" "),
          columns: [
            { key: "qualifier", label: "Qualifier", kind: "text" },
            { key: "requested", label: "Requested", kind: "count" },
            { key: "allocated", label: "Allocated", kind: "count" },
            { key: "status", label: "Status", kind: "status" },
          ],
          data: (provisionedP.value ?? []).map((p) => ({ qualifier: p.FunctionArn?.split(":").pop() ?? null, requested: p.RequestedProvisionedConcurrentExecutions ?? null, allocated: p.AllocatedProvisionedConcurrentExecutions ?? null, status: p.Status ?? null })),
          emptyText: "No provisioned concurrency configurations.",
        },
        {
          id: "async",
          label: "Asynchronous invocation",
          kind: "keyvalue",
          description: unavailable(invokeP),
          data: invokeConfig
            ? { "Maximum age of event": invokeConfig.MaximumEventAgeInSeconds ?? null, "Retry attempts": invokeConfig.MaximumRetryAttempts ?? null, "On-success destination": invokeConfig.DestinationConfig?.OnSuccess?.Destination ?? null, "On-failure destination": invokeConfig.DestinationConfig?.OnFailure?.Destination ?? null }
            : {},
          emptyText: "Defaults: maximum age of event 6 h, 2 retry attempts (no event invoke configuration set).",
        },
        {
          id: "versions",
          label: "Versions",
          kind: "table",
          columns: [
            { key: "version", label: "Version", kind: "text" },
            { key: "description", label: "Description", kind: "text" },
            { key: "lastModified", label: "Last modified", kind: "date" },
            { key: "sha", label: "Code SHA-256", kind: "code" },
          ],
          description: unavailable(versionsP),
          data: (versionsP.value ?? []).map((x) => ({ version: x.Version ?? null, description: x.Description || null, lastModified: lambdaDate(x.LastModified), sha: x.CodeSha256 ?? null })),
        },
        {
          id: "aliases",
          label: "Aliases",
          kind: "table",
          columns: [
            { key: "name", label: "Name", kind: "text" },
            { key: "version", label: "Version", kind: "text" },
            { key: "description", label: "Description", kind: "text" },
            { key: "arn", label: "ARN", kind: "arn" },
          ],
          description: unavailable(aliasesP),
          data: (aliasesP.value ?? []).map((a) => ({ name: a.Name ?? null, version: a.FunctionVersion ?? null, description: a.Description || null, arn: a.AliasArn ?? null })),
          emptyText: "No aliases.",
        },
        {
          id: "layers",
          label: "Layers",
          kind: "table",
          columns: [
            { key: "arn", label: "Layer version ARN", kind: "arn" },
            { key: "size", label: "Code size", kind: "bytes" },
          ],
          data: (c.Layers ?? []).map((l) => ({ arn: l.Arn ?? null, size: l.CodeSize ?? null })),
          emptyText: "This function uses no layers.",
        },
        {
          id: "url",
          label: "Function URL",
          kind: "keyvalue",
          description: unavailable(urlP),
          data: url ? { "Function URL": url.FunctionUrl ?? null, "Auth type": url.AuthType ?? null, "Invoke mode": url.InvokeMode ?? null, Created: url.CreationTime ?? null, CORS: url.Cors ? JSON.stringify(url.Cors) : null } : {},
          emptyText: "No function URL. Use Actions › Create function URL.",
        },
        {
          id: "monitor",
          label: "Monitor (logs)",
          kind: "table",
          description: unavailable(logsP, `Recent events from CloudWatch Logs group /aws/lambda/${name} (last 24 hours, newest first).`),
          columns: [
            { key: "time", label: "Timestamp", kind: "date" },
            { key: "message", label: "Message", kind: "code" },
            { key: "stream", label: "Log stream", kind: "text" },
          ],
          data: logsP.value ?? [],
          emptyText: "No log events yet. Invoke the function from the Test tab.",
        },
        { id: "tags", label: "Tags", kind: "table", columns: TAG_COLUMNS, data: Object.entries(f.Tags ?? {}).map(([Key, Value]) => ({ Key, Value })), emptyText: "No tags." },
      ],
    };
  },
  create: {
    title: "Create function",
    description: "Author from scratch: starts with a simple Hello World example. Calls CreateFunction with a starter deployment package.",
    fields: [
      { name: "name", label: "Function name", kind: "text", required: true, section: "Basic information", placeholder: "myFunctionName", help: "Up to 64 letters, numbers, hyphens and underscores, with no spaces.", validate: { pattern: FUNCTION_NAME, message: "Up to 64 letters, numbers, hyphens or underscores." } },
      { name: "runtime", label: "Runtime", kind: "select", required: true, default: "nodejs24.x", section: "Basic information", help: "Choose the language to use to write your function.", options: RUNTIMES.map((r) => ({ value: r.id, label: r.label })) },
      { name: "architecture", label: "Architecture", kind: "radio", default: "x86_64", section: "Basic information", options: [{ value: "x86_64", label: "x86_64" }, { value: "arm64", label: "arm64" }] },
      { name: "roleMode", label: "Execution role", kind: "radio", default: "new", section: "Permissions", options: [{ value: "new", label: "Create a new role with basic Lambda permissions" }, { value: "existing", label: "Use an existing role" }] },
      { name: "role", label: "Existing role", kind: "select", required: true, options: roleOptions, section: "Permissions", showIf: { field: "roleMode", equals: "existing" }, help: "The role must trust lambda.amazonaws.com." },
      { name: "functionUrl", label: "Enable function URL", kind: "checkbox", default: false, section: "Additional configurations", help: "Assigns an HTTP(S) endpoint to the function." },
      { name: "urlAuth", label: "Auth type", kind: "radio", default: "AWS_IAM", section: "Additional configurations", showIf: { field: "functionUrl", equals: true }, options: [{ value: "AWS_IAM", label: "AWS_IAM" }, { value: "NONE", label: "NONE" }] },
      { name: "tags", label: "Tags", kind: "tags", section: "Additional configurations" },
    ],
    async run(ctx, v) {
      const name = String(v.name);
      const runtime = String(v.runtime);
      const starter = starterCode(runtime);
      const role = v.roleMode === "existing" ? String(v.role) : await createBasicRole(ctx, name);
      const tags = Array.isArray(v.tags) ? (v.tags as Tag[]) : [];
      await ctx.clients.lambda.send(
        new CreateFunctionCommand({
          FunctionName: name,
          Runtime: runtime as Runtime,
          Role: role,
          Handler: starter.handler,
          Architectures: [(v.architecture === "arm64" ? "arm64" : "x86_64") as Architecture],
          Code: { ZipFile: await zipSingleFile(starter.fileName, starter.code) },
          Tags: tags.length ? Object.fromEntries(tags.map((t) => [t.Key, t.Value])) : undefined,
        })
      );
      if (v.functionUrl === true) await ctx.clients.lambda.send(new CreateFunctionUrlConfigCommand({ FunctionName: name, AuthType: v.urlAuth === "NONE" ? "NONE" : "AWS_IAM" }));
      return name;
    },
  },
  actions: functionActions,
  delete: {
    confirmText: "delete",
    async run(ctx, name) {
      await ctx.clients.lambda.send(new DeleteFunctionCommand({ FunctionName: name }));
    },
  },
  detailHref: "functions/{id}",
};
