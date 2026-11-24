import { expect, test, type Page } from "@playwright/test";
import { aws, uniqueName } from "./aws-cli";

async function runAction(page: Page, label: string, fill?: () => Promise<void>): Promise<void> {
  await page.getByRole("button", { name: "Actions" }).click();
  await page.getByRole("menuitem", { name: label, exact: true }).click();
  if (fill) await fill();
  await page.getByTestId("action-submit").click();
}

const closeDialog = (page: Page) => page.getByRole("button", { name: "Close", exact: true }).last().click();

const BACKUP_POLICY = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup";
const made = { vault: "", table: "", restored: "", role: "", planId: "" };

async function createRole(name: string): Promise<void> {
  await aws("iam", "create-role", "--role-name", name, "--assume-role-policy-document", JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "backup.amazonaws.com" }, Action: "sts:AssumeRole" }] }));
  await aws("iam", "attach-role-policy", "--role-name", name, "--policy-arn", BACKUP_POLICY);
}

test.afterEach(async () => {
  test.setTimeout(120_000);
  if (made.planId) {
    const sels = await aws<{ BackupSelectionsList: { SelectionId: string }[] }>("backup", "list-backup-selections", "--backup-plan-id", made.planId).catch(() => null);
    for (const s of sels?.BackupSelectionsList ?? []) await aws("backup", "delete-backup-selection", "--backup-plan-id", made.planId, "--selection-id", s.SelectionId).catch(() => null);
    await aws("backup", "delete-backup-plan", "--backup-plan-id", made.planId).catch(() => null);
  }
  if (made.vault) {
    const rps = await aws<{ RecoveryPoints: { RecoveryPointArn: string }[] }>("backup", "list-recovery-points-by-backup-vault", "--backup-vault-name", made.vault).catch(() => null);
    for (const rp of rps?.RecoveryPoints ?? []) await aws("backup", "delete-recovery-point", "--backup-vault-name", made.vault, "--recovery-point-arn", rp.RecoveryPointArn).catch(() => null);
    await aws("backup", "delete-backup-vault", "--backup-vault-name", made.vault).catch(() => null);
  }
  for (const t of [made.table, made.restored]) if (t) await aws("dynamodb", "delete-table", "--table-name", t).catch(() => null);
  if (made.role) {
    await aws("iam", "detach-role-policy", "--role-name", made.role, "--policy-arn", BACKUP_POLICY).catch(() => null);
    await aws("iam", "delete-role", "--role-name", made.role).catch(() => null);
  }
  Object.assign(made, { vault: "", table: "", restored: "", role: "", planId: "" });
});

