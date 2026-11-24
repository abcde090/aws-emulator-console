import { expect, test } from "@playwright/test";
import { aws, uniqueName } from "./aws-cli";

interface Clusters {
  Clusters?: { ClusterIdentifier: string; NumberOfNodes?: number; ClusterStatus?: string; AutomatedSnapshotRetentionPeriod?: number; PreferredMaintenanceWindow?: string }[];
}

async function cluster(id: string): Promise<NonNullable<Clusters["Clusters"]>[number] | undefined> {
  const r = await aws<Clusters>("redshift", "describe-clusters");
  return r?.Clusters?.find((c) => c.ClusterIdentifier === id);
}

test("Redshift: create a cluster, modify it, delete it", async ({ page }) => {
  const id = uniqueName("fix-redshift");
  try {
    await page.goto("/redshift/clusters");
    await expect(page.getByRole("heading", { name: /^Clusters/ })).toBeVisible();
    await page.getByRole("link", { name: "Create cluster" }).first().click();
    await expect(page.getByTestId("create-form")).toBeVisible();
    await expect(page.getByTestId("create-submit")).toBeEnabled();
    await page.getByLabel("Cluster identifier").fill(id);
    await page.getByLabel("Number of nodes").fill("2");
    await page.getByRole("button", { name: "Create cluster" }).click();

    await expect(page).toHaveURL(new RegExp(`/redshift/clusters/${id}`));
    await expect(page.getByTestId("kv-Cluster identifier")).toHaveText(id);
    await expect(page.getByTestId("kv-Number of nodes")).toHaveText("2");

    const created = await cluster(id);
    expect(created?.NumberOfNodes).toBe(2);

    // Modify opens with the current settings, and saving it unchanged changes nothing.
    await expect.poll(async () => (await cluster(id))?.ClusterStatus, { timeout: 30_000 }).toBe("available");
    await aws("redshift", "modify-cluster", "--cluster-identifier", id, "--automated-snapshot-retention-period", "3", "--preferred-maintenance-window", "tue:03:00-tue:03:30");
    await expect.poll(async () => (await cluster(id))?.ClusterStatus, { timeout: 30_000 }).toBe("available");
    await page.reload();
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Modify" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByTestId("field-snapshotRetention")).toHaveValue("3");
    await expect(dialog.getByTestId("field-maintenanceWindow")).toHaveValue("tue:03:00-tue:03:30");
    await expect(dialog.getByTestId("field-password")).toHaveAttribute("type", "password");
    await page.getByTestId("action-submit").click();
    await expect(dialog.getByTestId("flash")).toContainText(`No changes to ${id}`);
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    const unchanged = await cluster(id);
    expect(unchanged?.AutomatedSnapshotRetentionPeriod).toBe(3);
    expect(unchanged?.PreferredMaintenanceWindow).toBe("tue:03:00-tue:03:30");

    // Modify the automated snapshot retention period.
    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Modify" }).click();
    await page.getByRole("dialog").getByLabel(/^Automated snapshot retention period/).fill("5");
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText(`Modified ${id}`);
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    expect((await cluster(id))?.AutomatedSnapshotRetentionPeriod).toBe(5);

    await page.goto("/redshift/clusters");
    const row = page.getByTestId("resource-table").getByRole("row", { name: new RegExp(id) });
    await expect(row).toBeVisible();
    await row.getByRole("radio").check();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill(id);
    await page.getByTestId("confirm-delete").click();
    await expect(page).toHaveURL(/\/redshift\/clusters/);
    await expect.poll(async () => (await cluster(id)) === undefined, { timeout: 30_000 }).toBe(true);
  } finally {
    if (await cluster(id).catch(() => undefined)) {
      await aws("redshift", "delete-cluster", "--cluster-identifier", id, "--skip-final-cluster-snapshot").catch(() => null);
    }
  }
});
