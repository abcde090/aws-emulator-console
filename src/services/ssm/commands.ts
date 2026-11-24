/** Systems Manager Fleet Manager (managed nodes), Run Command and Session Manager. */

import {
  CancelCommandCommand,
  DescribeInstanceInformationCommand,
  DescribeInstancePatchStatesCommand,
  DescribeSessionsCommand,
  GetCommandInvocationCommand,
  ListCommandInvocationsCommand,
  ListCommandsCommand,
  ListDocumentsCommand,
  SendCommandCommand,
  TerminateSessionCommand,
  type Command,
  type InstanceInformation,
} from "@aws-sdk/client-ssm";
import type { Ctx, Option, ResourceDef, Row } from "../../console/types.ts";
import { isRateValue, parseDocParameters, tagTarget } from "./helpers.ts";
import { logGroupOptions } from "../cloudwatch/logs.ts";

async function allNodes(ctx: Ctx): Promise<InstanceInformation[]> {
  const out: InstanceInformation[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.ssm.send(new DescribeInstanceInformationCommand({ NextToken: token, MaxResults: 50 }));
    out.push(...(r.InstanceInformationList ?? []));
    token = r.NextToken;
  } while (token);
  return out;
}

function nodeRow(n: InstanceInformation): Row {
  return {
    id: n.InstanceId ?? "",
    name: n.Name ?? n.ComputerName ?? null,
    ping: n.PingStatus ?? null,
    platform: n.PlatformName ? `${n.PlatformName} ${n.PlatformVersion ?? ""}`.trim() : n.PlatformType ?? null,
    agent: n.AgentVersion ?? null,
    ip: n.IPAddress ?? null,
    type: n.ResourceType ?? null,
    lastPing: n.LastPingDateTime ?? null,
    association: n.AssociationStatus ?? null,
  };
}

export const managedNodes: ResourceDef = {
  id: "managed-nodes",
  name: "Fleet Manager",
  singular: "managed node",
  idField: "id",
  nameField: "id",
  description: "Managed nodes: EC2 instances and servers whose SSM Agent reports to Systems Manager.",
  emptyText:
    "No managed nodes. An EC2 instance becomes a managed node when SSM Agent runs on it and it has an instance profile that allows Systems Manager (for example AmazonSSMManagedInstanceCore).",
  columns: [
    { key: "id", label: "Node ID", kind: "link" },
    { key: "name", label: "Node name", kind: "text" },
    { key: "ping", label: "Ping status", kind: "status" },
    { key: "platform", label: "Operating system", kind: "text" },
    { key: "agent", label: "SSM Agent version", kind: "text" },
    { key: "ip", label: "IP address", kind: "text" },
    { key: "lastPing", label: "Last ping", kind: "date" },
  ],
  list: async (ctx) => (await allNodes(ctx)).map(nodeRow),
  async get(ctx, id) {
    const node = (await allNodes(ctx)).find((n) => n.InstanceId === id);
    if (!node) throw new Error(`${id} is not a managed node.`);
    const [commands, patches] = await Promise.all([
      ctx.clients.ssm.send(new ListCommandsCommand({ InstanceId: id, MaxResults: 50 })),
      ctx.clients.ssm.send(new DescribeInstancePatchStatesCommand({ InstanceIds: [id] })),
    ]);
    const r = nodeRow(node);
    const patch = (patches.InstancePatchStates ?? [])[0];
    return {
      summary: { "Node ID": id, "Node name": r.name, "Ping status": r.ping, "Operating system": r.platform, "SSM Agent version": r.agent, "IP address": r.ip, "Resource type": r.type, "Last ping": r.lastPing, "Association status": r.association },
      tabs: [
        {
          id: "commands",
          label: "Command history",
          kind: "table",
          data: (commands.Commands ?? []).map(commandRow),
          columns: COMMAND_COLUMNS.filter((c) => c.key !== "targets"),
          emptyText: "No commands were run on this node.",
        },
        {
          id: "patch",
          label: "Patch",
          kind: "keyvalue",
          data: patch
            ? { Baseline: patch.BaselineId ?? null, "Patch group": patch.PatchGroup ?? null, Installed: patch.InstalledCount ?? 0, Missing: patch.MissingCount ?? 0, Failed: patch.FailedCount ?? 0, Operation: patch.Operation ?? null, "Operation end": patch.OperationEndTime ?? null }
            : {},
          emptyText: "No patch compliance data. Run AWS-RunPatchBaseline on this node to scan it.",
        },
      ],
    };
  },
};

