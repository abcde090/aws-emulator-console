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

interface Shares {
  resourceShares: { name: string; resourceShareArn: string; status: string }[];
}

test("RAM: create a resource share with a subnet and an account, add a principal, delete it", async ({ page }) => {
  const name = uniqueName("e2e-ram");
  const subnets = await aws<{ Subnets: { SubnetArn: string }[] }>("ec2", "describe-subnets");
  const subnetArn = subnets?.Subnets[0]?.SubnetArn;
  try {
    await page.goto("/ram/resource-shares");
    await expect(page.getByRole("heading", { name: /^Shared by me: Resource shares/ })).toBeVisible();
    await page.getByRole("link", { name: "Create resource share" }).first().click();
    await page.getByLabel("Name", { exact: true }).fill(name);
    if (subnetArn) await page.locator("#field-resources").selectOption(subnetArn);
    await page.getByLabel("Principals - optional").fill("111122223333");
    await page.getByRole("button", { name: "Create resource share" }).click();

    await expect(page.getByTestId("kv-Name")).toHaveText(name);
    await expect(page.getByTestId("kv-Status")).toHaveText("ACTIVE");
    const shares = await aws<Shares>("ram", "get-resource-shares", "--resource-owner", "SELF", "--name", name);
    const arn = shares?.resourceShares[0]?.resourceShareArn ?? "";
    expect(arn).toContain(":resource-share/");

    await page.getByRole("tab", { name: "Shared principals" }).click();
    await expect(page.getByRole("cell", { name: "111122223333" })).toBeVisible();
    if (subnetArn) {
      await page.getByRole("tab", { name: "Shared resources" }).click();
      await expect(page.getByRole("cell", { name: subnetArn })).toBeVisible();
    }

    await runAction(page, "Add principals");
    await page.locator("#field-principals").fill("444455556666");
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("Added 1 principal");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    const assoc = await aws<{ resourceShareAssociations: { associatedEntity: string }[] }>("ram", "get-resource-share-associations", "--association-type", "PRINCIPAL", "--resource-share-arns", arn);
    expect(assoc?.resourceShareAssociations.map((a) => a.associatedEntity)).toContain("444455556666");

    await page.goto("/ram/resource-shares");
    await page.getByLabel("Find shared by me: resource shares").fill(name);
    const row = page.getByTestId("resource-table").getByRole("row", { name: new RegExp(name) });
    await row.getByRole("radio").check();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill("delete");
    await page.getByTestId("confirm-delete").click();
    await expect(page.getByTestId("flash")).toContainText("Deleted resource share");
    const after = await aws<Shares>("ram", "get-resource-shares", "--resource-owner", "SELF", "--name", name);
    expect(after?.resourceShares.every((s) => s.status === "DELETED")).toBe(true);
  } finally {
    const left = await aws<Shares>("ram", "get-resource-shares", "--resource-owner", "SELF", "--name", name);
    for (const s of left?.resourceShares ?? []) if (s.status !== "DELETED") await aws("ram", "delete-resource-share", "--resource-share-arn", s.resourceShareArn);
  }
});

test("RAM: Edit name and external sharing and Manage tags show the share's current values", async ({ page }) => {
  const name = uniqueName("fix-ram-share");
  let arn = "";
  try {
    arn = (await aws<{ resourceShare: { resourceShareArn: string } }>("ram", "create-resource-share", "--name", name, "--no-allow-external-principals", "--tags", "key=env,value=prod"))?.resourceShare.resourceShareArn ?? "";
    const id = arn.replace(/^.*:resource-share\//, "");
    await page.goto(`/ram/resource-shares/${id}`);
    await expect(page.getByTestId("kv-Name")).toHaveText(name);

    await runAction(page, "Edit name and external sharing");
    let dialog = page.getByRole("dialog");
    await expect(dialog.getByTestId("field-name")).toHaveValue(name);
    await expect(dialog.getByTestId("field-allowExternal")).not.toBeChecked();
    await dialog.getByTestId("action-submit").click();
    await expect(dialog.getByTestId("flash")).toContainText("Nothing changed");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();

    await runAction(page, "Manage tags");
    dialog = page.getByRole("dialog");
    await expect(dialog.getByTestId("field-tags").locator("input").first()).toHaveValue("env");
    await dialog.getByTestId("action-submit").click();
    await expect(dialog.getByTestId("flash")).toContainText("No tag changes");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();

    const after = await aws<{ resourceShares: { allowExternalPrincipals: boolean; tags?: { key: string; value: string }[] }[] }>("ram", "get-resource-shares", "--resource-owner", "SELF", "--resource-share-arns", arn);
    expect(after?.resourceShares[0]?.allowExternalPrincipals).toBe(false);
    expect(after?.resourceShares[0]?.tags).toEqual([{ key: "env", value: "prod" }]);
  } finally {
    if (arn) await aws("ram", "delete-resource-share", "--resource-share-arn", arn);
  }
});
