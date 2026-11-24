/**
 * IAM Access reports › Credential report: GenerateCredentialReport, then the CSV from
 * GetCredentialReport shown as a table (one row per user plus the root user).
 */

import { GenerateCredentialReportCommand, GetCredentialReportCommand } from "@aws-sdk/client-iam";
import type { Ctx, ResourceDef, Row } from "../../console/types.ts";

/** Parses the report CSV (header row, then one row per user). Fields never contain commas. */
export function parseCredentialReport(csv: string): Row[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return [];
  const header = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""]));
  });
}

const NO_REPORT = /ReportNotPresent|ReportExpired|ReportInProgress|CredentialReport/;

async function readReport(ctx: Ctx): Promise<{ rows: Row[]; generated: Date | null } | null> {
  try {
    const r = await ctx.clients.iam.send(new GetCredentialReportCommand({}));
    const csv = r.Content ? Buffer.from(r.Content).toString("utf8") : "";
    return { rows: parseCredentialReport(csv), generated: r.GeneratedTime ?? null };
  } catch (err: unknown) {
    // No report yet (or it is still being built): the page shows its empty state.
    if (err instanceof Error && NO_REPORT.test(err.name)) return null;
    throw err;
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const credentialReport: ResourceDef = {
  id: "credential-report",
  name: "Credential report",
  singular: "report row",
  idField: "user",
  nameField: "User",
  description:
    "The credential report lists every IAM user and the status of their passwords, access keys and MFA devices. IAM generates at most one report every four hours.",
  emptyText: "No credential report yet. Choose Generate credential report.",
  columns: [
    { key: "user", label: "User", kind: "link" },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
    { key: "user_creation_time", label: "Creation time", kind: "text" },
    { key: "password_enabled", label: "Password enabled", kind: "text" },
    { key: "password_last_used", label: "Password last used", kind: "text" },
    { key: "password_last_changed", label: "Password last changed", kind: "text" },
    { key: "mfa_active", label: "MFA active", kind: "text" },
    { key: "access_key_1_active", label: "Access key 1 active", kind: "text" },
    { key: "access_key_1_last_rotated", label: "Access key 1 last rotated", kind: "text" },
    { key: "access_key_1_last_used_date", label: "Access key 1 last used", kind: "text" },
    { key: "access_key_2_active", label: "Access key 2 active", kind: "text" },
    { key: "access_key_2_last_rotated", label: "Access key 2 last rotated", kind: "text" },
  ],

  async list(ctx) {
    return (await readReport(ctx))?.rows ?? [];
  },

  async get(ctx, user) {
    const report = await readReport(ctx);
    const row = report?.rows.find((r) => r.user === user);
    if (!row) throw new Error(`${user} isn't in the current credential report. Generate a new report.`);
    return { summary: { User: user, "Report generated": report?.generated ?? null }, tabs: [{ id: "credentials", label: "Credentials", kind: "keyvalue", data: row }] };
  },

  pageActions: [
    {
      id: "generate",
      label: "Generate credential report",
      async run(ctx) {
        let state = (await ctx.clients.iam.send(new GenerateCredentialReportCommand({}))).State;
        for (let i = 0; i < 10 && state !== "COMPLETE"; i++) {
          await delay(500);
          state = (await ctx.clients.iam.send(new GenerateCredentialReportCommand({}))).State;
        }
        if (state !== "COMPLETE") return { message: `The credential report is still being generated (state ${state ?? "unknown"}). Refresh in a moment.` };
        const report = await readReport(ctx);
        const when = report?.generated ? report.generated.toISOString() : "an unknown time";
        return { message: `Credential report generated at ${when}: ${report?.rows.length ?? 0} rows (including the root user).` };
      },
    },
  ],
};
