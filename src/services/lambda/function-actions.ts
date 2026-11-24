/**
 * Actions on a Lambda function. Every "Edit …" dialog opens with the function's current
 * settings (initialValues) and sends only what the user changed, so saving untouched
 * changes nothing.
 */

import {
  AddPermissionCommand,
  CreateAliasCommand,
  CreateFunctionUrlConfigCommand,
  DeleteAliasCommand,
  DeleteFunctionConcurrencyCommand,
  DeleteFunctionUrlConfigCommand,
  GetFunctionCommand,
  GetFunctionConcurrencyCommand,
  GetFunctionConfigurationCommand,
  GetFunctionEventInvokeConfigCommand,
  GetPolicyCommand,
  PublishVersionCommand,
  PutFunctionConcurrencyCommand,
  PutFunctionEventInvokeConfigCommand,
  PutProvisionedConcurrencyConfigCommand,
  RemovePermissionCommand,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateFunctionConfigurationCommand,
  type FunctionConfiguration,
  type Runtime,
} from "@aws-sdk/client-lambda";
import type { ActionDef, Ctx, Row, Tag } from "../../console/types.ts";
import { fieldTags, recordTagDiff, tagDiffMessage, tagsToRecord } from "../../console/tags.ts";
import { envFromPairs, generalPatch, pairsFrom, policyStatements, RUNTIMES, sameRecord } from "./helpers.ts";
import { allAliases, layerVersionOptions, qualifierOptions, roleOptions, versionOptions } from "./sources.ts";

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : []);
const opt = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const optNum = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const NO_CHANGES = { message: "No changes to save." };

/** Async invocation defaults when the function has no event invoke configuration. */
const DEFAULT_MAX_AGE = 21600;
const DEFAULT_RETRIES = 2;

/** Null when Lambda says the thing doesn't exist (no policy, no URL, no concurrency setting …). */
export async function optional<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "ResourceNotFoundException") return null;
    throw err;
  }
}

function config(ctx: Ctx, name: string): Promise<FunctionConfiguration> {
  return ctx.clients.lambda.send(new GetFunctionConfigurationCommand({ FunctionName: name }));
}

/** The detail summary carries "Function URL"; list rows don't, so they count as unknown. */
function urlState(row: Row): "yes" | "no" | "unknown" {
  if (!("Function URL" in row)) return "unknown";
  const v = row["Function URL"];
  if (v === null || v === undefined || v === "") return "no";
  return typeof v === "string" && v.startsWith("Unavailable") ? "unknown" : "yes";
}