test("Backup: create a vault, run an on-demand backup, restore it, delete the recovery point and the vault", async ({ page }) => {
  const vault = uniqueName("e2e-backup-vault");
  const table = uniqueName("e2e-backup-tbl");
  const restored = uniqueName("e2e-backup-restored");
  const role = uniqueName("e2e-backup-role");
  Object.assign(made, { vault, table, restored, role });
  await aws("dynamodb", "create-table", "--table-name", table, "--attribute-definitions", "AttributeName=id,AttributeType=S", "--key-schema", "AttributeName=id,KeyType=HASH", "--billing-mode", "PAY_PER_REQUEST");
  await aws("dynamodb", "wait", "table-exists", "--table-name", table);
  await createRole(role);

  await page.goto("/backup/vaults");
  await expect(page.getByRole("heading", { name: /^Backup vaults/ })).toBeVisible();
  await page.getByRole("link", { name: "Create backup vault" }).first().click();
  await page.getByLabel("Backup vault name", { exact: true }).fill(vault);
  await page.getByRole("button", { name: "Create backup vault" }).click();
  await expect(page).toHaveURL(new RegExp(`/backup/vaults/${vault}`));
  await expect(page.getByTestId("flash")).toContainText(`Created backup vault ${vault}`);
  const described = await aws<{ BackupVaultName: string }>("backup", "describe-backup-vault", "--backup-vault-name", vault);
  expect(described?.BackupVaultName).toBe(vault);

  await runAction(page, "Edit access policy", async () => {
    await page
      .getByRole("dialog")
      .getByLabel("Access policy (JSON)")
      .fill(JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Deny", Principal: { AWS: "*" }, Action: "backup:DeleteBackupVault", Resource: "*" }] }));
  });
  await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("Access policy saved");
  await closeDialog(page);
  const policy = await aws<{ Policy: string }>("backup", "get-backup-vault-access-policy", "--backup-vault-name", vault);
  expect(policy?.Policy).toContain("backup:DeleteBackupVault");
  await runAction(page, "Delete access policy");
  await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("Access policy deleted");
  await closeDialog(page);

  // On-demand backup through the form.
  await page.goto("/backup/backup-jobs/create");
  await page.getByLabel("Resource", { exact: true }).selectOption({ label: `DynamoDB table: ${table}` });
  await page.getByLabel("Backup vault", { exact: true }).selectOption(vault);
  await page.getByLabel("Retention (days)", { exact: true }).fill("7");
  await page.getByLabel("IAM role", { exact: true }).selectOption({ label: `${role} (trusts backup.amazonaws.com)` });
  await page.getByRole("button", { name: "Create on-demand backup" }).click();
  await expect(page).toHaveURL(/\/backup\/backup-jobs\//);
  await expect(page.getByTestId("kv-Backup vault")).toHaveText(vault);
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId("kv-Status")).toContainText("COMPLETED", { timeout: 1000 });
  }).toPass({ timeout: 20_000 });

  // The recovery point: restore it, then delete it.
  await page.goto("/backup/recovery-points");
  const rpRow = page.getByTestId("resource-table").getByRole("row", { name: new RegExp(table) });
  await expect(rpRow).toBeVisible();
  await rpRow.getByRole("link").first().click();
  await expect(page.getByTestId("kv-Backup vault")).toHaveText(vault);
  await runAction(page, "Restore", async () => {
    await page.getByRole("dialog").getByLabel("IAM role", { exact: true }).selectOption({ label: `${role} (trusts backup.amazonaws.com)` });
    await page.getByRole("dialog").getByLabel("New table name (DynamoDB) - optional").fill(restored);
  });
  await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("Restore job");
  await closeDialog(page);
  await expect(async () => {
    const jobs = await aws<{ RestoreJobs: { CreatedResourceArn?: string; Status: string }[] }>("backup", "list-restore-jobs");
    expect(jobs?.RestoreJobs.find((j) => j.CreatedResourceArn?.endsWith(`/${restored}`))?.Status).toBe("COMPLETED");
  }).toPass({ timeout: 30_000 });

  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByLabel("Confirm deletion").fill("delete");
  await page.getByTestId("confirm-delete").click();
  await expect(page).toHaveURL(/\/backup\/recovery-points\?deleted=/);

  // The dashboard counts real jobs.
  await page.goto("/backup");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect(page.getByTestId("dashboard-Backup jobs")).toContainText("COMPLETED");

  await page.goto("/backup/vaults");
  const row = page.getByTestId("resource-table").getByRole("row", { name: new RegExp(vault) });
  await row.getByRole("radio").check();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByLabel("Confirm deletion").fill(vault);
  await page.getByTestId("confirm-delete").click();
  await expect(page.getByTestId("flash")).toContainText(`Deleted backup vault ${vault}`);
  const vaults = await aws<{ BackupVaultList: { BackupVaultName: string }[] }>("backup", "list-backup-vaults");
  expect(vaults?.BackupVaultList.some((v) => v.BackupVaultName === vault)).toBe(false);
  made.vault = "";
});

test("Backup: create a backup plan with a copy rule, assign a resource, delete it", async ({ page }) => {
  const vault = uniqueName("e2e-backup-planvault");
  const plan = uniqueName("e2e-backup-plan");
  const table = uniqueName("e2e-backup-plantbl");
  const role = uniqueName("e2e-backup-planrole");
  Object.assign(made, { vault, table, role });
  await aws("backup", "create-backup-vault", "--backup-vault-name", vault);
  await aws("dynamodb", "create-table", "--table-name", table, "--attribute-definitions", "AttributeName=id,AttributeType=S", "--key-schema", "AttributeName=id,KeyType=HASH", "--billing-mode", "PAY_PER_REQUEST");
  await createRole(role);

  await page.goto("/backup/plans/create");
  await page.getByLabel("Backup plan name", { exact: true }).fill(plan);
  await page.getByLabel("Backup vault", { exact: true }).selectOption(vault);
  await page.getByLabel("Backup frequency", { exact: true }).selectOption("weekly");
  await page.getByText("Copy to destination", { exact: true }).last().click();
  await page.getByLabel("Destination backup vault name", { exact: true }).fill(vault);
  await page.getByLabel("Destination Region", { exact: true }).selectOption("us-east-1");
  await page.getByRole("button", { name: "Create backup plan" }).click();

  await expect(page).toHaveURL(/\/backup\/plans\/[0-9a-f]{8}-/);
  made.planId = decodeURIComponent(new URL(page.url()).pathname.split("/").pop() ?? "");
  await expect(page.getByTestId("kv-Backup plan name")).toHaveText(plan);
  await expect(page.getByText("cron(0 5 ? * SAT *)")).toBeVisible();
  const got = await aws<{ BackupPlan: { Rules: { ScheduleExpression: string; CopyActions?: { DestinationBackupVaultArn: string }[] }[] } }>("backup", "get-backup-plan", "--backup-plan-id", made.planId);
  expect(got?.BackupPlan.Rules[0].ScheduleExpression).toBe("cron(0 5 ? * SAT *)");
  expect(got?.BackupPlan.Rules[0].CopyActions?.[0].DestinationBackupVaultArn).toContain(`backup-vault:${vault}`);

  await runAction(page, "Assign resources", async () => {
    const d = page.getByRole("dialog");
    await d.getByLabel("Resource assignment name", { exact: true }).fill("e2e-assignment");
    await d.getByLabel("IAM role", { exact: true }).selectOption({ label: `${role} (trusts backup.amazonaws.com)` });
    await d.getByLabel("Specific resources - optional").selectOption({ label: `DynamoDB table: ${table}` });
  });
  const assigned = page.getByTestId("result-table");
  await expect(assigned).toContainText("e2e-assignment");
  await assigned.getByRole("checkbox").first().check();
  await page.getByRole("button", { name: /^Delete \(1\)/ }).click();
  await expect(page.getByRole("dialog")).toContainText("Deleted 1 resource assignment");
  await closeDialog(page);

  await page.goto("/backup/plans");
  const row = page.getByTestId("resource-table").getByRole("row", { name: new RegExp(plan) });
  await expect(row).toBeVisible();
  await row.getByRole("radio").check();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByLabel("Confirm deletion").fill("delete");
  await page.getByTestId("confirm-delete").click();
  await expect(page.getByTestId("resource-table").getByRole("row", { name: new RegExp(plan) })).toHaveCount(0);
  const plans = await aws<{ BackupPlansList: { BackupPlanId: string }[] }>("backup", "list-backup-plans");
  expect(plans?.BackupPlansList.some((p) => p.BackupPlanId === made.planId)).toBe(false);
  made.planId = "";
});

