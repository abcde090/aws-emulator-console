import { expect, test } from "@playwright/test";
import { aws, uniqueName } from "./aws-cli";

interface ReplicationGroups {
  ReplicationGroups?: { ReplicationGroupId: string; Status?: string; Description?: string; MemberClusters?: string[] }[];
}

async function groupsNamed(name: string): Promise<ReplicationGroups["ReplicationGroups"]> {
  const r = await aws<ReplicationGroups>("elasticache", "describe-replication-groups");
  return (r?.ReplicationGroups ?? []).filter((g) => g.ReplicationGroupId === name);
}

test("ElastiCache: create a node-based Valkey cache, modify it, delete it", async ({ page }) => {
  const name = uniqueName("fix-elasticache").slice(0, 40);
  try {
    await page.goto("/elasticache/valkey-caches");
    await expect(page.getByRole("heading", { name: /^Valkey caches/ })).toBeVisible();

    await page.getByRole("link", { name: "Create Valkey cache" }).first().click();
    await expect(page.getByTestId("create-form")).toBeVisible();
    await page.getByRole("radio", { name: /Design your own cache/ }).check();
    await page.getByLabel("Name", { exact: true }).fill(name);
    await page.getByLabel(/^Description/).fill("created by e2e");
    await page.getByLabel("Replicas per shard").fill("1");
    await page.getByRole("button", { name: "Create Valkey cache" }).click();

    await expect(page).toHaveURL(new RegExp(`/elasticache/valkey-caches/${name}`));
    await expect(page.getByTestId("kv-Cache name")).toHaveText(name);
    await expect(page.getByTestId("kv-Deployment option")).toHaveText("Node-based cluster");
    await expect(page.getByTestId("kv-Engine")).toHaveText("Valkey");

    const created = await groupsNamed(name);
    expect(created).toHaveLength(1);
    expect(created?.[0].MemberClusters).toHaveLength(2);

    // Modify opens with the current settings, and saving it unchanged changes nothing.
    await aws("elasticache", "modify-replication-group", "--replication-group-id", name, "--snapshot-retention-limit", "3", "--apply-immediately");
    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Modify" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByTestId("field-description")).toHaveValue("created by e2e");
    await expect(dialog.getByTestId("field-backupRetention")).toHaveValue("3");
    await expect(dialog.getByTestId("field-nodeType")).toHaveValue("cache.t3.micro");
    await page.getByTestId("action-submit").click();
    await expect(dialog.getByTestId("flash")).toContainText(`No changes to ${name}`);
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    const unchanged = await aws<{ ReplicationGroups: { Description?: string; SnapshotRetentionLimit?: number; CacheNodeType?: string }[] }>("elasticache", "describe-replication-groups", "--replication-group-id", name);
    expect(unchanged?.ReplicationGroups[0].Description).toBe("created by e2e");
    expect(unchanged?.ReplicationGroups[0].SnapshotRetentionLimit).toBe(3);
    expect(unchanged?.ReplicationGroups[0].CacheNodeType).toBe("cache.t3.micro");

    // Modify the description.
    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Modify" }).click();
    await page.getByRole("dialog").getByLabel(/^Description/).fill("changed by e2e");
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText(`Modified ${name}`);
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    expect((await groupsNamed(name))?.[0].Description).toBe("changed by e2e");

    // It is in the list; delete it from there.
    await page.goto("/elasticache/valkey-caches");
    const row = page.getByTestId("resource-table").getByRole("row", { name: new RegExp(name) });
    await expect(row).toBeVisible();
    await expect(row).toContainText("Node-based cluster");
    await row.getByRole("radio").check();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill("delete");
    await page.getByTestId("confirm-delete").click();
    await expect(page).toHaveURL(/\/elasticache\/valkey-caches/);
    await expect.poll(async () => (await groupsNamed(name))?.length ?? 0, { timeout: 30_000 }).toBe(0);
  } finally {
    if ((await groupsNamed(name).catch(() => []))?.length) {
      await aws("elasticache", "delete-replication-group", "--replication-group-id", name).catch(() => null);
    }
  }
});

test("ElastiCache: create and delete a subnet group", async ({ page }) => {
  const name = uniqueName("e2e-elasticache-sg");
  try {
    await page.goto("/elasticache/subnet-groups/create");
    // Wait for hydration so the form submits through React, not as a native GET.
    await page.waitForLoadState("networkidle");
    await page.getByLabel("Name", { exact: true }).fill(name);
    await page.getByLabel("Description", { exact: true }).fill("e2e");
    const subnets = page.getByLabel("Subnets", { exact: true });
    const first = await subnets.locator("option").first().getAttribute("value");
    await subnets.selectOption(first ?? "");
    await page.getByRole("button", { name: "Create subnet group" }).click();
    await expect(page.getByTestId("kv-Name")).toHaveText(name);
    const r = await aws<{ CacheSubnetGroups?: { CacheSubnetGroupName: string }[] }>("elasticache", "describe-cache-subnet-groups", "--cache-subnet-group-name", name);
    expect(r?.CacheSubnetGroups?.[0].CacheSubnetGroupName).toBe(name);
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill(name);
    await page.getByTestId("confirm-delete").click();
    await expect(page).toHaveURL(/\/elasticache\/subnet-groups\?deleted=/);
  } finally {
    await aws("elasticache", "delete-cache-subnet-group", "--cache-subnet-group-name", name).catch(() => null);
  }
});
