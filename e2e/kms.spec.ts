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

test("KMS: create a symmetric key with an alias, encrypt, edit the key policy, schedule deletion", async ({ page }) => {
  const alias = uniqueName("e2e-kms");
  let keyId = "";
  try {
    await page.goto("/kms/keys");
    await expect(page.getByRole("heading", { name: /^Customer managed keys/ })).toBeVisible();
    await page.getByRole("link", { name: "Create key" }).first().click();
    await page.getByLabel("Alias", { exact: true }).fill(alias);
    await page.getByLabel("Description - optional").fill("e2e test key");
    await page.getByRole("button", { name: "Create key" }).click();

    await expect(page.getByTestId("flash").filter({ hasText: "Created key" })).toBeVisible();
    await expect(page.getByTestId("kv-Alias")).toHaveText(`alias/${alias}`);
    keyId = (await page.getByTestId("kv-Key ID").textContent()) ?? "";
    expect(keyId).toMatch(/^[0-9a-f-]{36}$/);

    const aliases = await aws<{ Aliases: { AliasName: string; TargetKeyId?: string }[] }>("kms", "list-aliases", "--key-id", keyId);
    expect(aliases?.Aliases.map((a) => a.AliasName)).toContain(`alias/${alias}`);

    await page.goto("/kms/keys");
    await page.getByLabel("Find customer managed keys").fill(alias);
    await expect(page.getByTestId("resource-table").getByRole("row", { name: new RegExp(alias) })).toBeVisible();
    await page.getByRole("link", { name: keyId }).click();
    await expect(page.getByTestId("kv-Status")).toHaveText("Enabled");

    await runAction(page, "Encrypt (test)");
    await page.getByLabel("Plaintext").fill("hello kms");
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("Encrypted");
    await expect(page.getByRole("dialog")).toContainText("CiphertextBlob");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();

    // Edit dialogs show the key's current values; saving unchanged changes nothing.
    await aws("kms", "update-key-description", "--key-id", keyId, "--description", "fix-kms keep me");
    await aws("kms", "tag-resource", "--key-id", keyId, "--tags", "TagKey=team,TagValue=blue", "TagKey=env,TagValue=e2e");
    await page.reload();
    await runAction(page, "Edit description");
    await expect(page.getByTestId("field-description")).toHaveValue("fix-kms keep me");
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("No changes");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    const kept = await aws<{ KeyMetadata: { Description: string } }>("kms", "describe-key", "--key-id", keyId);
    expect(kept?.KeyMetadata.Description).toBe("fix-kms keep me");

    await runAction(page, "Edit tags");
    await expect(page.getByLabel("Tags key 1")).toHaveValue(/team|env/);
    await expect(page.getByLabel("Tags key 2")).toHaveValue(/team|env/);
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("No tag changes");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    const tags = await aws<{ Tags: { TagKey: string; TagValue: string }[] }>("kms", "list-resource-tags", "--key-id", keyId);
    expect(tags?.Tags).toEqual(expect.arrayContaining([{ TagKey: "team", TagValue: "blue" }, { TagKey: "env", TagValue: "e2e" }]));
    expect(tags?.Tags.length).toBe(2);

    // Only actions that apply to a symmetric encryption key are offered.
    await page.getByRole("button", { name: "Actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Encrypt (test)", exact: true })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Sign (test)", exact: true })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "Cancel key deletion", exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");

    // Key policy editor: add a description-only change (Sid) and save.
    await page.getByRole("tab", { name: "Key policy", exact: true }).click();
    await page.getByTestId("json-edit").click();
    const policy = await aws<{ Policy: string }>("kms", "get-key-policy", "--key-id", keyId, "--policy-name", "default");
    const doc = JSON.parse(policy?.Policy ?? "{}") as { Statement: { Sid?: string }[] };
    doc.Statement[0].Sid = "EnableRootE2E";
    await page.getByLabel("Key policy JSON").fill(JSON.stringify(doc, null, 2));
    await page.getByTestId("json-save").click();
    await expect(page.getByTestId("flash").filter({ hasText: "Key policy saved" })).toBeVisible();
    const after = await aws<{ Policy: string }>("kms", "get-key-policy", "--key-id", keyId, "--policy-name", "default");
    expect(after?.Policy).toContain("EnableRootE2E");

    await runAction(page, "Schedule key deletion");
    await page.getByLabel("Waiting period (in days)").fill("7");
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("pending deletion");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    const described = await aws<{ KeyMetadata: { KeyState: string } }>("kms", "describe-key", "--key-id", keyId);
    expect(described?.KeyMetadata.KeyState).toBe("PendingDeletion");
  } finally {
    if (keyId) {
      const d = await aws<{ KeyMetadata: { KeyState: string } }>("kms", "describe-key", "--key-id", keyId);
      if (d?.KeyMetadata.KeyState !== "PendingDeletion") await aws("kms", "schedule-key-deletion", "--key-id", keyId, "--pending-window-in-days", "7");
    }
    const left = await aws<{ Aliases: { AliasName: string }[] }>("kms", "list-aliases");
    if (left?.Aliases.some((a) => a.AliasName === `alias/${alias}`)) await aws("kms", "delete-alias", "--alias-name", `alias/${alias}`);
  }
});
