/** Pure AWS Backup helpers: schedules, plan input, ARNs and job-state counts. */

import type { Option } from "../../console/types.ts";

export const FREQUENCIES: Option[] = [
  { value: "hourly", label: "Hourly" },
  { value: "12h", label: "Every 12 hours" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "custom", label: "Custom cron expression" },
];

/** Backup rule schedule for a frequency choice, starting at 05:00 UTC like the console's default window. */
export function scheduleExpression(frequency: string, custom?: string): string {
  switch (frequency) {
    case "hourly":
      return "cron(0 * ? * * *)";
    case "12h":
      return "cron(0 5/12 ? * * *)";
    case "daily":
      return "cron(0 5 ? * * *)";
    case "weekly":
      return "cron(0 5 ? * SAT *)";
    case "monthly":
      return "cron(0 5 1 * ? *)";
    case "custom": {
      const c = (custom ?? "").trim();
      if (!/^cron\(.+\)$/.test(c)) throw new Error("Enter a cron expression such as cron(0 5 ? * * *).");
      return c;
    }
    default:
      throw new Error(`Unknown backup frequency "${frequency}".`);
  }
}

export function backupVaultArn(region: string, accountId: string, vaultName: string): string {
  return `arn:aws:backup:${region}:${accountId}:backup-vault:${vaultName}`;
}

export interface PlanFormValues {
  planName: string;
  ruleName: string;
  vaultName: string;
  schedule: string;
  startWindowMinutes?: number;
  completionWindowMinutes?: number;
  coldAfterDays?: number;
  deleteAfterDays?: number;
  copyToVaultArn?: string;
  copyDeleteAfterDays?: number;
}

export interface PlanInput {
  BackupPlanName: string;
  Rules: {
    RuleName: string;
    TargetBackupVaultName: string;
    ScheduleExpression: string;
    StartWindowMinutes?: number;
    CompletionWindowMinutes?: number;
    Lifecycle?: { MoveToColdStorageAfterDays?: number; DeleteAfterDays?: number };
    CopyActions?: { DestinationBackupVaultArn: string; Lifecycle?: { DeleteAfterDays?: number } }[];
  }[];
}

/** Builds CreateBackupPlan's BackupPlan from the form. Checks the rules AWS enforces on lifecycle. */
export function buildPlanInput(v: PlanFormValues): PlanInput {
  if (v.coldAfterDays !== undefined && v.deleteAfterDays !== undefined && v.deleteAfterDays < v.coldAfterDays + 90) {
    throw new Error("Retention must be at least 90 days after the move to cold storage.");
  }
  const lifecycle = v.coldAfterDays !== undefined || v.deleteAfterDays !== undefined ? { MoveToColdStorageAfterDays: v.coldAfterDays, DeleteAfterDays: v.deleteAfterDays } : undefined;
  return {
    BackupPlanName: v.planName,
    Rules: [
      {
        RuleName: v.ruleName,
        TargetBackupVaultName: v.vaultName,
        ScheduleExpression: v.schedule,
        StartWindowMinutes: v.startWindowMinutes,
        CompletionWindowMinutes: v.completionWindowMinutes,
        Lifecycle: lifecycle,
        CopyActions: v.copyToVaultArn ? [{ DestinationBackupVaultArn: v.copyToVaultArn, Lifecycle: v.copyDeleteAfterDays !== undefined ? { DeleteAfterDays: v.copyDeleteAfterDays } : undefined }] : undefined,
      },
    ],
  };
}

/** "arn:aws:dynamodb:us-east-1:1:table/orders" -> "orders"; S3 "arn:aws:s3:::bucket" -> "bucket". */
export function resourceNameFromArn(arn: string | undefined): string | null {
  if (!arn) return null;
  const tail = arn.slice(arn.lastIndexOf(":") + 1);
  return tail.includes("/") ? tail.slice(tail.lastIndexOf("/") + 1) : tail;
}

/** Counts rows by a state field, in a stable order. */
export function countByState(rows: Record<string, unknown>[], key: string): { state: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const s = typeof r[key] === "string" && r[key] !== "" ? (r[key] as string) : "UNKNOWN";
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([state, count]) => ({ state, count }));
}