function commandRow(c: Command): Row {
  return {
    id: c.CommandId ?? "",
    status: c.Status ?? null,
    document: c.DocumentName ?? null,
    requested: c.RequestedDateTime ?? null,
    targets: (c.InstanceIds ?? []).length ? (c.InstanceIds ?? []).join(", ") : (c.Targets ?? []).map((t) => `${t.Key}=${(t.Values ?? []).join(",")}`).join("; "),
    targetCount: c.TargetCount ?? null,
    completed: c.CompletedCount ?? null,
    errors: c.ErrorCount ?? null,
    comment: c.Comment ?? null,
  };
}

const COMMAND_COLUMNS = [
  { key: "id", label: "Command ID", kind: "link" as const },
  { key: "status", label: "Status", kind: "status" as const },
  { key: "requested", label: "Requested date time", kind: "date" as const },
  { key: "document", label: "Document name", kind: "text" as const },
  { key: "targets", label: "Targets", kind: "text" as const },
  { key: "targetCount", label: "Targets count", kind: "count" as const },
  { key: "completed", label: "Completed", kind: "count" as const },
  { key: "errors", label: "Errors", kind: "count" as const },
  { key: "comment", label: "Comment", kind: "text" as const },
];

async function commandDocumentOptions(ctx: Ctx): Promise<Option[]> {
  const out: Option[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.ssm.send(new ListDocumentsCommand({ Filters: [{ Key: "DocumentType", Values: ["Command"] }], NextToken: token, MaxResults: 50 }));
    for (const d of r.DocumentIdentifiers ?? []) if (d.Name) out.push({ value: d.Name, label: `${d.Name} (${d.Owner === "Amazon" ? "Amazon" : "Owned by me"})` });
    token = r.NextToken;
  } while (token);
  const shell = out.findIndex((o) => o.value === "AWS-RunShellScript");
  return shell > 0 ? [out[shell], ...out.filter((_, i) => i !== shell)] : out;
}

async function nodeOptions(ctx: Ctx): Promise<Option[]> {
  return (await allNodes(ctx)).filter((n) => n.InstanceId).map((n) => ({ value: n.InstanceId as string, label: `${n.InstanceId} ${n.ComputerName ?? ""} (${n.PingStatus ?? "?"})`.trim() }));
}

const manual = { field: "targetType", equals: "instances" };
const byTag = { field: "targetType", equals: "tags" };

