import { expect, test, type Page } from "@playwright/test";
import { aws, uniqueName } from "./aws-cli";

const SUBNET = "subnet-00000000000000007";

interface Cluster { clusterName?: string; status?: string; settings?: { name: string; value: string }[] }
interface EcsService { serviceName?: string; desiredCount?: number; status?: string; taskDefinition?: string }
interface EcsTask { desiredStatus?: string; stoppedReason?: string; lastStatus?: string }

async function runAction(page: Page, label: string, fill?: () => Promise<void>, expectText?: string | RegExp) {
  await page.getByRole("button", { name: "Actions" }).click();
  await page.getByRole("menuitem", { name: label, exact: true }).click();
  if (fill) await fill();
  await page.getByTestId("action-submit").click();
  if (expectText) await expect(page.getByRole("dialog").getByTestId("flash")).toContainText(expectText);
  await page.getByRole("button", { name: "Close", exact: true }).last().click();
}

async function deleteViaDialog(page: Page) {
  await page.getByLabel("Confirm deletion").fill("delete");
  await page.getByTestId("confirm-delete").click();
}

/** Best-effort cleanup of everything a test may have left behind. Never throws. */
async function cleanup(cluster: string, service: string | null, family: string | null) {
  const quiet = (p: Promise<unknown>) => p.catch(() => undefined);
  if (service) await quiet(aws("ecs", "delete-service", "--cluster", cluster, "--service", service, "--force"));
  const tasks = await aws<{ taskArns: string[] }>("ecs", "list-tasks", "--cluster", cluster).catch(() => null);
  for (const t of tasks?.taskArns ?? []) await quiet(aws("ecs", "stop-task", "--cluster", cluster, "--task", t));
  for (let i = 0; i < 10; i++) {
    const r = await aws("ecs", "delete-cluster", "--cluster", cluster).then(() => true, () => false);
    if (r) break;
    await new Promise((res) => setTimeout(res, 1000));
  }
  if (family) {
    for (const status of ["ACTIVE", "INACTIVE"]) {
      const list = await aws<{ taskDefinitionArns: string[] }>("ecs", "list-task-definitions", "--family-prefix", family, "--status", status).catch(() => null);
      for (const arn of list?.taskDefinitionArns ?? []) {
        if (!arn.includes(`/${family}:`)) continue;
        if (status === "ACTIVE") await quiet(aws("ecs", "deregister-task-definition", "--task-definition", arn));
        await quiet(aws("ecs", "delete-task-definitions", "--task-definitions", arn));
      }
    }
  }
}

test("ECS: create a Fargate cluster, see it, update it, delete it", async ({ page }) => {
  const name = uniqueName("e2e-ecs-cluster");
  try {
    await page.goto("/ecs/clusters");
    await expect(page.getByRole("heading", { name: /^Clusters/ })).toBeVisible();
    await page.getByRole("link", { name: "Create cluster" }).first().click();
    await expect(page.getByTestId("create-form")).toBeVisible();
    await page.getByLabel("Cluster name").fill(name);
    await page.getByRole("radio", { name: "FARGATE", exact: true }).check();
    await page.getByRole("button", { name: "Create cluster" }).click();

    await expect(page).toHaveURL(new RegExp(`/ecs/clusters/${name}`));
    await expect(page.getByTestId("flash")).toContainText(`Created cluster ${name}`);
    await expect(page.getByTestId("kv-Cluster name")).toHaveText(name);
    await expect(page.getByTestId("kv-Status")).toContainText("ACTIVE");
    await expect(page.getByText("No services in this cluster.")).toBeVisible();

    const described = await aws<{ clusters: (Cluster & { capacityProviders?: string[]; defaultCapacityProviderStrategy?: { capacityProvider: string }[] })[] }>("ecs", "describe-clusters", "--clusters", name, "--include", "SETTINGS");
    expect(described?.clusters[0]?.capacityProviders).toEqual(["FARGATE", "FARGATE_SPOT"]);
    expect(described?.clusters[0]?.defaultCapacityProviderStrategy?.[0]?.capacityProvider).toBe("FARGATE");

    await page.getByRole("tab", { name: "Infrastructure" }).click();
    await expect(page.getByRole("cell", { name: "FARGATE_SPOT" })).toBeVisible();

    await runAction(page, "Update cluster", async () => {
      await page.getByRole("dialog").getByRole("radio", { name: "Container Insights", exact: true }).check();
    }, "CloudWatch monitoring: Container Insights");
    const after = await aws<{ clusters: Cluster[] }>("ecs", "describe-clusters", "--clusters", name, "--include", "SETTINGS");
    expect(after?.clusters[0]?.settings?.find((s) => s.name === "containerInsights")?.value).toBe("enabled");

    await page.goto("/ecs/clusters");
    const row = page.getByTestId("resource-table").getByRole("row", { name: new RegExp(name) });
    await expect(row).toBeVisible();
    await row.getByRole("radio").check();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await deleteViaDialog(page);
    await expect(page.getByTestId("flash")).toContainText(`Deleted cluster ${name}`);
    const listed = await aws<{ clusterArns: string[] }>("ecs", "list-clusters");
    expect(listed?.clusterArns.some((a) => a.endsWith(`/${name}`))).toBe(false);
  } finally {
    await cleanup(name, null, null);
  }
});

