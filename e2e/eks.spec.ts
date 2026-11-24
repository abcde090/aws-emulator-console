import { expect, test, type Page } from "@playwright/test";
import { aws, uniqueName } from "./aws-cli";

interface Subnets {
  Subnets?: { SubnetId?: string; AvailabilityZone?: string }[];
}

async function defaultSubnets(): Promise<string[]> {
  const r = await aws<Subnets>("ec2", "describe-subnets", "--filters", "Name=default-for-az,Values=true");
  const ids = (r?.Subnets ?? []).map((s) => s.SubnetId ?? "").filter(Boolean);
  if (ids.length < 2) throw new Error("The emulator's default VPC needs at least two subnets for this test.");
  return ids.slice(0, 2);
}

async function clusterStatus(name: string): Promise<string | null> {
  const r = await aws<{ cluster?: { status?: string } }>("eks", "describe-cluster", "--name", name).catch(() => null);
  return r?.cluster?.status ?? null;
}

async function nodegroups(cluster: string): Promise<string[]> {
  const r = await aws<{ nodegroups?: string[] }>("eks", "list-nodegroups", "--cluster-name", cluster).catch(() => null);
  return r?.nodegroups ?? [];
}

async function waitFor(check: () => Promise<boolean>, what: string, timeoutMs = 30_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function runAction(page: Page, label: string) {
  await page.getByRole("button", { name: "Actions" }).click();
  await page.getByRole("menuitem", { name: label }).click();
}

test("EKS: create a cluster, add a node group from its Compute tab, change logging, delete both", async ({ page }) => {
  test.setTimeout(150_000);
  const cluster = uniqueName("e2e-eks");
  const ng = uniqueName("e2e-eks-ng");
  const subnets = await defaultSubnets();
  // The test's own role (never rely on roles someone else left in the emulator).
  const role = uniqueName("e2e-eks-role");
  const trust = JSON.stringify({
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Principal: { Service: ["eks.amazonaws.com", "ec2.amazonaws.com"] }, Action: "sts:AssumeRole" }],
  });
  const roleArn = (await aws<{ Role: { Arn: string } }>("iam", "create-role", "--role-name", role, "--assume-role-policy-document", trust))?.Role.Arn ?? "";
  try {
    await page.goto("/eks/clusters");
    await expect(page.getByRole("heading", { name: /^Clusters/ })).toBeVisible();
    await page.getByRole("link", { name: "Create cluster" }).first().click();
    await expect(page.getByTestId("create-form")).toBeVisible();
    await page.getByLabel("Name", { exact: true }).fill(cluster);
    await page.getByLabel("Cluster IAM role").selectOption(roleArn);
    await page.getByLabel("Subnets").selectOption(subnets);
    await page.getByText("API server", { exact: true }).click();
    await page.getByRole("button", { name: "Create cluster" }).click();

    await expect(page).toHaveURL(new RegExp(`/eks/clusters/${cluster}`));
    await expect(page.getByTestId("flash")).toContainText(`Created cluster ${cluster}`);
    await expect(page.getByTestId("kv-name")).toHaveText(cluster);

    const described = await aws<{ cluster?: { name?: string; logging?: { clusterLogging?: { types?: string[]; enabled?: boolean }[] } } }>("eks", "describe-cluster", "--name", cluster);
    expect(described?.cluster?.name).toBe(cluster);
    expect(described?.cluster?.logging?.clusterLogging?.some((l) => l.enabled && l.types?.includes("api"))).toBe(true);
    const listed = await aws<{ clusters?: string[] }>("eks", "list-clusters");
    expect(listed?.clusters).toContain(cluster);

    await waitFor(async () => (await clusterStatus(cluster)) === "ACTIVE", "cluster ACTIVE");
    await page.reload();
    await expect(page.getByTestId("kv-status")).toHaveText(/ACTIVE/);
    await page.getByRole("tab", { name: "Networking" }).click();
    await expect(page.getByTestId("kv-Subnets")).toContainText(subnets[0]);

    // Compute tab -> Add node group (the cluster is preset).
    await page.getByRole("tab", { name: "Compute" }).click();
    await page.getByRole("link", { name: "Add node group" }).click();
    await expect(page.getByTestId("create-form")).toBeVisible();
    await expect(page.getByLabel("Cluster", { exact: true })).toHaveValue(cluster);
    await page.getByLabel("Name", { exact: true }).fill(ng);
    await page.getByLabel("Node IAM role").selectOption(roleArn);
    await page.getByLabel("Subnets").selectOption([subnets[0]]);
    await page.getByRole("button", { name: "Add node group" }).click();
    await expect(page).toHaveURL(new RegExp(`/eks/node-groups/${cluster}`));
    await expect(page.getByTestId("kv-name")).toHaveText(ng);
    expect(await nodegroups(cluster)).toContain(ng);

    // Back on the cluster, the node group is listed; run an action on the cluster.
    await page.goto(`/eks/clusters/${cluster}`);
    await page.getByRole("tab", { name: "Compute" }).click();
    await expect(page.getByTestId("cluster-nodegroups")).toContainText(ng);
    await runAction(page, "Manage control plane logging");
    await page.getByRole("dialog").getByText("Audit", { exact: true }).click();
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog")).toContainText("LoggingUpdate");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    await waitFor(async () => {
      const r = await aws<{ cluster?: { logging?: { clusterLogging?: { types?: string[]; enabled?: boolean }[] } } }>("eks", "describe-cluster", "--name", cluster);
      return r?.cluster?.logging?.clusterLogging?.some((l) => l.enabled && l.types?.includes("audit")) === true;
    }, "audit logging on");

    // Delete the node group from its page, then the cluster from the list.
    await waitFor(async () => {
      const r = await aws<{ nodegroup?: { status?: string } }>("eks", "describe-nodegroup", "--cluster-name", cluster, "--nodegroup-name", ng);
      return r?.nodegroup?.status === "ACTIVE";
    }, "node group ACTIVE");
    await page.goto(`/eks/node-groups/${encodeURIComponent(`${cluster}/${ng}`)}`);
    // Edit node group opens with the current scaling; saving it unchanged sends nothing.
    await runAction(page, "Edit node group");
    await expect(page.getByRole("dialog").getByTestId("field-desiredSize")).toHaveValue("2");
    await expect(page.getByRole("dialog").getByTestId("field-maxSize")).toHaveValue("2");
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("No changes to save");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill("delete");
    await page.getByTestId("confirm-delete").click();
    await expect(page).toHaveURL(/\/eks\/node-groups\?deleted=/);
    await waitFor(async () => !(await nodegroups(cluster)).includes(ng), "node group deleted", 60_000);
    await waitFor(async () => (await clusterStatus(cluster)) === "ACTIVE", "cluster ACTIVE after updates", 60_000);

    await page.goto("/eks/clusters");
    const row = page.getByTestId("resource-table").getByRole("row", { name: new RegExp(cluster) });
    await row.getByRole("radio").check();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill(cluster);
    await page.getByTestId("confirm-delete").click();
    await waitFor(async () => (await clusterStatus(cluster)) === null, "cluster deleted", 60_000);
  } finally {
    for (const n of await nodegroups(cluster)) await aws("eks", "delete-nodegroup", "--cluster-name", cluster, "--nodegroup-name", n).catch(() => null);
    await waitFor(async () => (await nodegroups(cluster)).length === 0, "cleanup node groups", 60_000).catch(() => null);
    if (await clusterStatus(cluster)) {
      await waitFor(async () => (await clusterStatus(cluster)) !== "UPDATING", "cleanup cluster idle", 60_000).catch(() => null);
      await aws("eks", "delete-cluster", "--name", cluster).catch(() => null);
    }
    await aws("iam", "delete-role", "--role-name", role).catch(() => null);
  }
});