const configActions: ActionDef[] = [
  {
    id: "general",
    label: "Edit general configuration",
    fields: [
      { name: "description", label: "Description", kind: "text", validate: { max: 256, message: "At most 256 characters." } },
      { name: "memory", label: "Memory (MB)", kind: "number", default: 128, required: true, help: "128 MB to 10240 MB.", validate: { min: 128, max: 10240, message: "Between 128 and 10240 MB." } },
      { name: "ephemeral", label: "Ephemeral storage (MB)", kind: "number", default: 512, required: true, validate: { min: 512, max: 10240, message: "Between 512 and 10240 MB." } },
      { name: "timeout", label: "Timeout (seconds)", kind: "number", default: 3, required: true, validate: { min: 1, max: 900, message: "Between 1 second and 15 minutes (900)." } },
      { name: "role", label: "Execution role", kind: "select", options: roleOptions, help: "The role the function assumes. Leave as - to keep the current role." },
    ],
    async initialValues(ctx, name) {
      const c = await config(ctx, name);
      return { description: c.Description ?? "", memory: c.MemorySize ?? 128, ephemeral: c.EphemeralStorage?.Size ?? 512, timeout: c.Timeout ?? 3, role: c.Role ?? "" };
    },
    async run(ctx, name, v) {
      const patch = generalPatch(await config(ctx, name), { description: typeof v.description === "string" ? v.description : "", memory: optNum(v.memory), ephemeral: optNum(v.ephemeral), timeout: optNum(v.timeout), role: opt(v.role) });
      if (Object.keys(patch).length === 0) return NO_CHANGES;
      await ctx.clients.lambda.send(new UpdateFunctionConfigurationCommand({ FunctionName: name, ...patch }));
      return { message: "Successfully updated the function's general configuration." };
    },
  },
  {
    id: "runtime",
    label: "Edit runtime settings",
    fields: [
      { name: "runtime", label: "Runtime", kind: "select", required: true, options: RUNTIMES.map((r) => ({ value: r.id, label: r.label })) },
      { name: "handler", label: "Handler", kind: "text", required: true, help: "file.function, e.g. index.handler or lambda_function.lambda_handler.", validate: { pattern: "[^\\s]{1,128}", message: "Up to 128 characters, no spaces." } },
    ],
    async initialValues(ctx, name) {
      const c = await config(ctx, name);
      return { runtime: c.Runtime ?? "", handler: c.Handler ?? "" };
    },
    async run(ctx, name, v) {
      const c = await config(ctx, name);
      const runtime = String(v.runtime);
      const handler = String(v.handler);
      const patch = { ...(runtime !== c.Runtime ? { Runtime: runtime as Runtime } : {}), ...(handler !== c.Handler ? { Handler: handler } : {}) };
      if (Object.keys(patch).length === 0) return NO_CHANGES;
      await ctx.clients.lambda.send(new UpdateFunctionConfigurationCommand({ FunctionName: name, ...patch }));
      return { message: `Runtime settings updated: ${runtime}, handler ${handler}.` };
    },
  },
  {
    id: "environment",
    label: "Edit environment variables",
    fields: [{ name: "variables", label: "Environment variables", kind: "tags", help: "Values are visible to anyone who can read the function's configuration." }],
    async initialValues(ctx, name) {
      return { variables: pairsFrom((await config(ctx, name)).Environment?.Variables) };
    },
    async run(ctx, name, v) {
      const vars = envFromPairs(Array.isArray(v.variables) ? (v.variables as Tag[]) : []);
      if (sameRecord(vars, (await config(ctx, name)).Environment?.Variables ?? {})) return NO_CHANGES;
      await ctx.clients.lambda.send(new UpdateFunctionConfigurationCommand({ FunctionName: name, Environment: { Variables: vars } }));
      return { message: `Saved ${Object.keys(vars).length} environment variable(s).` };
    },
  },
  {
    id: "layers",
    label: "Edit layers",
    fields: [{ name: "layers", label: "Layers", kind: "multiselect", options: layerVersionOptions, help: "At most 5, merged in the order chosen. Select none to remove all." }],
    async initialValues(ctx, name) {
      return { layers: ((await config(ctx, name)).Layers ?? []).map((l) => l.Arn ?? "").filter((a) => a !== "") };
    },
    async run(ctx, name, v) {
      const layers = strs(v.layers);
      if (layers.length > 5) throw new Error("A function can use at most 5 layers.");
      const current = ((await config(ctx, name)).Layers ?? []).map((l) => l.Arn ?? "");
      if (current.length === layers.length && current.every((a, i) => a === layers[i])) return NO_CHANGES;
      await ctx.clients.lambda.send(new UpdateFunctionConfigurationCommand({ FunctionName: name, Layers: layers }));
      return { message: `Function now uses ${layers.length} layer(s).` };
    },
  },
  {
    id: "concurrency",
    label: "Edit concurrency",
    fields: [
      { name: "mode", label: "Concurrency", kind: "radio", default: "unreserved", options: [{ value: "unreserved", label: "Use unreserved account concurrency" }, { value: "reserved", label: "Reserve concurrency" }] },
      { name: "reserved", label: "Reserved concurrency", kind: "number", required: true, showIf: { field: "mode", equals: "reserved" }, help: "0 throttles every invocation.", validate: { min: 0, max: 1000, message: "Between 0 and 1000." } },
    ],
    async initialValues(ctx, name) {
      const r = (await ctx.clients.lambda.send(new GetFunctionConcurrencyCommand({ FunctionName: name }))).ReservedConcurrentExecutions;
      return r === undefined ? { mode: "unreserved", reserved: null } : { mode: "reserved", reserved: r };
    },
    async run(ctx, name, v) {
      const current = (await ctx.clients.lambda.send(new GetFunctionConcurrencyCommand({ FunctionName: name }))).ReservedConcurrentExecutions;
      if (v.mode === "reserved") {
        const wanted = Number(v.reserved);
        if (current === wanted) return NO_CHANGES;
        await ctx.clients.lambda.send(new PutFunctionConcurrencyCommand({ FunctionName: name, ReservedConcurrentExecutions: wanted }));
        return { message: `Reserved concurrency set to ${wanted}.` };
      }
      if (current === undefined) return NO_CHANGES;
      await ctx.clients.lambda.send(new DeleteFunctionConcurrencyCommand({ FunctionName: name }));
      return { message: "The function now uses unreserved account concurrency." };
    },
  },
  {
    id: "provisioned",
    label: "Add provisioned concurrency",
    fields: [
      { name: "qualifier", label: "Alias or version", kind: "select", required: true, options: qualifierOptions, help: "Provisioned concurrency can't be set on $LATEST. Publish a version or create an alias first." },
      { name: "count", label: "Provisioned concurrency", kind: "number", required: true, default: 1, validate: { min: 1, max: 1000, message: "Between 1 and 1000." } },
    ],
    async run(ctx, name, v) {
      const qualifier = opt(v.qualifier);
      if (!qualifier) throw new Error("Choose an alias or a published version. Publish a version first if there is none.");
      const r = await ctx.clients.lambda.send(new PutProvisionedConcurrencyConfigCommand({ FunctionName: name, Qualifier: qualifier, ProvisionedConcurrentExecutions: Number(v.count) }));
      return { message: `Provisioned concurrency ${r.Status ?? "requested"}: ${r.RequestedProvisionedConcurrentExecutions ?? v.count} on ${qualifier}.` };
    },
  },
  {
    id: "async",
    label: "Edit asynchronous invocation",
    fields: [
      { name: "maxAge", label: "Maximum age of event (seconds)", kind: "number", required: true, default: DEFAULT_MAX_AGE, validate: { min: 60, max: 21600, message: "Between 60 and 21600." } },
      { name: "retries", label: "Retry attempts", kind: "number", required: true, default: DEFAULT_RETRIES, validate: { min: 0, max: 2, message: "0, 1 or 2." } },
    ],
    async initialValues(ctx, name) {
      const c = await optional(() => ctx.clients.lambda.send(new GetFunctionEventInvokeConfigCommand({ FunctionName: name })));
      return { maxAge: c?.MaximumEventAgeInSeconds ?? DEFAULT_MAX_AGE, retries: c?.MaximumRetryAttempts ?? DEFAULT_RETRIES };
    },
    async run(ctx, name, v) {
      const c = await optional(() => ctx.clients.lambda.send(new GetFunctionEventInvokeConfigCommand({ FunctionName: name })));
      const maxAge = optNum(v.maxAge) ?? DEFAULT_MAX_AGE;
      const retries = optNum(v.retries) ?? DEFAULT_RETRIES;
      if (maxAge === (c?.MaximumEventAgeInSeconds ?? DEFAULT_MAX_AGE) && retries === (c?.MaximumRetryAttempts ?? DEFAULT_RETRIES)) return NO_CHANGES;
      // Put replaces the whole configuration: keep the destinations that are already set.
      await ctx.clients.lambda.send(new PutFunctionEventInvokeConfigCommand({ FunctionName: name, MaximumEventAgeInSeconds: maxAge, MaximumRetryAttempts: retries, DestinationConfig: c?.DestinationConfig }));
      return { message: "Asynchronous invocation settings saved." };
    },
  },
];