test("ECS: task definition revisions, a service and a task in a cluster", async ({ page }) => {
  test.setTimeout(150_000);
  const cluster = uniqueName("e2e-ecs-c");
  const family = uniqueName("e2e-ecs-td");
  const service = uniqueName("e2e-ecs-svc");
  await aws("ecs", "create-cluster", "--cluster-name", cluster, "--capacity-providers", "FARGATE", "FARGATE_SPOT");
  try {
    // Task definition through the form.
    await page.goto("/ecs/task-definitions");
    await page.getByRole("link", { name: "Create new task definition" }).first().click();
    await page.getByLabel("Task definition family").fill(family);
    await page.getByLabel("CPU", { exact: true }).selectOption("256");
    await page.getByLabel("Memory", { exact: true }).selectOption("512");
    await page.getByLabel("Container name").fill("web");
    await page.getByLabel("Image URI").fill("public.ecr.aws/nginx/nginx:latest");
    await page.getByLabel("Environment variables").fill("STAGE=e2e");
    await page.getByRole("button", { name: "Create new task definition" }).click();
    await expect(page).toHaveURL(new RegExp(`/ecs/task-definitions/${family}(%3A|:)1`));
    await expect(page.getByTestId("kv-Task definition")).toHaveText(`${family}:1`);
    await expect(page.getByTestId("kv-Network mode")).toHaveText("awsvpc");
    const td = await aws<{ taskDefinition: { cpu: string; memory: string; containerDefinitions: { environment: { name: string; value: string }[] }[] } }>("ecs", "describe-task-definition", "--task-definition", `${family}:1`);
    expect(td?.taskDefinition.cpu).toBe("256");
    expect(td?.taskDefinition.containerDefinitions[0].environment).toEqual([{ name: "STAGE", value: "e2e" }]);

    await runAction(page, "Create new revision", async () => {
      await page.getByRole("dialog").getByLabel("Image URI").fill("public.ecr.aws/nginx/nginx:1.27");
    }, `Registered ${family}:2`);
    await page.getByRole("tab", { name: "Revisions" }).click();
    await expect(page.getByTestId("td-revisions").getByRole("link", { name: `${family}:2` })).toBeVisible();

    // Service through the form.
    await page.goto("/ecs/services/create");
    await page.getByLabel("Existing cluster").selectOption({ label: cluster });
    await page.getByLabel("Task definition family and revision").selectOption({ label: `${family}:2` });
    await page.getByLabel("Service name").fill(service);
    await page.getByLabel("Subnets").selectOption(SUBNET);
    await page.getByRole("button", { name: "Create service" }).click();
    const serviceId = `${cluster}/${service}`;
    await expect(page.getByTestId("flash")).toContainText(`Created service ${serviceId}`);
    await expect(page.getByTestId("kv-Service name")).toHaveText(service);
    await expect(page.getByTestId("kv-Task definition: revision")).toHaveText(`${family}:2`);
    const svcs = await aws<{ serviceArns: string[] }>("ecs", "list-services", "--cluster", cluster);
    expect(svcs?.serviceArns.some((a) => a.endsWith(`/${service}`))).toBe(true);

    await runAction(page, "Update service", async () => {
      await page.getByRole("dialog").getByLabel("Desired tasks").fill("2");
    }, "desired tasks 2");
    const updated = await aws<{ services: EcsService[] }>("ecs", "describe-services", "--cluster", cluster, "--services", service);
    expect(updated?.services[0]?.desiredCount).toBe(2);

    // The cluster screen lists the service with a link.
    await page.goto(`/ecs/clusters/${cluster}`);
    await expect(page.getByTestId("cluster-services").getByRole("link", { name: service })).toBeVisible();

    // Run a standalone task, then stop it.
    await page.goto("/ecs/tasks/create");
    await page.getByLabel("Existing cluster").selectOption({ label: cluster });
    await page.getByLabel("Task definition family and revision").selectOption({ label: `${family}:1` });
    await page.getByLabel("Subnets").selectOption(SUBNET);
    await page.getByRole("button", { name: "Run task" }).click();
    await expect(page.getByTestId("flash")).toContainText(`Created task ${cluster}/`);
    const taskId = (await page.getByTestId("kv-Task ID").innerText()).trim();
    await expect(page.getByTestId("kv-Task definition: revision")).toHaveText(`${family}:1`);
    await page.getByRole("tab", { name: "Containers" }).click();
    await expect(page.getByRole("cell", { name: "public.ecr.aws/nginx/nginx:latest" })).toBeVisible();

    await runAction(page, "Stop", async () => {
      await page.getByRole("dialog").getByLabel("Reason for stopping").fill("stopped by e2e");
    }, "Stop requested");
    const stopped = await aws<{ tasks: EcsTask[] }>("ecs", "describe-tasks", "--cluster", cluster, "--tasks", taskId);
    expect(stopped?.tasks[0]?.desiredStatus).toBe("STOPPED");
    expect(stopped?.tasks[0]?.stoppedReason).toBe("stopped by e2e");
    await expect(page.getByTestId("kv-Stopped reason")).toHaveText("stopped by e2e");

    // Delete the service from its page.
    await page.goto(`/ecs/services/${encodeURIComponent(serviceId)}`);
    await expect(page.getByTestId("kv-Service name")).toHaveText(service);
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await deleteViaDialog(page);
    await expect(page).toHaveURL(/\/ecs\/services\?deleted=/);
    const gone = await aws<{ serviceArns: string[] }>("ecs", "list-services", "--cluster", cluster);
    expect(gone?.serviceArns ?? []).toHaveLength(0);

    // Deregister and delete revision 2 from its page.
    await page.goto(`/ecs/task-definitions/${family}:2`);
    await expect(page.getByTestId("kv-Task definition")).toHaveText(`${family}:2`);
    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Deregister", exact: true }).click();
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText(`${family}:2 is now INACTIVE`);
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    await runAction(page, "Delete", undefined, `${family}:2 is DELETE_IN_PROGRESS`);
    const inactive = await aws<{ taskDefinitionArns: string[] }>("ecs", "list-task-definitions", "--family-prefix", family, "--status", "INACTIVE");
    expect(inactive?.taskDefinitionArns ?? []).toHaveLength(0);
  } finally {
    await cleanup(cluster, service, family);
  }
});

