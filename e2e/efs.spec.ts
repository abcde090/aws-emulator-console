import { expect, test, type Page } from "@playwright/test";
import { aws, uniqueName } from "./aws-cli";

interface FileSystemsOut {
  FileSystems: { FileSystemId: string; Name?: string; ThroughputMode?: string }[];
}

async function runAction(page: Page, label: string, fill?: () => Promise<void>): Promise<void> {
  await page.getByRole("button", { name: "Actions" }).click();
  await page.getByRole("menuitem", { name: label, exact: true }).click();
  if (fill) await fill();
  await page.getByTestId("action-submit").click();
}

const closeDialog = (page: Page) => page.getByRole("button", { name: "Close", exact: true }).last().click();

const made = { name: "" };

/** Removes the test's file system (and its mount targets) even when the test fails. */
test.afterEach(async () => {
  if (!made.name) return;
  const fss = await aws<FileSystemsOut>("efs", "describe-file-systems").catch(() => null);
  for (const fs of fss?.FileSystems ?? []) {
    if (fs.Name !== made.name) continue;
    const mts = await aws<{ MountTargets: { MountTargetId: string }[] }>("efs", "describe-mount-targets", "--file-system-id", fs.FileSystemId).catch(() => null);
    for (const m of mts?.MountTargets ?? []) await aws("efs", "delete-mount-target", "--mount-target-id", m.MountTargetId).catch(() => null);
    await aws("efs", "delete-file-system", "--file-system-id", fs.FileSystemId).catch(() => null);
  }
  made.name = "";
});

test("EFS: create a file system, edit it, add and remove a mount target, delete it", async ({ page }) => {
  const name = uniqueName("e2e-efs");
  made.name = name;

  await page.goto("/efs/file-systems");
  await expect(page.getByRole("heading", { name: /^File systems/ })).toBeVisible();
  await page.getByRole("link", { name: "Create file system" }).first().click();
  await page.getByLabel("Name - optional", { exact: true }).fill(name);
  await page.getByRole("radio", { name: /^Bursting/ }).check();
  await page.getByLabel("Transition into Archive", { exact: true }).selectOption("NONE");
  await page.getByRole("button", { name: "Create file system" }).click();

  await expect(page).toHaveURL(/\/efs\/file-systems\/fs-/);
  const fsId = decodeURIComponent(new URL(page.url()).pathname.split("/").pop() ?? "");
  await expect(page.getByTestId("flash")).toContainText(`Created file system ${fsId}`);
  await expect(page.getByTestId("kv-Name")).toHaveText(name);
  await expect(page.getByTestId("kv-Throughput mode")).toHaveText("Bursting");

  const listed = await aws<FileSystemsOut>("efs", "describe-file-systems", "--file-system-id", fsId);
  expect(listed?.FileSystems[0]?.Name).toBe(name);
  const lifecycle = await aws<{ LifecyclePolicies: Record<string, string>[] }>("efs", "describe-lifecycle-configuration", "--file-system-id", fsId);
  expect(lifecycle?.LifecyclePolicies).toEqual([{ TransitionToIA: "AFTER_30_DAYS" }]);

  // An action: turn automatic backups off.
  await runAction(page, "Edit automatic backups", async () => {
    await page.getByRole("dialog").getByRole("radio", { name: "Disabled" }).check();
  });
  await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("Backup policy status");
  await closeDialog(page);
  const backup = await aws<{ BackupPolicy: { Status: string } }>("efs", "describe-backup-policy", "--file-system-id", fsId);
  expect(["DISABLED", "DISABLING"]).toContain(backup?.BackupPolicy.Status);

  // The list shows it.
  await page.goto("/efs/file-systems");
  await expect(page.getByTestId("resource-table").getByRole("row", { name: new RegExp(fsId) })).toBeVisible();

  // Mount target through the form, then delete it.
  await page.goto("/efs/mount-targets/create");
  await page.getByLabel("File system", { exact: true }).selectOption(fsId);
  await page.getByLabel("Subnet", { exact: true }).selectOption({ index: 1 });
  await page.getByRole("button", { name: "Create mount target" }).click();
  await expect(page).toHaveURL(/\/efs\/mount-targets\/fsmt-/);
  await expect(page.getByTestId("kv-File system ID")).toHaveText(fsId);
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByLabel("Confirm deletion").fill("delete");
  await page.getByTestId("confirm-delete").click();
  await expect(page).toHaveURL(/\/efs\/mount-targets\?deleted=/);

  // Delete the file system from its detail page.
  await page.goto(`/efs/file-systems/${fsId}`);
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  // confirmText "name": the dialog asks for the file system's Name tag, not its id.
  await page.getByLabel("Confirm deletion").fill(name);
  await page.getByTestId("confirm-delete").click();
  await expect(page).toHaveURL(/\/efs\/file-systems\?deleted=/);
  await expect(page.getByTestId("flash")).toContainText(`Deleted file system ${fsId}`);

  const after = await aws<FileSystemsOut>("efs", "describe-file-systems");
  expect(after?.FileSystems.some((f) => f.FileSystemId === fsId)).toBe(false);
  made.name = "";
});

