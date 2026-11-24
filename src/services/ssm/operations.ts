/** Systems Manager Patch Manager baselines, Maintenance Windows and OpsCenter OpsItems. */

import {
  CreateMaintenanceWindowCommand,
  CreateOpsItemCommand,
  CreatePatchBaselineCommand,
  DeleteMaintenanceWindowCommand,
  DeletePatchBaselineCommand,
  DeregisterTargetFromMaintenanceWindowCommand,
  DescribeMaintenanceWindowsCommand,
  DescribeMaintenanceWindowTargetsCommand,
  DescribeOpsItemsCommand,
  DescribePatchBaselinesCommand,
  GetDefaultPatchBaselineCommand,
  GetMaintenanceWindowCommand,
  GetOpsItemCommand,
  GetPatchBaselineCommand,
  RegisterDefaultPatchBaselineCommand,
  RegisterTargetWithMaintenanceWindowCommand,
  UpdateMaintenanceWindowCommand,
  UpdateOpsItemCommand,
  type OperatingSystem,
  type OpsItemStatus,
  type PatchComplianceLevel,
  type Target,
} from "@aws-sdk/client-ssm";
import type { Ctx, FieldValues, Option, ResourceDef, Row } from "../../console/types.ts";
import { shortBaselineId, tagTarget } from "./helpers.ts";

const OS: Option[] = [
  ["AMAZON_LINUX_2023", "Amazon Linux 2023"],
  ["AMAZON_LINUX_2", "Amazon Linux 2"],
  ["UBUNTU", "Ubuntu"],
  ["REDHAT_ENTERPRISE_LINUX", "Red Hat Enterprise Linux"],
  ["WINDOWS", "Windows"],
  ["DEBIAN", "Debian"],
  ["SUSE", "SUSE"],
  ["CENTOS", "CentOS"],
  ["ORACLE_LINUX", "Oracle Linux"],
  ["ROCKY_LINUX", "Rocky Linux"],
  ["ALMA_LINUX", "AlmaLinux"],
  ["MACOS", "macOS"],
].map(([value, label]) => ({ value, label }));

