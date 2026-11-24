/** CloudWatch dashboards: list, create and edit the source JSON. The widgets are drawn by the hand-built page. */

import { DeleteDashboardsCommand, GetDashboardCommand, ListDashboardsCommand, PutDashboardCommand } from "@aws-sdk/client-cloudwatch";
import type { Ctx, ResourceDef } from "../../console/types.ts";
import { parseDashboard } from "./helpers.ts";

const DASHBOARD_NAME = "[A-Za-z0-9_-]{1,255}";
const STARTER = JSON.stringify({ widgets: [] }, null, 2);

async function put(ctx: Ctx, name: string, body: string): Promise<string[]> {
  parseDashboard(body);
  const r = await ctx.clients.cloudwatch.send(new PutDashboardCommand({ DashboardName: name, DashboardBody: body }));
  return (r.DashboardValidationMessages ?? []).map((m) => `${m.DataPath ?? ""} ${m.Message ?? ""}`.trim());
}

export const dashboards: ResourceDef = {
  id: "dashboards",
  name: "Dashboards",
  singular: "dashboard",
  idField: "name",
  nameField: "name",
  description: "Customizable home pages that show metric graphs and text for your resources in one view.",
  emptyText: "No dashboards. Create a dashboard to graph your metrics in one place.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "lastModified", label: "Last updated (UTC)", kind: "date" },
    { key: "size", label: "Size", kind: "bytes" },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],

  async list(ctx) {
    const rows = [];
    let token: string | undefined;
    do {
      const r = await ctx.clients.cloudwatch.send(new ListDashboardsCommand({ NextToken: token }));
      for (const d of r.DashboardEntries ?? []) rows.push({ name: d.DashboardName ?? "", lastModified: d.LastModified ?? null, size: d.Size ?? null, arn: d.DashboardArn ?? null });
      token = r.NextToken;
    } while (token);
    return rows;
  },

  async get(ctx, name) {
    const r = await ctx.clients.cloudwatch.send(new GetDashboardCommand({ DashboardName: name }));
    const body = r.DashboardBody ?? "{}";
    let widgets = 0;
    try {
      widgets = parseDashboard(body).length;
    } catch {
      widgets = 0;
    }
    let pretty = body;
    try {
      pretty = JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      pretty = body;
    }
    return {
      summary: { Name: r.DashboardName ?? name, Widgets: widgets, ARN: r.DashboardArn ?? null },
      tabs: [{ id: "source", label: "Source", kind: "text", data: pretty, description: "The dashboard body as stored by CloudWatch (PutDashboard)." }],
    };
  },

  create: {
    title: "Create dashboard",
    description: "Name the dashboard and give its widgets as dashboard body JSON. Metric widgets are drawn as graphs from GetMetricData.",
    fields: [
      { name: "name", label: "Dashboard name", kind: "text", required: true, validate: { pattern: DASHBOARD_NAME, message: "Letters, numbers, hyphens and underscores, up to 255." } },
      {
        name: "body",
        label: "Dashboard body (source)",
        kind: "json",
        required: true,
        default: STARTER,
        help: 'For example {"widgets":[{"type":"metric","x":0,"y":0,"width":12,"height":6,"properties":{"metrics":[["AWS/EC2","CPUUtilization","InstanceId","i-…"]],"stat":"Average","period":300,"region":"us-east-1","title":"CPU"}}]}',
      },
    ],
    async run(ctx, v) {
      const name = String(v.name);
      const problems = await put(ctx, name, String(v.body));
      if (problems.length) throw new Error(`Saved with validation messages: ${problems.join("; ")}`);
      return name;
    },
  },

  actions: [
    {
      id: "edit-source",
      label: "Edit source",
      fields: [{ name: "body", label: "Dashboard body (source)", kind: "json", required: true, help: "The dashboard's current JSON. Saving replaces the whole body with what is here." }],
      async initialValues(ctx, name) {
        const r = await ctx.clients.cloudwatch.send(new GetDashboardCommand({ DashboardName: name }));
        const body = r.DashboardBody ?? "";
        try {
          return { body: JSON.stringify(JSON.parse(body), null, 2) };
        } catch {
          return { body };
        }
      },
      async run(ctx, name, v) {
        const problems = await put(ctx, name, String(v.body));
        return { message: problems.length ? `Saved. Validation messages: ${problems.join("; ")}` : `Dashboard ${name} saved.` };
      },
    },
  ],

  delete: {
    confirmText: "delete",
    async run(ctx, name) {
      await ctx.clients.cloudwatch.send(new DeleteDashboardsCommand({ DashboardNames: [name] }));
    },
  },
};
