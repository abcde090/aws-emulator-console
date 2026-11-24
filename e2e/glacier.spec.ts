import { expect, test, type Page } from "@playwright/test";
import { aws, uniqueName } from "./aws-cli";

async function runAction(page: Page, label: string, fill?: () => Promise<void>): Promise<void> {
  await page.getByRole("button", { name: "Actions" }).click();
  await page.getByRole("menuitem", { name: label, exact: true }).click();
  if (fill) await fill();
  await page.getByTestId("action-submit").click();
}

const made = { vault: "", archiveId: "" };

test.afterEach(async () => {
  if (made.vault && made.archiveId) await aws("glacier", "delete-archive", "--account-id", "-", "--vault-name", made.vault, "--archive-id", made.archiveId).catch(() => null);
  if (made.vault) await aws("glacier", "delete-vault", "--account-id", "-", "--vault-name", made.vault).catch(() => null);
  made.vault = "";
  made.archiveId = "";
});

test("Glacier: create a vault, upload an archive, start an inventory job, delete the vault", async ({ page }) => {
  const name = uniqueName("e2e-glacier");
  made.vault = name;

  await page.goto("/glacier/vaults");
  await expect(page.getByRole("heading", { name: /^Vaults/ })).toBeVisible();
  await page.getByRole("link", { name: "Create vault" }).first().click();
  await page.getByLabel("Vault name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Create vault" }).click();

  await expect(page).toHaveURL(new RegExp(`/glacier/vaults/${name}`));
  await expect(page.getByTestId("flash")).toContainText(`Created vault ${name}`);
  await expect(page.getByTestId("kv-Vault name")).toHaveText(name);

  const listed = await aws<{ VaultList: { VaultName: string }[] }>("glacier", "list-vaults", "--account-id", "-");
  expect(listed?.VaultList.some((v) => v.VaultName === name)).toBe(true);

  await runAction(page, "Upload archive", async () => {
    await page.getByLabel("Archive content (text)").fill("hello glacier");
  });
  const uploaded = page.getByRole("dialog").getByTestId("flash");
  await expect(uploaded).toContainText("Archive uploaded");
  made.archiveId = /Archive ID: ([0-9a-f]+)/.exec((await uploaded.textContent()) ?? "")?.[1] ?? "";
  expect(made.archiveId).not.toBe("");
  await page.getByRole("button", { name: "Close", exact: true }).last().click();

  await runAction(page, "Initiate inventory retrieval");
  await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("Inventory retrieval job started");
  await page.getByRole("button", { name: "Close", exact: true }).last().click();
  await page.getByRole("tab", { name: "Jobs" }).click();
  await expect(page.getByText("InventoryRetrieval")).toBeVisible();

  // A vault with archives can't be deleted: delete the archive first.
  await runAction(page, "Delete archive", async () => {
    await page.getByLabel("Archive ID").fill(made.archiveId);
  });
  await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("Archive deleted");
  await page.getByRole("button", { name: "Close", exact: true }).last().click();
  made.archiveId = "";

  await page.goto("/glacier/vaults");
  const row = page.getByTestId("resource-table").getByRole("row", { name: new RegExp(name) });
  await expect(row).toBeVisible();
  await row.getByRole("radio").check();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByLabel("Confirm deletion").fill(name);
  await page.getByTestId("confirm-delete").click();
  await expect(page.getByTestId("flash")).toContainText(`Deleted vault ${name}`);

  const after = await aws<{ VaultList: { VaultName: string }[] }>("glacier", "list-vaults", "--account-id", "-");
  expect(after?.VaultList.some((v) => v.VaultName === name)).toBe(false);
  made.vault = "";
});
