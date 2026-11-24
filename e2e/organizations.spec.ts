import { expect, test, type Page } from "@playwright/test";
import { aws, uniqueName } from "./aws-cli";

interface Unit {
  Id: string;
  Name: string;
}

async function unitsUnder(parentId: string): Promise<Unit[]> {
  return (await aws<{ OrganizationalUnits?: Unit[] }>("organizations", "list-organizational-units-for-parent", "--parent-id", parentId))?.OrganizationalUnits ?? [];
}

async function chooseParent(page: Page, text: string) {
  const value = await page.locator("#field-parentId option", { hasText: text }).first().getAttribute("value");
  expect(value).toBeTruthy();
  await page.getByLabel("Parent", { exact: true }).selectOption(value as string);
  await expect(page.getByLabel("Parent", { exact: true })).toHaveValue(value as string);
}

async function deleteFromDetail(page: Page) {
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByLabel("Confirm deletion").fill("delete");
  await page.getByTestId("confirm-delete").click();
}

test("Organizations: create nested OUs, see them in the tree and CLI, delete them", async ({ page }) => {
  const parentName = uniqueName("e2e-organizations-ou");
  const childName = uniqueName("e2e-organizations-child");
  const roots = await aws<{ Roots: { Id: string }[] }>("organizations", "list-roots");
  const rootId = roots?.Roots[0]?.Id as string;
  expect(rootId).toMatch(/^r-/);

  try {
    await page.goto("/organizations/accounts");
    await expect(page.getByRole("heading", { name: /^AWS accounts/ })).toBeVisible();
    await expect(page.getByTestId("org-tree")).toContainText(rootId);

    // Create an OU under the root through the form.
    await page.getByRole("link", { name: "Create organizational unit" }).first().click();
    await expect(page.getByTestId("create-form")).toBeVisible();
    await page.waitForLoadState("networkidle");
    await chooseParent(page, `(${rootId})`);
    await page.getByLabel("Organizational unit name").fill(parentName);
    await page.getByRole("button", { name: "Create organizational unit" }).click();
    await expect(page.getByTestId("flash")).toContainText("Created organizational unit");
    await expect(page.getByTestId("kv-Name")).toHaveText(parentName);
    await expect(page.getByTestId("kv-Parent ID")).toHaveText(rootId);

    const parent = (await unitsUnder(rootId)).find((u) => u.Name === parentName);
    expect(parent).toBeTruthy();
    const parentId = (parent as Unit).Id;

    // Create a child OU inside it, then check the parent's Organizational units tab.
    await page.goto("/organizations/accounts/create");
    await expect(page.getByTestId("create-form")).toBeVisible();
    await expect(page.locator("#field-parentId option", { hasText: parentName })).toHaveCount(1);
    await page.waitForLoadState("networkidle");
    await chooseParent(page, parentName);
    await page.getByLabel("Organizational unit name").fill(childName);
    await page.getByRole("button", { name: "Create organizational unit" }).click();
    await expect(page.getByTestId("kv-Parent ID")).toHaveText(parentId);
    const child = (await unitsUnder(parentId)).find((u) => u.Name === childName);
    expect(child).toBeTruthy();

    // The tree shows both, nested.
    await page.goto("/organizations/accounts");
    const tree = page.getByTestId("org-tree");
    await expect(tree.getByRole("treeitem", { name: new RegExp(childName) })).toHaveAttribute("aria-level", "3");

    // Open the parent and see the child in its tab.
    await tree.getByRole("link", { name: parentName }).click();
    await page.getByRole("tab", { name: "Organizational units" }).click();
    await expect(page.locator("main")).toContainText(childName);

    // Deleting a non-empty OU shows the emulator's error.
    await deleteFromDetail(page);
    await expect(page.getByRole("dialog")).toContainText("OrganizationalUnitNotEmptyException");
    await page.getByRole("button", { name: "Cancel" }).click();

    // Delete the child, then the parent, through the UI.
    await page.goto(`/organizations/accounts/${(child as Unit).Id}`);
    await deleteFromDetail(page);
    await expect(page).toHaveURL(/\/organizations\/accounts\?deleted=/);
    await expect(page.getByTestId("flash")).toContainText("Deleted organizational unit");
    await page.goto(`/organizations/accounts/${parentId}`);
    await deleteFromDetail(page);
    await expect(page).toHaveURL(/\/organizations\/accounts\?deleted=/);
    await expect(page.getByTestId("org-tree")).not.toContainText(parentName);
    expect((await unitsUnder(rootId)).some((u) => u.Name === parentName)).toBe(false);
  } finally {
    for (const u of await unitsUnder(rootId)) {
      if (u.Name !== parentName) continue;
      for (const c of await unitsUnder(u.Id)) await aws("organizations", "delete-organizational-unit", "--organizational-unit-id", c.Id).catch(() => null);
      await aws("organizations", "delete-organizational-unit", "--organizational-unit-id", u.Id).catch(() => null);
    }
  }
});

test("Organizations: policies and settings show what the emulator reports", async ({ page }) => {
  const org = await aws<{ Organization: { Id: string } }>("organizations", "describe-organization");
  await page.goto("/organizations/settings");
  await page.getByRole("link", { name: org?.Organization.Id as string }).click();
  await expect(page.getByTestId("kv-Organization ID")).toHaveText(org?.Organization.Id as string);
  await page.goto("/organizations/policies");
  await expect(page.getByTestId("resource-table")).toContainText("Service control policies");
  await expect(page.locator("nav").getByText("AWS Emulator doesn't support yet")).toBeVisible();
});
