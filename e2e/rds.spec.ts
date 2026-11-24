import { expect, test, type Page } from "@playwright/test";
import { aws, uniqueName } from "./aws-cli";

interface Instances {
  DBInstances: { DBInstanceIdentifier: string; Engine: string; MasterUserSecret?: { SecretArn: string } }[];
}

async function instanceIds(): Promise<string[]> {
  return ((await aws<Instances>("rds", "describe-db-instances"))?.DBInstances ?? []).map((i) => i.DBInstanceIdentifier);
}

async function runAction(page: Page, label: string, fill?: () => Promise<void>): Promise<void> {
  await page.getByRole("button", { name: "Actions" }).click();
  await page.getByRole("menuitem", { name: label, exact: true }).click();
  if (fill) await fill();
  await page.getByTestId("action-submit").click();
}

test("RDS: create a PostgreSQL instance, take a snapshot, delete it without a final snapshot", async ({ page }) => {
  test.setTimeout(180_000);
  const id = uniqueName("fix-rds");
  const snapshot = `${id}-snap`;
  try {
    await page.goto("/rds/databases");
    await expect(page.getByRole("heading", { name: /^Databases/ })).toBeVisible();
    await page.getByRole("link", { name: "Create database" }).first().click();
    await expect(page.getByTestId("create-form")).toBeVisible();
    await expect(page.getByTestId("create-submit")).toBeEnabled();
    await page.getByRole("radio", { name: "PostgreSQL", exact: true }).check();
    // The engine version list offers only the chosen engine's versions.
    const versions = await page.getByTestId("field-version_postgres").locator("option").allTextContents();
    expect(versions.length).toBeGreaterThan(1);
    expect(versions.filter((v) => v !== "-").every((v) => v.startsWith("PostgreSQL "))).toBe(true);
    await expect(page.getByTestId("field-version_mysql")).toHaveCount(0);
    // A self-managed master password is a masked input.
    await page.getByRole("radio", { name: /^Self managed/ }).check();
    await expect(page.getByTestId("field-masterPassword")).toHaveAttribute("type", "password");
    await page.getByRole("radio", { name: /^Managed in AWS Secrets Manager/ }).check();
    await page.getByLabel("DB instance identifier").fill(id);
    await page.getByLabel("Master username").fill("postgres");
    await page.getByRole("button", { name: "Create database" }).click();

    await expect(page).toHaveURL(/\/rds\/databases\/db%3A/);
    await expect(page.getByTestId("flash")).toContainText(id);
    await expect(page.getByTestId("kv-engine")).toHaveText("PostgreSQL");

    const created = (await aws<Instances>("rds", "describe-db-instances", "--db-instance-identifier", id))?.DBInstances[0];
    expect(created?.Engine).toBe("postgres");
    expect(created?.MasterUserSecret?.SecretArn).toContain("secret:rds!");

    await page.goto("/rds/databases");
    await expect(page.getByTestId("resource-table").getByRole("row", { name: new RegExp(id) })).toBeVisible();
    await page.getByTestId("resource-table").getByRole("link", { name: id }).click();
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("kv-identifier")).toHaveText(id);

    // Modify opens with the current settings, and saving it unchanged changes nothing.
    await aws("rds", "modify-db-instance", "--db-instance-identifier", id, "--backup-retention-period", "3", "--no-auto-minor-version-upgrade", "--apply-immediately");
    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Modify", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByTestId("field-backupRetention")).toHaveValue("3");
    await expect(dialog.getByTestId("field-autoMinor")).not.toBeChecked();
    await expect(dialog.getByTestId("field-instanceClass")).toHaveValue("db.t3.micro");
    await expect(dialog.getByTestId("field-newPassword")).toHaveAttribute("type", "password");
    await page.getByTestId("action-submit").click();
    await expect(dialog.getByTestId("flash")).toContainText(`No changes to DB instance ${id}`);
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    const after = (await aws<{ DBInstances: { BackupRetentionPeriod?: number; AutoMinorVersionUpgrade?: boolean; DBInstanceClass?: string; PendingModifiedValues?: object }[] }>("rds", "describe-db-instances", "--db-instance-identifier", id))?.DBInstances[0];
    expect(after?.BackupRetentionPeriod).toBe(3);
    expect(after?.AutoMinorVersionUpgrade).toBe(false);
    expect(after?.DBInstanceClass).toBe("db.t3.micro");
    expect(Object.keys(after?.PendingModifiedValues ?? {})).toHaveLength(0);

    // Action: take a snapshot.
    await runAction(page, "Take snapshot", () => page.getByLabel("Snapshot name").fill(snapshot));
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText(snapshot);
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    const snaps = await aws<{ DBSnapshots: { DBSnapshotIdentifier: string }[] }>("rds", "describe-db-snapshots", "--db-instance-identifier", id);
    expect(snaps?.DBSnapshots.map((s) => s.DBSnapshotIdentifier)).toContain(snapshot);

    // Delete without a final snapshot.
    await runAction(page, "Delete", async () => {
      await page.getByText("Create final snapshot").click();
      await page.getByLabel("To confirm deletion, type delete me").fill("delete me");
    });
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText(`Deleting DB instance ${id}`);
    await expect.poll(async () => (await instanceIds()).includes(id), { timeout: 60_000 }).toBe(false);
  } finally {
    if ((await instanceIds()).includes(id)) await aws("rds", "delete-db-instance", "--db-instance-identifier", id, "--skip-final-snapshot").catch(() => null);
    await aws("rds", "delete-db-snapshot", "--db-snapshot-identifier", snapshot).catch(() => null);
  }
});

