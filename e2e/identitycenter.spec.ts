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

async function storeId(): Promise<string> {
  const r = await aws<{ Instances: { IdentityStoreId: string }[] }>("sso-admin", "list-instances");
  return r?.Instances[0]?.IdentityStoreId ?? "";
}

test("IAM Identity Center: add a user and a group, add the user to the group, delete both", async ({ page }) => {
  const username = uniqueName("e2e-identitycenter-user");
  const group = uniqueName("e2e-identitycenter-group");
  const store = await storeId();
  test.skip(!store, "IAM Identity Center has no instance in the emulator.");
  try {
    await page.goto("/identitycenter/groups/create");
    await page.getByLabel("Group name").fill(group);
    await page.getByRole("button", { name: "Create group" }).click();
    await expect(page.getByTestId("kv-Group name")).toHaveText(group);

    await page.goto("/identitycenter/users");
    await expect(page.getByRole("heading", { name: /^Users/ })).toBeVisible();
    await page.getByRole("link", { name: "Add user" }).first().click();
    await page.getByLabel("Username").fill(username);
    await page.getByLabel("Email address").fill(`${username}@example.com`);
    await page.getByLabel("First name").fill("E2E");
    await page.getByLabel("Last name").fill("User");
    await page.getByLabel("Display name").fill("E2E User");
    await page.getByRole("button", { name: "Add user" }).click();
    await expect(page.getByTestId("kv-Username")).toHaveText(username);

    const users = await aws<{ Users: { UserName: string; UserId: string }[] }>("identitystore", "list-users", "--identity-store-id", store);
    const user = users?.Users.find((u) => u.UserName === username);
    expect(user).toBeTruthy();

    await runAction(page, "Add user to groups");
    await page.locator("#field-groups").selectOption({ label: group });
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("Added the user to 1 group");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    await page.getByRole("tab", { name: "Groups" }).click();
    await expect(page.getByRole("cell", { name: group })).toBeVisible();
    const memberships = await aws<{ GroupMemberships: unknown[] }>("identitystore", "list-group-memberships-for-member", "--identity-store-id", store, "--member-id", `UserId=${user?.UserId}`);
    expect(memberships?.GroupMemberships).toHaveLength(1);

    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill("delete");
    await page.getByTestId("confirm-delete").click();
    await expect(page).toHaveURL(/\/identitycenter\/users\?deleted=/);

    await page.goto("/identitycenter/groups");
    const row = page.getByTestId("resource-table").getByRole("row", { name: new RegExp(group) });
    await row.getByRole("radio").check();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill("delete");
    await page.getByTestId("confirm-delete").click();
    await expect(page.getByTestId("flash")).toContainText("Deleted group");

    const afterUsers = await aws<{ Users: { UserName: string }[] }>("identitystore", "list-users", "--identity-store-id", store);
    expect(afterUsers?.Users.some((u) => u.UserName === username)).toBe(false);
    const afterGroups = await aws<{ Groups: { DisplayName: string }[] }>("identitystore", "list-groups", "--identity-store-id", store);
    expect(afterGroups?.Groups.some((g) => g.DisplayName === group)).toBe(false);
  } finally {
    if (store) {
      const u = await aws<{ Users: { UserName: string; UserId: string }[] }>("identitystore", "list-users", "--identity-store-id", store);
      for (const x of u?.Users ?? []) if (x.UserName === username) await aws("identitystore", "delete-user", "--identity-store-id", store, "--user-id", x.UserId);
      const g = await aws<{ Groups: { DisplayName: string; GroupId: string }[] }>("identitystore", "list-groups", "--identity-store-id", store);
      for (const x of g?.Groups ?? []) if (x.DisplayName === group) await aws("identitystore", "delete-group", "--identity-store-id", store, "--group-id", x.GroupId);
    }
  }
});

test("IAM Identity Center: Edit profile and Edit description show the current values and change nothing when saved", async ({ page }) => {
  const username = uniqueName("fix-identitycenter-user");
  const groupName = uniqueName("fix-identitycenter-group");
  const store = await storeId();
  test.skip(!store, "IAM Identity Center has no instance in the emulator.");
  let userId = "";
  let groupId = "";
  try {
    userId = (await aws<{ UserId: string }>(
      "identitystore", "create-user", "--identity-store-id", store, "--user-name", username, "--display-name", "Keep Me",
      "--name", "GivenName=Keep,FamilyName=Me", "--emails", `Value=${username}@example.com,Type=work,Primary=true`, "--title", "Architect",
    ))?.UserId ?? "";
    groupId = (await aws<{ GroupId: string }>("identitystore", "create-group", "--identity-store-id", store, "--display-name", groupName, "--description", "keep me"))?.GroupId ?? "";

    await page.goto(`/identitycenter/users/${userId}`);
    await expect(page.getByTestId("kv-Username")).toHaveText(username);
    await runAction(page, "Edit profile");
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByTestId("field-displayName")).toHaveValue("Keep Me");
    await expect(dialog.getByTestId("field-email")).toHaveValue(`${username}@example.com`);
    await expect(dialog.getByTestId("field-title")).toHaveValue("Architect");
    await dialog.getByTestId("action-submit").click();
    await expect(dialog.getByTestId("flash")).toContainText("Nothing changed");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    const u = await aws<{ DisplayName: string; Title: string }>("identitystore", "describe-user", "--identity-store-id", store, "--user-id", userId);
    expect(u?.DisplayName).toBe("Keep Me");
    expect(u?.Title).toBe("Architect");

    await page.goto(`/identitycenter/groups/${groupId}`);
    await expect(page.getByTestId("kv-Group name")).toHaveText(groupName);
    await runAction(page, "Edit description");
    await expect(page.getByRole("dialog").getByTestId("field-description")).toHaveValue("keep me");
  } finally {
    if (userId) await aws("identitystore", "delete-user", "--identity-store-id", store, "--user-id", userId);
    if (groupId) await aws("identitystore", "delete-group", "--identity-store-id", store, "--group-id", groupId);
  }
});