const COMPLIANCE: Option[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFORMATIONAL", "UNSPECIFIED"].map((v) => ({ value: v, label: v.charAt(0) + v.slice(1).toLowerCase() }));

export const patchBaselines: ResourceDef = {
  id: "patch-baselines",
  name: "Patch Manager",
  singular: "patch baseline",
  idField: "id",
  nameField: "name",
  description: "Patch baselines decide which patches are approved for installation on each operating system.",
  emptyText: "No patch baselines.",
  columns: [
    { key: "id", label: "Baseline ID", kind: "link" },
    { key: "name", label: "Name", kind: "text" },
    { key: "os", label: "Operating system", kind: "text" },
    { key: "default", label: "Default baseline", kind: "boolean" },
    { key: "owner", label: "Owner", kind: "text" },
    { key: "description", label: "Description", kind: "text" },
  ],
  async list(ctx) {
    const rows: Row[] = [];
    let token: string | undefined;
    do {
      const r = await ctx.clients.ssm.send(new DescribePatchBaselinesCommand({ NextToken: token, MaxResults: 100 }));
      for (const b of r.BaselineIdentities ?? []) {
        const full = b.BaselineId ?? "";
        rows.push({
          id: shortBaselineId(full),
          name: b.BaselineName ?? null,
          os: OS.find((o) => o.value === b.OperatingSystem)?.label ?? b.OperatingSystem ?? null,
          default: b.DefaultBaseline ?? false,
          owner: full.startsWith("arn:") || (b.BaselineName ?? "").startsWith("AWS-") ? "AWS" : "Self",
          description: b.BaselineDescription ?? null,
        });
      }
      token = r.NextToken;
    } while (token);
    return rows;
  },
  async get(ctx, id) {
    const b = await ctx.clients.ssm.send(new GetPatchBaselineCommand({ BaselineId: id }));
    // The default-baseline lookup is secondary: if it is denied, show "Unavailable" instead of failing.
    let isDefault: boolean | null = false;
    if (b.OperatingSystem) {
      try {
        isDefault = shortBaselineId((await ctx.clients.ssm.send(new GetDefaultPatchBaselineCommand({ OperatingSystem: b.OperatingSystem }))).BaselineId ?? "") === id;
      } catch {
        isDefault = null;
      }
    }
    return {
      summary: {
        "Baseline ID": b.BaselineId ?? id,
        Name: b.Name ?? null,
        "Operating system": b.OperatingSystem ?? null,
        "Default baseline": isDefault === null ? "Unavailable" : isDefault ? "Yes" : "No",
        Description: b.Description ?? null,
        "Approved patches compliance level": b.ApprovedPatchesComplianceLevel ?? null,
        "Rejected patches action": b.RejectedPatchesAction ?? null,
        Created: b.CreatedDate ?? null,
        Modified: b.ModifiedDate ?? null,
      },
      tabs: [
        {
          id: "rules",
          label: "Approval rules",
          kind: "table",
          data: (b.ApprovalRules?.PatchRules ?? []).map((r, i) => ({
            n: i + 1,
            filters: (r.PatchFilterGroup?.PatchFilters ?? []).map((f) => `${f.Key} = ${(f.Values ?? []).join(", ")}`).join("; "),
            delay: r.ApproveAfterDays !== undefined ? `${r.ApproveAfterDays} days` : r.ApproveUntilDate ?? null,
            compliance: r.ComplianceLevel ?? null,
            nonSecurity: r.EnableNonSecurity ? "Yes" : "No",
          })),
          columns: [
            { key: "n", label: "Rule", kind: "count" },
            { key: "filters", label: "Patch filters", kind: "text" },
            { key: "delay", label: "Auto-approval", kind: "text" },
            { key: "compliance", label: "Compliance reporting", kind: "text" },
            { key: "nonSecurity", label: "Non-security updates", kind: "text" },
          ],
          emptyText: "No approval rules.",
        },
        {
          id: "exceptions",
          label: "Patch exceptions",
          kind: "keyvalue",
          data: { "Approved patches": (b.ApprovedPatches ?? []).join(", ") || null, "Rejected patches": (b.RejectedPatches ?? []).join(", ") || null },
        },
      ],
    };
  },
  create: {
    title: "Create patch baseline",
    fields: [
      { name: "name", label: "Name", kind: "text", required: true, section: "Patch baseline details", validate: { pattern: "[A-Za-z0-9_.-]{3,128}", message: "3 to 128 letters, numbers, . _ and -." } },
      { name: "description", label: "Description", kind: "text", section: "Patch baseline details" },
      { name: "os", label: "Operating system", kind: "select", section: "Patch baseline details", default: "AMAZON_LINUX_2023", options: OS },
      {
        name: "classification",
        label: "Classification",
        kind: "multiselect",
        section: "Approval rules for operating systems",
        default: ["Security"],
        options: ["Security", "Bugfix", "Enhancement", "Recommended", "Newpackage", "CriticalUpdates", "SecurityUpdates"].map((v) => ({ value: v, label: v })),
        help: "Patches of these classifications are approved (Linux: Security, Bugfix …; Windows: CriticalUpdates, SecurityUpdates …).",
      },
      { name: "severity", label: "Severity", kind: "multiselect", section: "Approval rules for operating systems", options: ["Critical", "Important", "Medium", "Low"].map((v) => ({ value: v, label: v })), help: "Leave empty for all severities." },
      { name: "approveAfterDays", label: "Auto-approval delay (days)", kind: "number", section: "Approval rules for operating systems", default: 7, validate: { min: 0, max: 360, message: "0 to 360 days." } },
      { name: "compliance", label: "Compliance reporting", kind: "select", section: "Approval rules for operating systems", default: "UNSPECIFIED", options: COMPLIANCE },
      { name: "approved", label: "Approved patches", kind: "text", section: "Patch exceptions", help: "Comma-separated names or KB IDs, e.g. kernel, KB2032276." },
      { name: "rejected", label: "Rejected patches", kind: "text", section: "Patch exceptions" },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const list = (x: unknown) => (typeof x === "string" ? x.split(",").map((s) => s.trim()).filter(Boolean) : []);
      const classes = (v.classification as string[] | null) ?? [];
      const severity = (v.severity as string[] | null) ?? [];
      const filters = [
        ...(classes.length ? [{ Key: "CLASSIFICATION" as const, Values: classes }] : []),
        ...(severity.length ? [{ Key: "SEVERITY" as const, Values: severity }] : []),
      ];
      const approved = list(v.approved);
      if (filters.length === 0 && approved.length === 0) throw new Error("Add an approval rule (choose a classification) or list approved patches.");
      const r = await ctx.clients.ssm.send(
        new CreatePatchBaselineCommand({
          Name: String(v.name),
          Description: typeof v.description === "string" && v.description !== "" ? v.description : undefined,
          OperatingSystem: String(v.os) as OperatingSystem,
          ApprovalRules: filters.length
            ? { PatchRules: [{ PatchFilterGroup: { PatchFilters: filters }, ApproveAfterDays: typeof v.approveAfterDays === "number" ? v.approveAfterDays : 7, ComplianceLevel: String(v.compliance) as PatchComplianceLevel }] }
            : undefined,
          ApprovedPatches: approved.length ? approved : undefined,
          RejectedPatches: list(v.rejected).length ? list(v.rejected) : undefined,
          Tags: Array.isArray(v.tags) && v.tags.length ? (v.tags as { Key: string; Value: string }[]) : undefined,
        })
      );
      if (!r.BaselineId) throw new Error("Systems Manager returned no baseline ID.");
      return shortBaselineId(r.BaselineId);
    },
  },
  actions: [
    {
      id: "set-default",
      label: "Set default patch baseline",
      availableFor: (row) => row.default !== true && row["Default baseline"] !== "Yes",
      confirm: "Makes this baseline the default for its operating system. Nodes without a patch group use the default baseline.",
      async run(ctx, id) {
        const r = await ctx.clients.ssm.send(new RegisterDefaultPatchBaselineCommand({ BaselineId: id }));
        return { message: `${r.BaselineId ?? id} is now the default patch baseline for its operating system.` };
      },
    },
  ],
  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      await ctx.clients.ssm.send(new DeletePatchBaselineCommand({ BaselineId: id }));
    },
  },
};