async function openAction(page: Page, label: string) {
  await page.getByRole("button", { name: "Actions" }).click();
  await page.getByRole("menuitem", { name: label, exact: true }).click();
}

async function submitUnchanged(page: Page, expectText: string | RegExp) {
  await page.getByTestId("action-submit").click();
  await expect(page.getByRole("dialog").getByTestId("flash")).toContainText(expectText);
  await page.getByRole("button", { name: "Close", exact: true }).last().click();
}

test("ECS: edit dialogs open with the cluster's current values; saving them unchanged changes nothing", async ({ page }) => {
  const name = uniqueName("fix-ecs-cl");
  type Full = Cluster & { capacityProviders?: string[]; defaultCapacityProviderStrategy?: unknown[]; tags?: { key: string; value: string }[] };
  const describe = async () => (await aws<{ clusters: Full[] }>("ecs", "describe-clusters", "--clusters", name, "--include", "SETTINGS", "TAGS"))?.clusters[0];
  try {
    await aws(
      "ecs", "create-cluster", "--cluster-name", name, "--capacity-providers", "FARGATE", "FARGATE_SPOT",
      "--default-capacity-provider-strategy", "capacityProvider=FARGATE_SPOT,base=1,weight=2",
      "--settings", "name=containerInsights,value=enhanced", "--tags", "key=team,value=blue", "key=env,value=prod"
    );
    const before = await describe();
    await page.goto(`/ecs/clusters/${name}`);
    const dialog = page.getByRole("dialog");

    await openAction(page, "Update cluster");
    await expect(dialog.getByTestId("field-containerInsights").locator('input[value="enhanced"]')).toBeChecked();
    await submitUnchanged(page, "No changes to save");

    await openAction(page, "Update capacity providers");
    await expect(dialog.getByTestId("field-strategyProvider")).toHaveValue("FARGATE_SPOT");
    await expect(dialog.getByTestId("field-base")).toHaveValue("1");
    await expect(dialog.getByTestId("field-weight")).toHaveValue("2");
    await submitUnchanged(page, "No changes to save");

    await openAction(page, "Manage tags");
    await expect(dialog.getByLabel("Tags key 1")).toHaveValue(/team|env/);
    await expect(dialog.getByLabel("Tags key 2")).toHaveValue(/team|env/);
    await submitUnchanged(page, "No tag changes");

    const after = await describe();
    expect(after?.settings).toEqual(before?.settings);
    expect(after?.capacityProviders).toEqual(before?.capacityProviders);
    expect(after?.defaultCapacityProviderStrategy).toEqual(before?.defaultCapacityProviderStrategy);
    expect([...(after?.tags ?? [])].sort((a, b) => a.key.localeCompare(b.key))).toEqual([{ key: "env", value: "prod" }, { key: "team", value: "blue" }]);
  } finally {
    await cleanup(name, null, null);
  }
});
