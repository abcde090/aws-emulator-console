import { expect, test, type Page } from "@playwright/test";
import { aws, uniqueName } from "./aws-cli";

async function runAction(page: Page, label: string, fill?: () => Promise<void>): Promise<void> {
  await page.getByRole("button", { name: "Actions" }).click();
  await page.getByRole("menuitem", { name: label, exact: true }).click();
  if (fill) await fill();
  await page.getByTestId("action-submit").click();
}

const closeDialog = (page: Page) => page.getByRole("button", { name: "Close", exact: true }).last().click();

/** Glue database and table names allow only lowercase letters, numbers and underscores. */
const glueName = (prefix: string) => uniqueName(prefix).replace(/-/g, "_");

const made = { db: "", crawler: "", role: "", bucket: "" };

test.afterEach(async () => {
  if (made.crawler) await aws("glue", "delete-crawler", "--name", made.crawler).catch(() => null);
  if (made.db) await aws("glue", "delete-database", "--name", made.db).catch(() => null);
  if (made.role) await aws("iam", "delete-role", "--role-name", made.role).catch(() => null);
  if (made.bucket) await aws("s3", "rb", `s3://${made.bucket}`, "--force").catch(() => null);
  Object.assign(made, { db: "", crawler: "", role: "", bucket: "" });
});

async function openAction(page: Page, label: string): Promise<void> {
  await page.getByRole("button", { name: "Actions" }).click();
  await page.getByRole("menuitem", { name: label, exact: true }).click();
}

test("Glue: add a database and a table through the forms, edit, delete", async ({ page }) => {
  const db = glueName("e2e_glue_db");
  made.db = db;

  await page.goto("/glue/databases");
  await expect(page.getByRole("heading", { name: /^Databases/ })).toBeVisible();
  await page.getByRole("link", { name: "Add database" }).first().click();
  await page.getByLabel("Name", { exact: true }).fill(db);
  await page.getByLabel("Description - optional").fill("created by e2e");
  await page.getByRole("button", { name: "Add database" }).click();

  await expect(page).toHaveURL(new RegExp(`/glue/databases/${db}`));
  await expect(page.getByTestId("flash")).toContainText(`Created database ${db}`);
  await expect(page.getByTestId("kv-Description")).toHaveText("created by e2e");
  const got = await aws<{ Database: { Name: string } }>("glue", "get-database", "--name", db);
  expect(got?.Database.Name).toBe(db);

  await runAction(page, "Edit", async () => {
    await page.getByRole("dialog").getByLabel("Description - optional").fill("edited by e2e");
  });
  await expect(page.getByRole("dialog").getByTestId("flash")).toContainText(`Database ${db} updated`);
  await closeDialog(page);
  await expect(page.getByTestId("kv-Description")).toHaveText("edited by e2e");

  // A table with a schema and an S3 location.
  await page.goto("/glue/tables/create");
  await page.getByLabel("Name", { exact: true }).fill("orders");
  await page.getByLabel("Database", { exact: true }).selectOption(db);
  await page.getByLabel("Data location (include path)").fill("s3://e2e-glue-data/orders/");
  await page.getByLabel("Schema", { exact: true }).fill("id int\ncustomer string\namount decimal(10,2)");
  await page.getByLabel("Partition keys - optional").fill("year string");
  await page.getByRole("button", { name: "Add table" }).click();
  await expect(page).toHaveURL(new RegExp(`/glue/tables/${db}`));
  await expect(page.getByTestId("kv-Location")).toHaveText("s3://e2e-glue-data/orders/");
  await expect(page.getByText("decimal(10,2)")).toBeVisible();
  const table = await aws<{ Table: { StorageDescriptor: { Columns: { Name: string }[] }; PartitionKeys: { Name: string }[] } }>("glue", "get-table", "--database-name", db, "--name", "orders");
  expect(table?.Table.StorageDescriptor.Columns.map((c) => c.Name)).toEqual(["id", "customer", "amount"]);
  expect(table?.Table.PartitionKeys.map((c) => c.Name)).toEqual(["year"]);

  await page.goto("/glue/tables");
  const tableRow = page.getByTestId("resource-table").getByRole("row", { name: new RegExp(db) });
  await expect(tableRow).toBeVisible();
  await tableRow.getByRole("radio").check();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByLabel("Confirm deletion").fill("delete");
  await page.getByTestId("confirm-delete").click();
  await expect(page.getByTestId("resource-table").getByRole("row", { name: new RegExp(db) })).toHaveCount(0);

  await page.goto("/glue/databases");
  const row = page.getByTestId("resource-table").getByRole("row", { name: new RegExp(db) });
  await row.getByRole("radio").check();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByLabel("Confirm deletion").fill(db);
  await page.getByTestId("confirm-delete").click();
  await expect(page.getByTestId("flash")).toContainText(`Deleted database ${db}`);
  const dbs = await aws<{ DatabaseList: { Name: string }[] }>("glue", "get-databases");
  expect(dbs?.DatabaseList.some((d) => d.Name === db)).toBe(false);
  made.db = "";
});