async function openAction(page: Page, label: string): Promise<void> {
  await page.getByRole("button", { name: "Actions" }).click();
  await page.getByRole("menuitem", { name: label, exact: true }).click();
}

test("Backup: vault Edit dialogs open with the policy, lock and tags; saving unchanged changes nothing", async ({ page }) => {
  const vault = uniqueName("fix-backup-vault");
  made.vault = vault;
  const policyDoc = { Version: "2012-10-17", Statement: [{ Effect: "Deny", Principal: { AWS: "*" }, Action: "backup:DeleteRecoveryPoint", Resource: "*" }] };
  await aws("backup", "create-backup-vault", "--backup-vault-name", vault, "--backup-vault-tags", "env=prod");
  await aws("backup", "put-backup-vault-access-policy", "--backup-vault-name", vault, "--policy", JSON.stringify(policyDoc));
  await aws("backup", "put-backup-vault-lock-configuration", "--backup-vault-name", vault, "--min-retention-days", "2", "--max-retention-days", "9");
  const arn = (await aws<{ BackupVaultArn: string }>("backup", "describe-backup-vault", "--backup-vault-name", vault))?.BackupVaultArn ?? "";
  const state = async () => ({
    vault: await aws("backup", "describe-backup-vault", "--backup-vault-name", vault),
    policy: await aws("backup", "get-backup-vault-access-policy", "--backup-vault-name", vault),
    tags: await aws("backup", "list-tags", "--resource-arn", arn),
  });
  const before = await state();

  try {
    await page.goto(`/backup/vaults/${vault}`);
    const dialog = page.getByRole("dialog");

    await openAction(page, "Edit access policy");
    await expect(dialog.getByTestId("field-policy")).toHaveValue(/backup:DeleteRecoveryPoint/);
    await dialog.getByTestId("action-submit").click();
    await expect(dialog.getByTestId("flash")).toContainText("Access policy saved");
    await closeDialog(page);

    await openAction(page, "Create or edit vault lock");
    await expect(dialog.getByTestId("field-minDays")).toHaveValue("2");
    await expect(dialog.getByTestId("field-maxDays")).toHaveValue("9");
    await closeDialog(page);

    await openAction(page, "Manage tags");
    await expect(dialog.getByLabel("Tags key 1")).toHaveValue("env");
    await expect(dialog.getByLabel("Tags value 1")).toHaveValue("prod");
    await dialog.getByTestId("action-submit").click();
    await expect(dialog.getByTestId("flash")).toContainText("No tag changes");
    await closeDialog(page);

    const after = await state();
    expect(after.vault).toEqual(before.vault);
    expect(JSON.parse((after.policy as { Policy: string }).Policy)).toEqual(JSON.parse((before.policy as { Policy: string }).Policy));
    expect(after.tags).toEqual(before.tags);
  } finally {
    await aws("backup", "delete-backup-vault-lock-configuration", "--backup-vault-name", vault).catch(() => null);
    await aws("backup", "delete-backup-vault-access-policy", "--backup-vault-name", vault).catch(() => null);
  }
});