export const runCommand: ResourceDef = {
  id: "run-command",
  name: "Run Command",
  singular: "command",
  idField: "id",
  nameField: "id",
  description: "Run a Command document on managed nodes without SSH. Command history from ListCommands.",
  emptyText: "No commands have been run. Run a command to execute a document on managed nodes.",
  columns: COMMAND_COLUMNS,
  async list(ctx) {
    const rows: Row[] = [];
    let token: string | undefined;
    do {
      const r = await ctx.clients.ssm.send(new ListCommandsCommand({ NextToken: token, MaxResults: 50 }));
      rows.push(...(r.Commands ?? []).map(commandRow));
      token = r.NextToken;
    } while (token && rows.length < 1000);
    return rows;
  },
  async get(ctx, id) {
    const [cmd, inv] = await Promise.all([
      ctx.clients.ssm.send(new ListCommandsCommand({ CommandId: id })),
      ctx.clients.ssm.send(new ListCommandInvocationsCommand({ CommandId: id, Details: true })),
    ]);
    const c = (cmd.Commands ?? [])[0];
    if (!c) throw new Error(`InvalidCommandId: command ${id} does not exist.`);
    const invocations = inv.CommandInvocations ?? [];
    const outputs = await Promise.all(
      invocations.map(async (i) => {
        try {
          const o = await ctx.clients.ssm.send(new GetCommandInvocationCommand({ CommandId: id, InstanceId: i.InstanceId }));
          return { instance: i.InstanceId ?? "", status: o.Status ?? null, code: o.ResponseCode ?? null, stdout: o.StandardOutputContent ?? "", stderr: o.StandardErrorContent ?? "" };
        } catch (err: unknown) {
          return { instance: i.InstanceId ?? "", status: i.Status ?? null, code: null, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
        }
      })
    );
    const row = commandRow(c);
    return {
      summary: {
        "Command ID": id,
        Status: row.status,
        "Document name": row.document,
        "Document version": c.DocumentVersion ?? null,
        "Requested date time": row.requested,
        Comment: row.comment,
        Targets: row.targets,
        "Max concurrency": c.MaxConcurrency ?? null,
        "Max errors": c.MaxErrors ?? null,
        "Timeout (seconds)": c.TimeoutSeconds ?? null,
        "CloudWatch output": c.CloudWatchOutputConfig?.CloudWatchOutputEnabled ? c.CloudWatchOutputConfig.CloudWatchLogGroupName ?? "Enabled" : "Disabled",
      },
      tabs: [
        {
          id: "targets",
          label: "Targets and outputs",
          kind: "table",
          data: invocations.map((i) => ({ instance: i.InstanceId ?? "", name: i.InstanceName ?? null, status: i.Status ?? null, details: i.StatusDetails ?? null, start: i.RequestedDateTime ?? null })),
          columns: [
            { key: "instance", label: "Instance ID", kind: "text" },
            { key: "name", label: "Instance name", kind: "text" },
            { key: "status", label: "Status", kind: "status" },
            { key: "details", label: "Detailed status", kind: "text" },
            { key: "start", label: "Start time", kind: "date" },
          ],
          emptyText: "The command found no targets.",
        },
        {
          id: "output",
          label: "Output",
          kind: "table",
          data: outputs,
          columns: [
            { key: "instance", label: "Instance ID", kind: "text" },
            { key: "status", label: "Status", kind: "status" },
            { key: "code", label: "Response code", kind: "text" },
            { key: "stdout", label: "Output", kind: "code" },
            { key: "stderr", label: "Error", kind: "code" },
          ],
          emptyText: "No output: the command had no targets.",
        },
        { id: "parameters", label: "Parameters", kind: "json", data: c.Parameters ?? {} },
      ],
    };
  },
  create: {
    title: "Run command",
    description: "Choose a Command document, the targets and the parameters, then run it.",
    fields: [
      { name: "document", label: "Command document", kind: "select", required: true, section: "Command document", options: commandDocumentOptions, help: "AWS-RunShellScript runs shell commands on Linux; AWS-RunPowerShellScript on Windows." },
      { name: "documentVersion", label: "Document version", kind: "text", section: "Command document", default: "$DEFAULT", help: "$DEFAULT, $LATEST or a version number." },
      { name: "parameters", label: "Command parameters", kind: "json", section: "Command parameters", default: '{\n  "commands": ["echo Hello from Run Command"]\n}', help: "JSON object of the document's parameters. AWS-RunShellScript takes commands (a list) and optional workingDirectory and executionTimeout." },
      {
        name: "targetType",
        label: "Target selection",
        kind: "radio",
        section: "Target selection",
        default: "instances",
        options: [
          { value: "instances", label: "Choose instances manually" },
          { value: "tags", label: "Specify instance tags" },
        ],
      },
      { name: "instances", label: "Instances", kind: "multiselect", section: "Target selection", showIf: manual, options: nodeOptions, help: "Only managed nodes are listed." },
      { name: "tag", label: "Instance tag", kind: "text", section: "Target selection", showIf: byTag, placeholder: "Env=prod", help: "Key=Value; separate several values with commas." },
      { name: "comment", label: "Comment", kind: "text", section: "Other parameters", validate: { max: 100, message: "Up to 100 characters." } },
      { name: "timeout", label: "Timeout (seconds)", kind: "number", section: "Other parameters", default: 600, help: "How long to wait for a node to start the command.", validate: { min: 30, max: 2592000, message: "Between 30 and 2,592,000." } },
      { name: "concurrency", label: "Concurrency", kind: "text", section: "Rate control", default: "50", help: "Targets at a time: a number or a percentage, e.g. 10 or 25%." },
      { name: "errors", label: "Error threshold", kind: "text", section: "Rate control", default: "0", help: "Stop after this many (or this % of) errors." },
      { name: "cwOutput", label: "Enable CloudWatch logs", kind: "checkbox", section: "Output options", help: "Send output to CloudWatch Logs." },
      { name: "cwGroup", label: "Log group name", kind: "select", default: "", section: "Output options", showIf: { field: "cwOutput", equals: true }, options: logGroupOptions },
    ],
    async run(ctx, v) {
      const concurrency = String(v.concurrency ?? "50");
      const errors = String(v.errors ?? "0");
      if (!isRateValue(concurrency) || !isRateValue(errors)) throw new Error("Concurrency and error threshold are a number or a percentage, e.g. 10 or 25%.");
      const instances = v.targetType === "instances" ? ((v.instances as string[] | null) ?? []) : [];
      if (v.targetType === "instances" && instances.length === 0) throw new Error("Choose at least one instance, or specify instance tags.");
      const r = await ctx.clients.ssm.send(
        new SendCommandCommand({
          DocumentName: String(v.document),
          DocumentVersion: typeof v.documentVersion === "string" && v.documentVersion !== "" ? v.documentVersion : undefined,
          Parameters: parseDocParameters(String(v.parameters ?? "")),
          InstanceIds: instances.length ? instances : undefined,
          Targets: v.targetType === "tags" ? [tagTarget(String(v.tag ?? ""))] : undefined,
          Comment: typeof v.comment === "string" && v.comment !== "" ? v.comment : undefined,
          TimeoutSeconds: typeof v.timeout === "number" ? v.timeout : undefined,
          MaxConcurrency: concurrency,
          MaxErrors: errors,
          CloudWatchOutputConfig: v.cwOutput === true ? { CloudWatchOutputEnabled: true, CloudWatchLogGroupName: typeof v.cwGroup === "string" && v.cwGroup !== "" ? v.cwGroup : undefined } : undefined,
        })
      );
      if (!r.Command?.CommandId) throw new Error("Systems Manager returned no command ID.");
      return r.Command.CommandId;
    },
  },
  actions: [
    {
      id: "cancel",
      label: "Cancel command",
      danger: true,
      availableFor: (row) => {
        const st = row.status ?? row.Status;
        return st === undefined || st === null || st === "Pending" || st === "InProgress" || st === "Delayed";
      },
      confirm: "Cancels the command on targets that haven't finished it yet.",
      async run(ctx, id) {
        await ctx.clients.ssm.send(new CancelCommandCommand({ CommandId: id }));
        return { message: `Cancel requested for command ${id}.` };
      },
    },
  ],
};

export const sessions: ResourceDef = {
  id: "sessions",
  name: "Session Manager",
  singular: "session",
  idField: "id",
  nameField: "id",
  description: "Shell sessions to managed nodes, active and history (DescribeSessions). Sessions start from the AWS CLI with the Session Manager plugin.",
  emptyText: "No sessions. Start one with: aws ssm start-session --target <managed node ID>.",
  columns: [
    { key: "id", label: "Session ID", kind: "link" },
    { key: "state", label: "State", kind: "text" },
    { key: "target", label: "Target", kind: "text" },
    { key: "status", label: "Status", kind: "status" },
    { key: "owner", label: "Owner", kind: "arn" },
    { key: "start", label: "Start date", kind: "date" },
    { key: "end", label: "End date", kind: "date" },
  ],
  async list(ctx) {
    const [active, history] = await Promise.all([
      ctx.clients.ssm.send(new DescribeSessionsCommand({ State: "Active" })),
      ctx.clients.ssm.send(new DescribeSessionsCommand({ State: "History" })),
    ]);
    const map = (state: string) => (s: { SessionId?: string; Target?: string; Status?: string; Owner?: string; StartDate?: Date; EndDate?: Date; Reason?: string }) => ({
      id: s.SessionId ?? "",
      state,
      target: s.Target ?? null,
      status: s.Status ?? null,
      owner: s.Owner ?? null,
      start: s.StartDate ?? null,
      end: s.EndDate ?? null,
      reason: s.Reason ?? null,
    });
    return [...(active.Sessions ?? []).map(map("Active")), ...(history.Sessions ?? []).map(map("History"))];
  },
  async get(ctx, id) {
    const row = (await sessions.list(ctx)).find((s) => s.id === id);
    if (!row) throw new Error(`Session ${id} was not found.`);
    return { summary: { "Session ID": id, State: row.state, Target: row.target, Status: row.status, Owner: row.owner, "Start date": row.start, "End date": row.end, Reason: row.reason } };
  },
  actions: [
    {
      id: "terminate",
      label: "Terminate",
      danger: true,
      confirm: "Ends the session and closes its connection to the node.",
      async run(ctx, id) {
        await ctx.clients.ssm.send(new TerminateSessionCommand({ SessionId: id }));
        return { message: `Session ${id} terminated.` };
      },
    },
  ],
};