test("EKS: cluster edit dialogs open with the current settings; saving them unchanged changes nothing", async ({ page }) => {
  test.setTimeout(120_000);
  const cluster = uniqueName("fix-eks-cl");
  const role = uniqueName("fix-eks-role");
  const user = uniqueName("fix-eks-user");
  const trust = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "eks.amazonaws.com" }, Action: "sts:AssumeRole" }] });
  const roleArn = (await aws<{ Role: { Arn: string } }>("iam", "create-role", "--role-name", role, "--assume-role-policy-document", trust))?.Role.Arn ?? "";
  type Described = { cluster?: { accessConfig?: unknown; deletionProtection?: boolean; logging?: unknown; upgradePolicy?: unknown; resourcesVpcConfig?: { endpointPublicAccess?: boolean; endpointPrivateAccess?: boolean; publicAccessCidrs?: string[] }; tags?: Record<string, string> } };
  const describe = async () => (await aws<Described>("eks", "describe-cluster", "--name", cluster))?.cluster;
  const dialog = page.getByRole("dialog");
  const open = async (label: string) => {
    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: label, exact: true }).click();
  };
  const submitUnchanged = async (text: string) => {
    await page.getByTestId("action-submit").click();
    await expect(dialog.getByTestId("flash")).toContainText(text);
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
  };
  try {
    const subnets = await defaultSubnets();
    await aws(
      "eks", "create-cluster", "--name", cluster, "--role-arn", roleArn,
      "--resources-vpc-config", `subnetIds=${subnets.join(",")},endpointPublicAccess=true,endpointPrivateAccess=true`,
      "--access-config", "authenticationMode=API_AND_CONFIG_MAP",
      "--logging", JSON.stringify({ clusterLogging: [{ types: ["audit"], enabled: true }] }),
      "--upgrade-policy", "supportType=STANDARD", "--no-deletion-protection", "--tags", "team=blue,env=prod"
    );
    await waitFor(async () => (await clusterStatus(cluster)) === "ACTIVE", "cluster ACTIVE");
    const before = await describe();
    await page.goto(`/eks/clusters/${cluster}`);

    await open("Manage access (authentication mode)");
    await expect(dialog.getByTestId("field-authenticationMode").locator('input[value="API_AND_CONFIG_MAP"]')).toBeChecked();
    await submitUnchanged("No changes to save");

    await open("Edit deletion protection");
    await expect(dialog.getByTestId("field-on")).not.toBeChecked();
    await submitUnchanged("No changes to save");

    await open("Manage control plane logging");
    await expect(dialog.getByTestId("field-log_audit")).toBeChecked();
    await expect(dialog.getByTestId("field-log_api")).not.toBeChecked();
    await submitUnchanged("No changes to save");

    await open("Manage endpoint access");
    await expect(dialog.getByTestId("field-endpointAccess").locator('input[value="public-private"]')).toBeChecked();
    await submitUnchanged("No changes to save");

    await open("Edit upgrade policy");
    await expect(dialog.getByTestId("field-supportType").locator('input[value="STANDARD"]')).toBeChecked();
    await submitUnchanged("No changes to save");

    await open("Manage tags");
    await expect(dialog.getByLabel("Tags key 1")).toHaveValue(/team|env/);
    await submitUnchanged("No tag changes");

    const after = await describe();
    expect(after?.accessConfig).toEqual(before?.accessConfig);
    expect(after?.deletionProtection).toEqual(before?.deletionProtection);
    expect(after?.logging).toEqual(before?.logging);
    expect(after?.upgradePolicy).toEqual(before?.upgradePolicy);
    expect(after?.resourcesVpcConfig?.endpointPrivateAccess).toBe(true);
    expect(after?.tags).toEqual({ team: "blue", env: "prod" });
    const updates = await aws<{ updateIds?: string[] }>("eks", "list-updates", "--name", cluster);
    expect(updates?.updateIds ?? []).toEqual([]);

    // A user allowed only to list and describe clusters still sees the cluster; only the
    // tabs that need other calls (ListUpdates, ListInsights) show the denial.
    const policy = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["eks:ListClusters", "eks:DescribeCluster"], Resource: "*" }] });
    await aws("iam", "create-user", "--user-name", user);
    await aws("iam", "put-user-policy", "--user-name", user, "--policy-name", "eks-read", "--policy-document", policy);
    await page.getByTestId("identity-button").click();
    await page.getByRole("menu", { name: "Identity" }).getByRole("button", { name: new RegExp(`user ${user}`) }).click();
    await expect(page.getByTestId("identity-banner")).toContainText(`IAM user ${user}`);
    await page.goto(`/eks/clusters/${cluster}`);
    await expect(page.getByTestId("kv-name")).toHaveText(cluster);
    await page.getByRole("tab", { name: "Update history" }).click();
    await expect(page.getByText(/Unavailable: .*eks:ListUpdates/)).toBeVisible();
    await page.getByRole("button", { name: "Switch back to admin" }).click();
  } finally {
    await aws("iam", "delete-user-policy", "--user-name", user, "--policy-name", "eks-read").catch(() => null);
    await aws("iam", "delete-user", "--user-name", user).catch(() => null);
    if (await clusterStatus(cluster)) {
      await waitFor(async () => (await clusterStatus(cluster)) !== "CREATING" && (await clusterStatus(cluster)) !== "UPDATING", "cleanup cluster idle", 60_000).catch(() => null);
      await aws("eks", "delete-cluster", "--name", cluster).catch(() => null);
      await waitFor(async () => (await clusterStatus(cluster)) === null, "cleanup cluster deleted", 60_000).catch(() => null);
    }
    await aws("iam", "delete-role", "--role-name", role).catch(() => null);
  }
});