async function windowTargetOptions(ctx: Ctx, id?: string): Promise<Option[]> {
  if (!id) return [];
  const out: Option[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.ssm.send(new DescribeMaintenanceWindowTargetsCommand({ WindowId: id, NextToken: token }));
    for (const t of r.Targets ?? []) if (t.WindowTargetId) out.push({ value: t.WindowTargetId, label: t.Name ? `${t.Name} (${t.WindowTargetId})` : t.WindowTargetId });
    token = r.NextToken;
  } while (token);
  return out;
}

function targetsOf(text: string, kind: string): Target[] {
  if (kind === "instances") {
    const ids = text.split(/[\s,]+/).filter(Boolean);
    if (ids.length === 0) throw new Error("Give at least one instance ID.");
    return [{ Key: "InstanceIds", Values: ids }];
  }
  return [tagTarget(text)];
}

export const maintenanceWindows: ResourceDef = {
  id: "maintenance-windows",
  name: "Maintenance Windows",
  singular: "maintenance window",
  idField: "id",
  nameField: "name",
  description: "Schedules for running disruptive tasks such as patching on your managed nodes.",
  emptyText: "No maintenance windows. Create a maintenance window to schedule tasks.",
  columns: [
    { key: "id", label: "Window ID", kind: "link" },
    { key: "name", label: "Name", kind: "text" },
    { key: "enabled", label: "State", kind: "status" },
    { key: "schedule", label: "Schedule", kind: "code" },
    { key: "duration", label: "Duration (hours)", kind: "count" },
    { key: "cutoff", label: "Stop initiating tasks (hours)", kind: "count" },
    { key: "next", label: "Next execution time", kind: "text" },
  ],
  async list(ctx) {
    const rows: Row[] = [];
    let token: string | undefined;
    do {
      const r = await ctx.clients.ssm.send(new DescribeMaintenanceWindowsCommand({ NextToken: token, MaxResults: 100 }));
      for (const w of r.WindowIdentities ?? [])
        rows.push({ id: w.WindowId ?? "", name: w.Name ?? null, enabled: w.Enabled ? "Enabled" : "Disabled", schedule: w.Schedule ?? null, duration: w.Duration ?? null, cutoff: w.Cutoff ?? null, next: w.NextExecutionTime ?? null, description: w.Description ?? null });
      token = r.NextToken;
    } while (token);
    return rows;
  },
  async get(ctx, id) {
    const [w, targets] = await Promise.all([
      ctx.clients.ssm.send(new GetMaintenanceWindowCommand({ WindowId: id })),
      ctx.clients.ssm.send(new DescribeMaintenanceWindowTargetsCommand({ WindowId: id })),
    ]);
    return {
      summary: {
        "Window ID": id,
        Name: w.Name ?? null,
        Description: w.Description ?? null,
        State: w.Enabled ? "Enabled" : "Disabled",
        Schedule: w.Schedule ?? null,
        "Schedule timezone": w.ScheduleTimezone ?? null,
        "Duration (hours)": w.Duration ?? null,
        "Stop initiating tasks (hours)": w.Cutoff ?? null,
        "Next execution time": w.NextExecutionTime ?? null,
        "Allow unregistered targets": w.AllowUnassociatedTargets ? "Yes" : "No",
        Created: w.CreatedDate ?? null,
      },
      tabs: [
        {
          id: "targets",
          label: "Targets",
          kind: "table",
          data: (targets.Targets ?? []).map((t) => ({ id: t.WindowTargetId ?? "", name: t.Name ?? null, type: t.ResourceType ?? null, targets: (t.Targets ?? []).map((x) => `${x.Key}=${(x.Values ?? []).join(",")}`).join("; "), owner: t.OwnerInformation ?? null })),
          columns: [
            { key: "id", label: "Window target ID", kind: "code" },
            { key: "name", label: "Name", kind: "text" },
            { key: "type", label: "Resource type", kind: "text" },
            { key: "targets", label: "Targets", kind: "text" },
            { key: "owner", label: "Owner information", kind: "text" },
          ],
          emptyText: "No targets registered. Use Actions > Register targets.",
        },
      ],
    };
  },
  create: {
    title: "Create maintenance window",
    fields: [
      { name: "name", label: "Name", kind: "text", required: true, section: "Provide maintenance window details", validate: { pattern: "[A-Za-z0-9_.-]{3,128}", message: "3 to 128 letters, numbers, . _ and -." } },
      { name: "description", label: "Description", kind: "text", section: "Provide maintenance window details" },
      { name: "allowUnregistered", label: "Allow unregistered targets", kind: "checkbox", section: "Provide maintenance window details", help: "Lets tasks run on nodes that aren't registered as targets." },
      { name: "schedule", label: "Schedule", kind: "text", required: true, section: "Schedule", default: "cron(0 2 ? * SUN *)", help: "A cron or rate expression, e.g. cron(0 2 ? * SUN *) or rate(1 day)." },
      { name: "timezone", label: "Schedule timezone", kind: "text", section: "Schedule", placeholder: "Etc/UTC", help: "IANA time zone, e.g. Australia/Brisbane. Empty means UTC." },
      { name: "duration", label: "Duration (hours)", kind: "number", required: true, section: "Schedule", default: 2, validate: { min: 1, max: 24, message: "1 to 24 hours." } },
      { name: "cutoff", label: "Stop initiating tasks (hours)", kind: "number", required: true, section: "Schedule", default: 1, help: "How long before the window closes to stop starting new tasks.", validate: { min: 0, max: 23, message: "0 to 23 hours." } },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const duration = Number(v.duration);
      const cutoff = Number(v.cutoff);
      if (cutoff >= duration) throw new Error("Stop initiating tasks must be less than the duration.");
      const r = await ctx.clients.ssm.send(
        new CreateMaintenanceWindowCommand({
          Name: String(v.name),
          Description: typeof v.description === "string" && v.description !== "" ? v.description : undefined,
          Schedule: String(v.schedule),
          ScheduleTimezone: typeof v.timezone === "string" && v.timezone !== "" ? v.timezone : undefined,
          Duration: duration,
          Cutoff: cutoff,
          AllowUnassociatedTargets: v.allowUnregistered === true,
          Tags: Array.isArray(v.tags) && v.tags.length ? (v.tags as { Key: string; Value: string }[]) : undefined,
        })
      );
      if (!r.WindowId) throw new Error("Systems Manager returned no window ID.");
      return r.WindowId;
    },
  },
  actions: [
    {
      id: "register-targets",
      label: "Register targets",
      fields: [
        { name: "name", label: "Target name", kind: "text" },
        {
          name: "kind",
          label: "Target selection",
          kind: "radio",
          default: "tags",
          options: [
            { value: "tags", label: "Specify instance tags" },
            { value: "instances", label: "Choose instances manually" },
          ],
        },
        { name: "value", label: "Tag (Key=Value) or instance IDs", kind: "text", required: true, placeholder: "Patch Group=prod  or  i-0123…, i-0456…" },
      ],
      async run(ctx, id, v) {
        const r = await ctx.clients.ssm.send(
          new RegisterTargetWithMaintenanceWindowCommand({ WindowId: id, ResourceType: "INSTANCE", Targets: targetsOf(String(v.value), String(v.kind)), Name: typeof v.name === "string" && v.name !== "" ? v.name : undefined })
        );
        return { message: `Registered target ${r.WindowTargetId ?? ""}.` };
      },
    },
    {
      id: "deregister-target",
      label: "Deregister target",
      danger: true,
      fields: [{ name: "targetId", label: "Window target", kind: "select", required: true, options: windowTargetOptions }],
      async run(ctx, id, v) {
        await ctx.clients.ssm.send(new DeregisterTargetFromMaintenanceWindowCommand({ WindowId: id, WindowTargetId: String(v.targetId) }));
        return { message: `Target ${String(v.targetId)} deregistered.` };
      },
    },
    {
      id: "enable",
      label: "Enable",
      availableFor: (row) => (row.enabled ?? row.State) !== "Enabled",
      async run(ctx, id) {
        await ctx.clients.ssm.send(new UpdateMaintenanceWindowCommand({ WindowId: id, Enabled: true }));
        return { message: `Maintenance window ${id} enabled.` };
      },
    },
    {
      id: "disable",
      label: "Disable",
      availableFor: (row) => (row.enabled ?? row.State) !== "Disabled",
      async run(ctx, id) {
        await ctx.clients.ssm.send(new UpdateMaintenanceWindowCommand({ WindowId: id, Enabled: false }));
        return { message: `Maintenance window ${id} disabled.` };
      },
    },
  ],
  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      await ctx.clients.ssm.send(new DeleteMaintenanceWindowCommand({ WindowId: id }));
    },
  },
};