test("RDS: an Aurora cluster with a reader, failover, and a parameter group edit", async ({ page }) => {
  test.setTimeout(180_000);
  const id = uniqueName("fix-rds-aurora");
  const group = uniqueName("fix-rds-pg");
  const clusterIds = async () => ((await aws<{ DBClusters: { DBClusterIdentifier: string }[] }>("rds", "describe-db-clusters"))?.DBClusters ?? []).map((c) => c.DBClusterIdentifier);
  try {
    await page.goto("/rds/databases/create");
    await expect(page.getByTestId("create-form")).toBeVisible();
    await expect(page.getByTestId("create-submit")).toBeEnabled();
    await page.getByRole("radio", { name: "Aurora (PostgreSQL Compatible)" }).check();
    await expect(page.getByTestId("field-version_aurora_postgresql")).toBeVisible();
    await page.getByRole("radio", { name: /^Multi-AZ DB instance deployment/ }).check();
    await page.getByLabel("DB instance identifier").fill(id);
    await page.getByLabel("DB instance class").selectOption("db.r6g.large");
    await page.getByRole("button", { name: "Create database" }).click();
    await expect(page).toHaveURL(/\/rds\/databases\/cluster%3A/);
    await expect(page.getByTestId("kv-role")).toHaveText("Regional cluster");
    expect((await instanceIds()).filter((i) => i.startsWith(`${id}-instance-`)).sort()).toEqual([`${id}-instance-1`, `${id}-instance-2`]);

    // Failover is offered only once the cluster is available.
    await expect.poll(async () => (await aws<{ DBClusters: { Status?: string }[] }>("rds", "describe-db-clusters", "--db-cluster-identifier", id))?.DBClusters[0]?.Status, { timeout: 90_000 }).toBe("available");
    await page.reload();
    await page.waitForLoadState("networkidle");
    await runAction(page, "Failover");
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText(`Failing over ${id}`);
    await page.getByRole("button", { name: "Close", exact: true }).last().click();

    // A DB parameter group with one edited parameter.
    await page.goto("/rds/parameter-groups/create");
    await page.waitForLoadState("networkidle");
    await page.getByLabel("Parameter group family").selectOption("postgres16");
    await page.getByLabel("Parameter group name").fill(group);
    await page.getByLabel("Description").fill("e2e");
    await page.getByRole("button", { name: "Create parameter group" }).click();
    await expect(page).toHaveURL(/\/rds\/parameter-groups\/db%3A/);
    await page.waitForLoadState("networkidle");
    await runAction(page, "Edit parameter", async () => {
      await page.getByLabel("Parameter name").fill("max_connections");
      await page.getByLabel("Value", { exact: true }).fill("150");
      await page.getByRole("radio", { name: "Pending reboot" }).check();
    });
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("max_connections = 150");
    const params = await aws<{ Parameters: { ParameterName: string; ParameterValue: string }[] }>("rds", "describe-db-parameters", "--db-parameter-group-name", group, "--source", "user");
    expect(params?.Parameters.find((p) => p.ParameterName === "max_connections")?.ParameterValue).toBe("150");
  } finally {
    for (const n of [1, 2]) await aws("rds", "delete-db-instance", "--db-instance-identifier", `${id}-instance-${n}`, "--skip-final-snapshot").catch(() => null);
    await expect.poll(async () => (await instanceIds()).some((i) => i.startsWith(`${id}-instance-`)), { timeout: 60_000 }).toBe(false);
    await aws("rds", "delete-db-cluster", "--db-cluster-identifier", id, "--skip-final-snapshot").catch(() => null);
    await expect.poll(async () => (await clusterIds()).includes(id), { timeout: 60_000 }).toBe(false);
    await aws("rds", "delete-db-parameter-group", "--db-parameter-group-name", group).catch(() => null);
  }
});