interface DatabaseOut {
  Database: { Name: string; Description?: string; LocationUri?: string; Parameters?: Record<string, string> };
}

test("Glue: Edit database opens with its values and keeps LocationUri and properties", async ({ page }) => {
  const db = glueName("fix_glue_db");
  made.db = db;
  await aws("glue", "create-database", "--database-input", JSON.stringify({ Name: db, Description: "keepme", LocationUri: "s3://fix-glue-data/db/", Parameters: { owner: "fix" } }));
  const before = await aws<DatabaseOut>("glue", "get-database", "--name", db);

  await page.goto(`/glue/databases/${db}`);
  await openAction(page, "Edit");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByTestId("field-description")).toHaveValue("keepme");
  await expect(dialog.getByTestId("field-location")).toHaveValue("s3://fix-glue-data/db/");
  await dialog.getByTestId("action-submit").click();
  await expect(dialog.getByTestId("flash")).toContainText("No changes to save");
  await closeDialog(page);
  expect((await aws<DatabaseOut>("glue", "get-database", "--name", db))?.Database).toEqual(before?.Database);

  await openAction(page, "Edit");
  await dialog.getByTestId("field-description").fill("changed");
  await dialog.getByTestId("action-submit").click();
  await expect(dialog.getByTestId("flash")).toContainText(`Database ${db} updated`);
  await closeDialog(page);
  const after = await aws<DatabaseOut>("glue", "get-database", "--name", db);
  expect(after?.Database.Description).toBe("changed");
  expect(after?.Database.LocationUri).toBe("s3://fix-glue-data/db/");
  expect(after?.Database.Parameters).toEqual({ owner: "fix" });
});

test("Glue: Edit schedule opens with the crawler's schedule; saving unchanged changes nothing", async ({ page }) => {
  const db = glueName("fix_glue_crawl_db");
  const crawler = uniqueName("fix-glue-crawler");
  const role = uniqueName("fix-glue-role");
  const bucket = uniqueName("fix-glue-data");
  Object.assign(made, { db, crawler, role, bucket });
  await aws("s3api", "create-bucket", "--bucket", bucket);
  await aws("glue", "create-database", "--database-input", JSON.stringify({ Name: db }));
  const r = await aws<{ Role: { Arn: string } }>("iam", "create-role", "--role-name", role, "--assume-role-policy-document", JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "glue.amazonaws.com" }, Action: "sts:AssumeRole" }] }));
  await aws("glue", "create-crawler", "--name", crawler, "--role", r?.Role.Arn ?? "", "--database-name", db, "--targets", JSON.stringify({ S3Targets: [{ Path: `s3://${bucket}/in/` }] }), "--schedule", "cron(0 0 * * ? *)");
  const before = await aws<{ Crawler: { Schedule?: unknown } }>("glue", "get-crawler", "--name", crawler);

  await page.goto(`/glue/crawlers/${crawler}`);
  await openAction(page, "Edit schedule");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByTestId("field-frequency")).toHaveValue("daily");
  await dialog.getByTestId("action-submit").click();
  await expect(dialog.getByTestId("flash")).toContainText("No changes to save");
  await closeDialog(page);
  expect((await aws<{ Crawler: { Schedule?: unknown } }>("glue", "get-crawler", "--name", crawler))?.Crawler.Schedule).toEqual(before?.Crawler.Schedule);
});
