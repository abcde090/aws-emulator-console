import { expect, test } from "@playwright/test";
import { aws, uniqueName } from "./aws-cli";

test("SSM Parameter Store: create a SecureString, add a version, delete it", async ({ page }) => {
  const name = `/e2e-ssm/${uniqueName("param")}`;
  try {
    await page.goto("/ssm/parameters");
    await expect(page.getByRole("heading", { name: /^Parameter Store/ })).toBeVisible();
    await page.getByRole("link", { name: "Create parameter" }).first().click();
    await page.getByLabel("Name", { exact: true }).fill(name);
    await page.getByLabel(/^Description/).fill("e2e parameter");
    await page.getByRole("radio", { name: /^SecureString/ }).check();
    await page.getByLabel("Value", { exact: true }).fill("s3cret-v1");
    await page.getByRole("button", { name: "Create parameter" }).click();

    await expect(page.getByTestId("flash")).toContainText(`Created parameter ${name}`);
    await expect(page.getByTestId("kv-Name")).toHaveText(name);
    await expect(page.getByTestId("kv-Type")).toHaveText("SecureString");
    await expect(page.getByTestId("kv-Version")).toHaveText("1");
    const cli = await aws<{ Parameter: { Value: string; Type: string } }>("ssm", "get-parameter", "--name", name, "--with-decryption");
    expect(cli?.Parameter).toMatchObject({ Value: "s3cret-v1", Type: "SecureString" });

    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Edit value" }).click();
    await page.getByLabel("Value", { exact: true }).fill("s3cret-v2");
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog")).toContainText("updated to version 2");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    await expect(page.getByTestId("kv-Version")).toHaveText("2");
    await expect(page.getByTestId("kv-Value")).toHaveText("s3cret-v2");
    await page.getByRole("tab", { name: "History" }).click();
    await expect(page.getByRole("cell", { name: "****" })).toHaveCount(2);

    await page.goto("/ssm/parameters");
    const row = page.getByTestId("resource-table").getByRole("row", { name: new RegExp(name) });
    await expect(row).toBeVisible();
    await row.getByRole("link", { name }).click();
    await expect(page.getByTestId("kv-Name")).toHaveText(name);
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill("delete");
    await page.getByTestId("confirm-delete").click();
    await expect(page).toHaveURL(/\/ssm\/parameters\?deleted=/);
    const after = await aws<{ Parameters: unknown[] }>("ssm", "describe-parameters", "--parameter-filters", `Key=Name,Values=${name}`);
    expect(after?.Parameters ?? []).toHaveLength(0);
  } finally {
    await aws("ssm", "delete-parameter", "--name", name).catch(() => null);
  }
});

test("SSM Maintenance Windows: create, register a target, disable, delete", async ({ page }) => {
  const name = uniqueName("e2e-ssm-mw");
  let id = "";
  try {
    await page.goto("/ssm/maintenance-windows/create");
    await page.getByLabel("Name", { exact: true }).fill(name);
    await page.getByLabel("Schedule", { exact: true }).fill("rate(7 days)");
    await page.getByRole("button", { name: "Create maintenance window" }).click();
    await expect(page.getByTestId("kv-Name")).toHaveText(name);
    id = (await page.getByTestId("kv-Window ID").textContent()) ?? "";
    expect(id).toMatch(/^mw-/);
    const cli = await aws<{ Schedule: string; Enabled: boolean }>("ssm", "get-maintenance-window", "--window-id", id);
    expect(cli).toMatchObject({ Schedule: "rate(7 days)", Enabled: true });

    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Register targets" }).click();
    await page.getByLabel("Tag (Key=Value) or instance IDs").fill("Patch Group=e2e");
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog")).toContainText("Registered target");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    await page.getByRole("tab", { name: "Targets" }).click();
    await expect(page.getByText("tag:Patch Group=e2e")).toBeVisible();

    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Disable" }).click();
    await page.getByTestId("action-submit").click();
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    await expect(page.getByTestId("kv-State")).toHaveText("Disabled");

    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill("delete");
    await page.getByTestId("confirm-delete").click();
    await expect(page).toHaveURL(/\/ssm\/maintenance-windows\?deleted=/);
    await expect(page.getByTestId("resource-table").getByRole("row", { name: new RegExp(name) })).toHaveCount(0);
  } finally {
    if (id) await aws("ssm", "delete-maintenance-window", "--window-id", id).catch(() => null);
  }
});

test("SSM: Edit value and Manage tags show current values and saving unchanged changes nothing", async ({ page }) => {
  const name = `/fix-ssm/${uniqueName("param")}`;
  const save = async () => {
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toBeVisible();
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
  };
  try {
    await aws("ssm", "put-parameter", "--name", name, "--value", "hello", "--type", "String", "--description", "orig desc", "--tags", "Key=env,Value=prod");
    await page.goto(`/ssm/parameters/${encodeURIComponent(name)}`);
    await expect(page.getByTestId("kv-Version")).toHaveText("1");
    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Edit value" }).click();
    await expect(page.getByTestId("field-value")).toHaveValue("hello");
    await expect(page.getByTestId("field-description")).toHaveValue("orig desc");
    await save();

    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Manage tags" }).click();
    await expect(page.getByLabel("Tags key 1")).toHaveValue("env");
    await expect(page.getByLabel("Tags value 1")).toHaveValue("prod");
    await save();

    const p = await aws<{ Parameters: { Version: number; Description?: string }[] }>("ssm", "describe-parameters", "--parameter-filters", `Key=Name,Values=${name}`);
    expect(p?.Parameters[0]).toMatchObject({ Version: 1, Description: "orig desc" });
    const tags = await aws<{ TagList: { Key: string; Value: string }[] }>("ssm", "list-tags-for-resource", "--resource-type", "Parameter", "--resource-id", name);
    expect(tags?.TagList).toEqual([{ Key: "env", Value: "prod" }]);
  } finally {
    await aws("ssm", "delete-parameter", "--name", name).catch(() => null);
  }
});
