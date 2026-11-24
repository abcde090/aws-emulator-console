import { expect, test, type Page } from "@playwright/test";
import { aws, uniqueName } from "./aws-cli";

async function runAction(page: Page, label: string) {
  const item = page.getByRole("menuitem", { name: label, exact: true });
  // The menu only opens once the page has hydrated; retry the click until it does.
  await expect(async () => {
    if (!(await item.isVisible())) await page.getByRole("button", { name: "Actions" }).click();
    await expect(item).toBeVisible({ timeout: 1000 });
  }).toPass();
  await item.click();
}

test("Secrets Manager: store a key/value secret, retrieve and edit it, schedule deletion and restore", async ({ page }) => {
  const name = `e2e-secretsmanager/${uniqueName("app")}`;
  try {
    await page.goto("/secretsmanager/secrets");
    await expect(page.getByRole("heading", { name: /^Secrets/ })).toBeVisible();
    await page.getByRole("link", { name: "Store a new secret" }).first().click();
    await page.getByLabel("Other type of secret (API key, OAuth token, other)").check();
    await page.getByRole("button", { name: "Add new tag" }).first().click();
    await page.getByLabel("Key/value pairs key 1").fill("username");
    await page.getByLabel("Key/value pairs value 1").fill("admin");
    await page.getByLabel("Secret name", { exact: true }).fill(name);
    await page.getByRole("button", { name: "Store a new secret" }).click();

    await expect(page.getByTestId("flash").filter({ hasText: `Secret ${name} stored` })).toBeVisible();
    await expect(page.getByTestId("kv-Secret name")).toHaveText(name);
    const value = await aws<{ SecretString: string }>("secretsmanager", "get-secret-value", "--secret-id", name);
    expect(JSON.parse(value?.SecretString ?? "{}")).toEqual({ username: "admin" });

    await page.getByTestId("retrieve-secret").click();
    await expect(page.getByTestId("secret-kv")).toContainText("admin");
    await page.getByTestId("edit-secret").click();
    await page.getByLabel("Secret value").fill('{"username":"admin","password":"s3cret"}');
    await page.getByTestId("save-secret").click();
    await expect(page.getByTestId("secret-kv")).toContainText("s3cret");
    const versions = await aws<{ Versions: unknown[] }>("secretsmanager", "list-secret-version-ids", "--secret-id", name);
    expect(versions?.Versions.length).toBe(2);

    // Edit dialogs show the secret's current values; saving unchanged changes nothing.
    await aws("secretsmanager", "update-secret", "--secret-id", name, "--description", "fix-secretsmanager keep me");
    await aws("secretsmanager", "tag-resource", "--secret-id", name, "--tags", "Key=team,Value=blue");
    await page.reload();
    await runAction(page, "Edit description");
    await expect(page.getByTestId("field-description")).toHaveValue("fix-secretsmanager keep me");
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("No changes");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    await runAction(page, "Edit encryption key");
    await expect(page.getByTestId("field-kmsKeyId")).toHaveValue("aws/secretsmanager");
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("No changes");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    await runAction(page, "Edit tags");
    await expect(page.getByLabel("Tags key 1")).toHaveValue("team");
    await expect(page.getByLabel("Tags value 1")).toHaveValue("blue");
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("No tag changes");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    const kept = await aws<{ Description: string; Tags: { Key: string; Value: string }[]; KmsKeyId?: string }>("secretsmanager", "describe-secret", "--secret-id", name);
    expect(kept?.Description).toBe("fix-secretsmanager keep me");
    expect(kept?.Tags).toEqual([{ Key: "team", Value: "blue" }]);
    expect(kept?.KmsKeyId).toBeUndefined();

    await page.goto("/secretsmanager/secrets");
    await page.getByLabel("Find secrets").fill(name);
    const row = page.getByTestId("resource-table").getByRole("row", { name: new RegExp(name) });
    await expect(row).toContainText("Active");
    await row.getByRole("radio").check();
    // Cancel deletion only applies to secrets scheduled for deletion.
    await page.getByRole("button", { name: "Actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Delete secret", exact: true })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Cancel deletion", exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await runAction(page, "Delete secret");
    await page.getByLabel("Waiting period (days)").fill("7");
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("scheduled for deletion");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    await expect(row).toContainText("Scheduled for deletion");
    const desc = await aws<{ DeletedDate?: string }>("secretsmanager", "describe-secret", "--secret-id", name);
    expect(desc?.DeletedDate).toBeTruthy();

    await row.getByRole("radio").check();
    await runAction(page, "Cancel deletion");
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("cancelled");
    const restored = await aws<{ DeletedDate?: string }>("secretsmanager", "describe-secret", "--secret-id", name);
    expect(restored?.DeletedDate).toBeUndefined();
  } finally {
    const list = await aws<{ SecretList: { Name: string }[] }>("secretsmanager", "list-secrets", "--include-planned-deletion");
    if (list?.SecretList.some((x) => x.Name === name)) await aws("secretsmanager", "delete-secret", "--secret-id", name, "--force-delete-without-recovery");
  }
});

test("Secrets Manager: store RDS database credentials", async ({ page }) => {
  const name = `fix-secretsmanager/${uniqueName("db")}`;
  try {
    await page.goto("/secretsmanager/secrets/create");
    await page.getByLabel("Credentials for Amazon RDS database").check();
    await page.getByTestId("field-dbUsername").fill("admin");
    await expect(page.getByTestId("field-dbPassword")).toHaveAttribute("type", "password");
    await page.getByTestId("field-dbPassword").fill("Pa55word!");
    await page.getByTestId("field-dbEngine").selectOption("postgres");
    await page.getByTestId("field-dbHost").fill("db.fix.local");
    await page.getByLabel("Secret name", { exact: true }).fill(name);
    await page.getByRole("button", { name: "Store a new secret" }).click();
    await expect(page.getByTestId("flash").filter({ hasText: `Secret ${name} stored` })).toBeVisible();
    const value = await aws<{ SecretString: string }>("secretsmanager", "get-secret-value", "--secret-id", name);
    expect(JSON.parse(value?.SecretString ?? "{}")).toEqual({ username: "admin", password: "Pa55word!", engine: "postgres", host: "db.fix.local", port: 5432 });
  } finally {
    const list = await aws<{ SecretList: { Name: string }[] }>("secretsmanager", "list-secrets", "--include-planned-deletion");
    if (list?.SecretList.some((x) => x.Name === name)) await aws("secretsmanager", "delete-secret", "--secret-id", name, "--force-delete-without-recovery");
  }
});
