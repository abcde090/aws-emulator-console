import { expect, test } from "@playwright/test";
import { aws, uniqueName } from "./aws-cli";

type Arn = string;

async function endpointArn(id: string): Promise<Arn | undefined> {
  const r = await aws<{ Endpoints?: { EndpointIdentifier: string; EndpointArn: Arn }[] }>("dms", "describe-endpoints");
  return r?.Endpoints?.find((e) => e.EndpointIdentifier === id)?.EndpointArn;
}

async function instance(id: string): Promise<{ ReplicationInstanceArn: Arn; ReplicationInstanceStatus?: string } | undefined> {
  const r = await aws<{ ReplicationInstances?: { ReplicationInstanceIdentifier: string; ReplicationInstanceArn: Arn; ReplicationInstanceStatus?: string }[] }>("dms", "describe-replication-instances");
  return r?.ReplicationInstances?.find((i) => i.ReplicationInstanceIdentifier === id);
}

async function task(id: string): Promise<{ ReplicationTaskArn: Arn; Status?: string; MigrationType?: string } | undefined> {
  const r = await aws<{ ReplicationTasks?: { ReplicationTaskIdentifier: string; ReplicationTaskArn: Arn; Status?: string; MigrationType?: string }[] }>("dms", "describe-replication-tasks");
  return r?.ReplicationTasks?.find((t) => t.ReplicationTaskIdentifier === id);
}

async function deleteQuietly(...args: string[]): Promise<void> {
  await aws(...args).catch(() => null);
}

test("DMS: create an endpoint through the form and delete it", async ({ page }) => {
  const id = uniqueName("e2e-dms-ep");
  try {
    await page.goto("/dms/endpoints");
    await expect(page.getByRole("heading", { name: /^Endpoints/ })).toBeVisible();
    await page.getByRole("link", { name: "Create endpoint" }).first().click();
    await page.getByRole("radio", { name: "Target endpoint" }).check();
    await page.getByLabel("Endpoint identifier").fill(id);
    await page.getByLabel("Source or target engine").selectOption("postgres");
    await page.getByLabel("Server name").fill("10.0.0.9");
    // Port left empty: the engine's default (5432 for PostgreSQL) is used.
    await expect(page.getByTestId("field-password")).toHaveAttribute("type", "password");
    await page.getByLabel("User name").fill("admin");
    await page.getByLabel("Password", { exact: true }).fill("Secret123");
    await page.getByLabel(/^Database name/).fill("shop");
    await page.getByRole("button", { name: "Create endpoint" }).click();

    await expect(page).toHaveURL(new RegExp(`/dms/endpoints/${id}`));
    await expect(page.getByTestId("kv-Endpoint type")).toHaveText("Target");
    expect(await endpointArn(id)).toBeTruthy();
    const created = await aws<{ Endpoints?: { EndpointIdentifier: string; Port?: number }[] }>("dms", "describe-endpoints");
    expect(created?.Endpoints?.find((e) => e.EndpointIdentifier === id)?.Port).toBe(5432);

    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill(id);
    await page.getByTestId("confirm-delete").click();
    await expect(page).toHaveURL(/\/dms\/endpoints\?deleted=/);
    await expect.poll(async () => (await endpointArn(id)) === undefined, { timeout: 20_000 }).toBe(true);
  } finally {
    const arn = await endpointArn(id).catch(() => undefined);
    if (arn) await deleteQuietly("dms", "delete-endpoint", "--endpoint-arn", arn);
  }
});

test("DMS: create a migration task, start it, delete it", async ({ page }) => {
  const ri = uniqueName("e2e-dms-ri");
  const src = uniqueName("e2e-dms-src");
  const tgt = uniqueName("e2e-dms-tgt");
  const taskId = uniqueName("e2e-dms-task");
  try {
    await aws("dms", "create-replication-instance", "--replication-instance-identifier", ri, "--replication-instance-class", "dms.t3.micro", "--allocated-storage", "20");
    await aws("dms", "create-endpoint", "--endpoint-identifier", src, "--endpoint-type", "source", "--engine-name", "mysql", "--server-name", "10.0.1.1", "--port", "3306", "--username", "u", "--password", "Passw0rd");
    await aws("dms", "create-endpoint", "--endpoint-identifier", tgt, "--endpoint-type", "target", "--engine-name", "postgres", "--server-name", "10.0.2.2", "--port", "5432", "--username", "u", "--password", "Passw0rd");
    await expect.poll(async () => (await instance(ri))?.ReplicationInstanceStatus, { timeout: 30_000 }).toBe("available");

    await page.goto("/dms/tasks/create");
    // Wait for hydration so the form submits through React, not as a native GET.
    await page.waitForLoadState("networkidle");
    await page.getByLabel("Task identifier").fill(taskId);
    await page.getByLabel("Replication instance").selectOption({ label: `${ri} (dms.t3.micro, available)` });
    await page.getByLabel("Source database endpoint").selectOption({ label: `${src} (MySQL)` });
    await page.getByLabel("Target database endpoint").selectOption({ label: `${tgt} (PostgreSQL)` });
    await page.getByLabel("Schema name").fill("shop");
    await page.getByRole("button", { name: "Create database migration task" }).click();

    await expect(page).toHaveURL(new RegExp(`/dms/tasks/${taskId}`));
    await expect(page.getByTestId("kv-Source endpoint")).toHaveText(src);
    expect((await task(taskId))?.MigrationType).toBe("full-load");
    await expect.poll(async () => (await task(taskId))?.Status, { timeout: 30_000 }).toBe("ready");

    // Actions appear once the task leaves "creating".
    await page.reload();
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Restart/Resume" }).click();
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText(`Task ${taskId} is`);
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    await expect.poll(async () => (await task(taskId))?.Status, { timeout: 30_000 }).toBe("stopped");

    // Reopened on a stopped task, the dialog proposes resuming; closing it changes nothing.
    await page.reload();
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Restart/Resume" }).click();
    await expect(page.getByRole("dialog").getByRole("radio", { name: "Resume where the task stopped" })).toBeChecked();
    await page.getByRole("button", { name: "Cancel", exact: true }).last().click();
    expect((await task(taskId))?.Status).toBe("stopped");

    await page.goto("/dms/tasks");
    const row = page.getByTestId("resource-table").getByRole("row", { name: new RegExp(taskId) });
    await expect(row).toContainText(src);
    await row.getByRole("radio").check();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill(taskId);
    await page.getByTestId("confirm-delete").click();
    await expect.poll(async () => (await task(taskId)) === undefined, { timeout: 30_000 }).toBe(true);
  } finally {
    const t = await task(taskId).catch(() => undefined);
    if (t) {
      await deleteQuietly("dms", "delete-replication-task", "--replication-task-arn", t.ReplicationTaskArn);
      await expect.poll(async () => (await task(taskId)) === undefined, { timeout: 30_000 }).toBe(true).catch(() => null);
    }
    for (const id of [src, tgt]) {
      const arn = await endpointArn(id).catch(() => undefined);
      if (arn) await deleteQuietly("dms", "delete-endpoint", "--endpoint-arn", arn);
    }
    const i = await instance(ri).catch(() => undefined);
    if (i) await deleteQuietly("dms", "delete-replication-instance", "--replication-instance-arn", i.ReplicationInstanceArn);
  }
});