const permissionActions: ActionDef[] = [
  {
    id: "add-permission",
    label: "Add permission (resource-based policy)",
    fields: [
      { name: "principalType", label: "Policy statement for", kind: "radio", default: "service", options: [{ value: "service", label: "AWS service" }, { value: "account", label: "AWS account or role" }] },
      { name: "service", label: "Service principal", kind: "select", required: true, default: "s3.amazonaws.com", showIf: { field: "principalType", equals: "service" }, options: ["s3.amazonaws.com", "sns.amazonaws.com", "events.amazonaws.com", "apigateway.amazonaws.com", "elasticloadbalancing.amazonaws.com", "logs.amazonaws.com", "sqs.amazonaws.com", "scheduler.amazonaws.com"].map((s) => ({ value: s, label: s })) },
      { name: "principal", label: "Principal (account ID or ARN)", kind: "text", required: true, showIf: { field: "principalType", equals: "account" } },
      { name: "sid", label: "Statement ID", kind: "text", required: true, validate: { pattern: "[a-zA-Z0-9_-]{1,100}", message: "Letters, numbers, - and _." } },
      { name: "action", label: "Action", kind: "select", required: true, default: "lambda:InvokeFunction", options: ["lambda:InvokeFunction", "lambda:InvokeFunctionUrl", "lambda:GetFunction"].map((a) => ({ value: a, label: a })) },
      { name: "sourceArn", label: "Source ARN", kind: "text", help: "Limits the permission to one resource, e.g. arn:aws:s3:::my-bucket." },
      { name: "sourceAccount", label: "Source account", kind: "text", validate: { pattern: "\\d{12}", message: "A 12-digit account ID." } },
    ],
    async run(ctx, name, v) {
      const principal = v.principalType === "account" ? opt(v.principal) : opt(v.service);
      const action = opt(v.action);
      if (!principal) throw new Error("Choose a principal.");
      if (!action) throw new Error("Choose an action.");
      const r = await ctx.clients.lambda.send(new AddPermissionCommand({ FunctionName: name, StatementId: String(v.sid), Action: action, Principal: principal, SourceArn: opt(v.sourceArn), SourceAccount: opt(v.sourceAccount) }));
      return { message: `Added statement ${v.sid}.`, json: r.Statement ? JSON.parse(r.Statement) : null };
    },
  },
  {
    id: "manage-permissions",
    label: "Remove permissions",
    async run(ctx, name) {
      const p = await optional(() => ctx.clients.lambda.send(new GetPolicyCommand({ FunctionName: name })));
      const rows = policyStatements(p?.Policy);
      return {
        message: "Select statements and choose Delete to remove them from the resource-based policy.",
        table: {
          rowKey: "sid",
          columns: [{ key: "sid", label: "Statement ID", kind: "text" }, { key: "principal", label: "Principal", kind: "text" }, { key: "action", label: "Action", kind: "text" }, { key: "conditions", label: "Conditions", kind: "code" }],
          rows,
          emptyText: "This function has no resource-based policy.",
          selectionAction: { actionId: "remove-permissions", label: "Delete", danger: true, valuesField: "sids" },
        },
      };
    },
  },
  {
    id: "remove-permissions",
    label: "Delete statements",
    hidden: true,
    danger: true,
    fields: [{ name: "sids", label: "Statements", kind: "multiselect", required: true }],
    async run(ctx, name, v) {
      const sids = strs(v.sids);
      for (const sid of sids) await ctx.clients.lambda.send(new RemovePermissionCommand({ FunctionName: name, StatementId: sid }));
      return { message: `Deleted ${sids.length} statement(s).` };
    },
  },
];