const STATUSES: Option[] = ["Open", "InProgress", "Resolved"].map((v) => ({ value: v, label: v === "InProgress" ? "In progress" : v }));

export const opsItems: ResourceDef = {
  id: "ops-items",
  name: "OpsCenter",
  singular: "OpsItem",
  idField: "id",
  nameField: "title",
  description: "OpsItems: operational issues to investigate and resolve, with their related resources.",
  emptyText: "No OpsItems.",
  columns: [
    { key: "id", label: "OpsItem ID", kind: "link" },
    { key: "title", label: "Title", kind: "text" },
    { key: "status", label: "Status", kind: "status" },
    { key: "source", label: "Source", kind: "text" },
    { key: "priority", label: "Priority", kind: "count" },
    { key: "severity", label: "Severity", kind: "text" },
    { key: "category", label: "Category", kind: "text" },
    { key: "created", label: "Created", kind: "date" },
  ],
  async list(ctx) {
    const rows: Row[] = [];
    let token: string | undefined;
    do {
      const r = await ctx.clients.ssm.send(new DescribeOpsItemsCommand({ NextToken: token, MaxResults: 50 }));
      for (const o of r.OpsItemSummaries ?? [])
        rows.push({ id: o.OpsItemId ?? "", title: o.Title ?? null, status: o.Status ?? null, source: o.Source ?? null, priority: o.Priority ?? null, severity: o.Severity ?? null, category: o.Category ?? null, created: o.CreatedTime ?? null });
      token = r.NextToken;
    } while (token && rows.length < 1000);
    return rows;
  },
  async get(ctx, id) {
    const o = (await ctx.clients.ssm.send(new GetOpsItemCommand({ OpsItemId: id }))).OpsItem;
    if (!o) throw new Error(`OpsItemNotFoundException: ${id}`);
    return {
      summary: {
        "OpsItem ID": id,
        Title: o.Title ?? null,
        Status: o.Status ?? null,
        Description: o.Description ?? null,
        Source: o.Source ?? null,
        Priority: o.Priority ?? null,
        Severity: o.Severity ?? null,
        Category: o.Category ?? null,
        Type: o.OpsItemType ?? null,
        "Created by": o.CreatedBy ?? null,
        Created: o.CreatedTime ?? null,
        "Last modified": o.LastModifiedTime ?? null,
      },
      tabs: [
        {
          id: "data",
          label: "Operational data",
          kind: "table",
          data: Object.entries(o.OperationalData ?? {}).map(([key, d]) => ({ key, value: d.Value ?? "", type: d.Type ?? null })),
          columns: [
            { key: "key", label: "Key", kind: "text" },
            { key: "value", label: "Value", kind: "code" },
            { key: "type", label: "Type", kind: "text" },
          ],
          emptyText: "No operational data.",
        },
        { id: "related", label: "Related OpsItems", kind: "table", data: (o.RelatedOpsItems ?? []).map((r) => ({ id: r.OpsItemId ?? "" })), columns: [{ key: "id", label: "OpsItem ID", kind: "text" }], emptyText: "No related OpsItems." },
      ],
    };
  },
  create: {
    title: "Create OpsItem",
    fields: [
      { name: "title", label: "Title", kind: "text", required: true, validate: { max: 1024, message: "Up to 1,024 characters." } },
      { name: "description", label: "Description", kind: "textarea", required: true },
      { name: "source", label: "Source", kind: "text", required: true, default: "Console", help: "Where the issue came from, e.g. EC2 or a monitoring tool." },
      { name: "priority", label: "Priority", kind: "select", required: true, default: "3", options: ["1", "2", "3", "4", "5"].map((v) => ({ value: v, label: v })), help: "1 is the highest priority." },
      { name: "severity", label: "Severity", kind: "select", default: "", options: [["1", "1 - Critical"], ["2", "2 - High"], ["3", "3 - Medium"], ["4", "4 - Low"]].map(([value, label]) => ({ value, label })) },
      { name: "category", label: "Category", kind: "select", default: "", options: ["Availability", "Cost", "Performance", "Recovery", "Security"].map((v) => ({ value: v, label: v })) },
      { name: "resource", label: "Related resource ARN", kind: "text", help: "Added as operational data /aws/resources." },
    ],
    async run(ctx, v) {
      const resource = typeof v.resource === "string" && v.resource !== "" ? v.resource : null;
      const r = await ctx.clients.ssm.send(
        new CreateOpsItemCommand({
          Title: String(v.title),
          Description: String(v.description),
          Source: String(v.source),
          Priority: Number(v.priority),
          Severity: typeof v.severity === "string" && v.severity !== "" ? v.severity : undefined,
          Category: typeof v.category === "string" && v.category !== "" ? v.category : undefined,
          OperationalData: resource ? { "/aws/resources": { Value: JSON.stringify([{ arn: resource }]), Type: "SearchableString" } } : undefined,
        })
      );
      if (!r.OpsItemId) throw new Error("Systems Manager returned no OpsItem ID.");
      return r.OpsItemId;
    },
  },
  actions: [
    {
      id: "set-status",
      label: "Set status",
      fields: [{ name: "status", label: "Status", kind: "select", required: true, default: "InProgress", options: STATUSES }],
      async initialValues(ctx, id) {
        const status = (await ctx.clients.ssm.send(new GetOpsItemCommand({ OpsItemId: id }))).OpsItem?.Status;
        const values: FieldValues = status && STATUSES.some((o) => o.value === status) ? { status } : {};
        return values;
      },
      async run(ctx, id, v) {
        await ctx.clients.ssm.send(new UpdateOpsItemCommand({ OpsItemId: id, Status: String(v.status) as OpsItemStatus }));
        return { message: `OpsItem ${id} set to ${String(v.status)}.` };
      },
    },
  ],
};