async function openAction(page: Page, label: string): Promise<void> {
  await page.getByRole("button", { name: "Actions" }).click();
  await page.getByRole("menuitem", { name: label, exact: true }).click();
}

test("EFS: Edit dialogs open with the file system's settings; saving unchanged changes nothing", async ({ page }) => {
  const name = uniqueName("fix-efs");
  made.name = name;
  const created = await aws<{ FileSystemId: string }>("efs", "create-file-system", "--creation-token", name, "--throughput-mode", "bursting", "--tags", `Key=Name,Value=${name}`, "Key=env,Value=prod");
  const fsId = created?.FileSystemId ?? "";
  await expect(async () => {
    const fs = await aws<{ FileSystems: { LifeCycleState: string }[] }>("efs", "describe-file-systems", "--file-system-id", fsId);
    expect(fs?.FileSystems[0]?.LifeCycleState).toBe("available");
  }).toPass({ timeout: 30_000 });
  await aws("efs", "put-lifecycle-configuration", "--file-system-id", fsId, "--lifecycle-policies", "TransitionToIA=AFTER_7_DAYS");
  await aws("efs", "put-backup-policy", "--file-system-id", fsId, "--backup-policy", "Status=ENABLED");
  // ENABLING becomes ENABLED on its own, as on AWS; take the snapshot once it has settled.
  await expect
    .poll(async () => (await aws<{ BackupPolicy: { Status: string } }>("efs", "describe-backup-policy", "--file-system-id", fsId))?.BackupPolicy.Status, { timeout: 30_000 })
    .toBe("ENABLED");
  const state = async () => ({
    lifecycle: await aws("efs", "describe-lifecycle-configuration", "--file-system-id", fsId),
    backup: await aws("efs", "describe-backup-policy", "--file-system-id", fsId),
    fs: (await aws<{ FileSystems: { ThroughputMode: string; Tags: unknown[] }[] }>("efs", "describe-file-systems", "--file-system-id", fsId))?.FileSystems.map((f) => ({ mode: f.ThroughputMode, tags: f.Tags })),
  });
  const before = await state();

  await page.goto(`/efs/file-systems/${fsId}`);
  const dialog = page.getByRole("dialog");

  await openAction(page, "Edit lifecycle management");
  await expect(dialog.getByTestId("field-toIA")).toHaveValue("AFTER_7_DAYS");
  await expect(dialog.getByTestId("field-toArchive")).toHaveValue("NONE");
  await expect(dialog.getByTestId("field-toPrimary")).toHaveValue("NONE");
  await dialog.getByTestId("action-submit").click();
  await expect(dialog.getByTestId("flash")).toContainText("No changes to save");
  await closeDialog(page);

  await openAction(page, "Edit performance settings");
  await expect(dialog.getByTestId("field-throughputMode").getByRole("radio", { name: /^Bursting/ })).toBeChecked();
  await dialog.getByTestId("action-submit").click();
  await expect(dialog.getByTestId("flash")).toContainText("No changes to save");
  await closeDialog(page);

  await openAction(page, "Edit automatic backups");
  await expect(dialog.getByTestId("field-status").getByRole("radio", { name: "Enabled" })).toBeChecked();
  await dialog.getByTestId("action-submit").click();
  await expect(dialog.getByTestId("flash")).toContainText("already enabled");
  await closeDialog(page);

  await openAction(page, "Manage tags");
  await expect(dialog.getByTestId("field-tags").locator("input[placeholder='Key']")).toHaveCount(2);
  await dialog.getByTestId("action-submit").click();
  await expect(dialog.getByTestId("flash")).toContainText("No tag changes");
  await closeDialog(page);

  expect(await state()).toEqual(before);
});