const versionActions: ActionDef[] = [
  {
    id: "publish",
    label: "Publish new version",
    fields: [{ name: "description", label: "Version description", kind: "text" }],
    async run(ctx, name, v) {
      const r = await ctx.clients.lambda.send(new PublishVersionCommand({ FunctionName: name, Description: opt(v.description) }));
      return { message: `Successfully created version ${r.Version ?? "?"} of function ${name}.` };
    },
  },
  {
    id: "create-alias",
    label: "Create alias",
    fields: [
      { name: "name", label: "Name", kind: "text", required: true, validate: { pattern: "(?!^[0-9]+$)[a-zA-Z0-9-_]{1,128}", message: "Letters, numbers, - and _; not only digits." } },
      { name: "description", label: "Description", kind: "text" },
      { name: "version", label: "Version", kind: "select", required: true, default: "$LATEST", options: versionOptions, help: "$LATEST or a published version." },
    ],
    async run(ctx, name, v) {
      const r = await ctx.clients.lambda.send(new CreateAliasCommand({ FunctionName: name, Name: String(v.name), FunctionVersion: opt(v.version) ?? "$LATEST", Description: opt(v.description) }));
      return { message: `Created alias ${r.Name} → version ${r.FunctionVersion}.` };
    },
  },
  {
    id: "manage-aliases",
    label: "Delete aliases",
    async run(ctx, name) {
      const a = await allAliases(ctx, name);
      return {
        message: "Select aliases and choose Delete.",
        table: {
          rowKey: "name",
          columns: [{ key: "name", label: "Name", kind: "text" }, { key: "version", label: "Version", kind: "text" }],
          rows: a.map((x) => ({ name: x.Name ?? "", version: x.FunctionVersion ?? null })),
          emptyText: "This function has no aliases.",
          selectionAction: { actionId: "delete-aliases", label: "Delete", danger: true, valuesField: "names" },
        },
      };
    },
  },
  {
    id: "delete-aliases",
    label: "Delete aliases",
    hidden: true,
    danger: true,
    fields: [{ name: "names", label: "Aliases", kind: "multiselect", required: true }],
    async run(ctx, name, v) {
      const names = strs(v.names);
      for (const n of names) await ctx.clients.lambda.send(new DeleteAliasCommand({ FunctionName: name, Name: n }));
      return { message: `Deleted ${names.length} alias(es).` };
    },
  },
];

