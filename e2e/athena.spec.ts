import { expect, test, type Page } from "@playwright/test";
import { aws, uniqueName } from "./aws-cli";

async function runAction(page: Page, label: string, fill?: () => Promise<void>): Promise<void> {
  await page.getByRole("button", { name: "Actions" }).click();
  await page.getByRole("menuitem", { name: label, exact: true }).click();
  if (fill) await fill();
  await page.getByTestId("action-submit").click();
}

const closeDialog = (page: Page) => page.getByRole("button", { name: "Close", exact: true }).last().click();

const made = { workgroup: "", bucket: "" };

test.afterEach(async () => {
  if (made.workgroup) await aws("athena", "delete-work-group", "--work-group", made.workgroup, "--recursive-delete-option").catch(() => null);
  if (made.bucket) await aws("s3", "rb", `s3://${made.bucket}`, "--force").catch(() => null);
  made.workgroup = "";
  made.bucket = "";
});

test("Athena: create a workgroup, toggle it, run a query in the editor, delete the workgroup", async ({ page }) => {
  const wg = uniqueName("e2e-athena-wg");
  const bucket = uniqueName("e2e-athena-results");
  Object.assign(made, { workgroup: wg, bucket });
  await aws("s3api", "create-bucket", "--bucket", bucket);

  await page.goto("/athena/workgroups");
  await expect(page.getByRole("heading", { name: /^Workgroups/ })).toBeVisible();
  await page.getByRole("link", { name: "Create workgroup" }).first().click();
  await page.getByLabel("Workgroup name", { exact: true }).fill(wg);
  await page.getByLabel("Description - optional").fill("e2e workgroup");
  await page.getByLabel("Location of query result - optional").fill(`s3://${bucket}/results/`);
  await page.getByLabel("Data limit per query (MB) - optional").fill("100");
  await page.getByRole("button", { name: "Create workgroup" }).click();

  await expect(page).toHaveURL(new RegExp(`/athena/workgroups/${wg}`));
  await expect(page.getByTestId("flash")).toContainText(`Created workgroup ${wg}`);
  await expect(page.getByTestId("kv-Query result location")).toHaveText(`s3://${bucket}/results/`);
  const got = await aws<{ WorkGroup: { Configuration: { BytesScannedCutoffPerQuery: number } } }>("athena", "get-work-group", "--work-group", wg);
  expect(got?.WorkGroup.Configuration.BytesScannedCutoffPerQuery).toBe(100 * 1024 * 1024);

  await runAction(page, "Enable or disable", async () => {
    await page.getByRole("dialog").getByRole("radio", { name: /^Disabled/ }).check();
  });
  await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("is now DISABLED");
  await closeDialog(page);
  await expect(page.getByTestId("kv-State")).toHaveText(/DISABLED/);
  await runAction(page, "Enable or disable", async () => {
    await page.getByRole("dialog").getByRole("radio", { name: "Enabled" }).check();
  });
  await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("is now ENABLED");
  await closeDialog(page);

  await page.goto("/athena/workgroups");
  await expect(page.getByTestId("resource-table").getByRole("row", { name: new RegExp(wg) })).toBeVisible();

  // The hand-built query editor.
  await page.goto("/athena/query-editor");
  await expect(page.getByTestId("query-editor")).toBeVisible();
  await page.getByLabel("Workgroup", { exact: true }).selectOption(wg);
  await page.getByTestId("sql").fill("SELECT 1 AS answer, 'e2e' AS source");
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByTestId("query-state")).toContainText("SUCCEEDED", { timeout: 30_000 });
  const results = page.getByTestId("query-results");
  await expect(results).toContainText("answer");
  await expect(results).toContainText("e2e");
  const executions = await aws<{ QueryExecutionIds: string[] }>("athena", "list-query-executions", "--work-group", wg);
  expect(executions?.QueryExecutionIds.length).toBeGreaterThan(0);
  await page.getByRole("tab", { name: "Recent queries" }).click();
  await expect(page.getByTestId("recent-queries")).toContainText("SELECT 1 AS answer");

  // Delete the workgroup (and its query history) from the list.
  await page.goto("/athena/workgroups");
  const row = page.getByTestId("resource-table").getByRole("row", { name: new RegExp(wg) });
  await row.getByRole("radio").check();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByLabel("Confirm deletion").fill(wg);
  await page.getByTestId("confirm-delete").click();
  await expect(page.getByTestId("flash")).toContainText(`Deleted workgroup ${wg}`);
  const list = await aws<{ WorkGroups: { Name: string }[] }>("athena", "list-work-groups");
  expect(list?.WorkGroups.some((w) => w.Name === wg)).toBe(false);
  made.workgroup = "";
});

interface WorkGroupOut {
  WorkGroup: {
    Description?: string;
    State: string;
    Configuration: { EnforceWorkGroupConfiguration?: boolean; PublishCloudWatchMetricsEnabled?: boolean; BytesScannedCutoffPerQuery?: number; ResultConfiguration?: { OutputLocation?: string } };
  };
}

async function openAction(page: Page, label: string): Promise<void> {
  await page.getByRole("button", { name: "Actions" }).click();
  await page.getByRole("menuitem", { name: label, exact: true }).click();
}

test("Athena: Edit settings opens with the workgroup's settings and only sends what changed", async ({ page }) => {
  const wg = uniqueName("fix-athena-wg");
  made.workgroup = wg;
  const location = "s3://fix-athena-results/out/";
  await aws("athena", "create-work-group", "--name", wg, "--description", "keepme", "--configuration",
    JSON.stringify({ EnforceWorkGroupConfiguration: false, PublishCloudWatchMetricsEnabled: false, BytesScannedCutoffPerQuery: 100 * 1024 * 1024, ResultConfiguration: { OutputLocation: location } }));
  const before = await aws<WorkGroupOut>("athena", "get-work-group", "--work-group", wg);

  await page.goto(`/athena/workgroups/${wg}`);
  await openAction(page, "Edit settings");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByTestId("field-description")).toHaveValue("keepme");
  await expect(dialog.getByTestId("field-outputLocation")).toHaveValue(location);
  await expect(dialog.getByTestId("field-enforce")).not.toBeChecked();
  await expect(dialog.getByTestId("field-metrics")).not.toBeChecked();
  await expect(dialog.getByTestId("field-limitMb")).toHaveValue("100");
  await dialog.getByTestId("action-submit").click();
  await expect(dialog.getByTestId("flash")).toContainText("No changes to save");
  await closeDialog(page);
  expect(await aws<WorkGroupOut>("athena", "get-work-group", "--work-group", wg)).toEqual(before);

  // Change only the description: enforce, metrics, the data limit and the location stay.
  await openAction(page, "Edit settings");
  await expect(dialog.getByTestId("field-description")).toHaveValue("keepme");
  await dialog.getByTestId("field-description").fill("changed");
  await dialog.getByTestId("action-submit").click();
  await expect(dialog.getByTestId("flash")).toContainText(`Workgroup ${wg} updated`);
  await closeDialog(page);
  const after = await aws<WorkGroupOut>("athena", "get-work-group", "--work-group", wg);
  expect(after?.WorkGroup.Description).toBe("changed");
  expect(after?.WorkGroup.Configuration).toEqual(before?.WorkGroup.Configuration);

  // Enable or disable opens on the current state.
  await openAction(page, "Enable or disable");
  await expect(dialog.getByTestId("field-state").getByRole("radio", { name: "Enabled" })).toBeChecked();
  await closeDialog(page);
});