const urlAndTagActions: ActionDef[] = [
  {
    id: "function-url",
    label: "Create function URL",
    fields: [{ name: "authType", label: "Auth type", kind: "radio", default: "AWS_IAM", options: [{ value: "AWS_IAM", label: "AWS_IAM: only authenticated IAM users and roles" }, { value: "NONE", label: "NONE: public, no IAM authentication" }] }],
    availableFor: (row) => urlState(row) !== "yes",
    async run(ctx, name, v) {
      const r = await ctx.clients.lambda.send(new CreateFunctionUrlConfigCommand({ FunctionName: name, AuthType: v.authType === "NONE" ? "NONE" : "AWS_IAM" }));
      return { message: `Function URL created: ${r.FunctionUrl ?? "-"} (${r.AuthType}).` };
    },
  },
  {
    id: "delete-function-url",
    label: "Delete function URL",
    danger: true,
    confirm: "The function URL stops working immediately.",
    availableFor: (row) => urlState(row) !== "no",
    async run(ctx, name) {
      await ctx.clients.lambda.send(new DeleteFunctionUrlConfigCommand({ FunctionName: name }));
      return { message: "Function URL deleted." };
    },
  },
  {
    id: "tags",
    label: "Manage tags",
    fields: [{ name: "tags", label: "Tags", kind: "tags" }],
    async initialValues(ctx, name) {
      return { tags: pairsFrom((await ctx.clients.lambda.send(new GetFunctionCommand({ FunctionName: name }))).Tags) };
    },
    async run(ctx, name, v) {
      const f = await ctx.clients.lambda.send(new GetFunctionCommand({ FunctionName: name }));
      const arn = f.Configuration?.FunctionArn;
      if (!arn) throw new Error("GetFunction returned no ARN.");
      const diff = recordTagDiff(f.Tags, tagsToRecord(fieldTags(v.tags)));
      if (diff.remove.length) await ctx.clients.lambda.send(new UntagResourceCommand({ Resource: arn, TagKeys: diff.remove }));
      if (Object.keys(diff.set).length) await ctx.clients.lambda.send(new TagResourceCommand({ Resource: arn, Tags: diff.set }));
      return { message: tagDiffMessage(diff) };
    },
  },
];

export const functionActions: ActionDef[] = [
  configActions[0],
  configActions[1],
  configActions[2],
  configActions[3],
  ...permissionActions,
  ...configActions.slice(4),
  ...versionActions,
  ...urlAndTagActions,
];
