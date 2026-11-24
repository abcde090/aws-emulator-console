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

test("Cognito: create a user pool with an app client, create and disable a user, delete the pool", async ({ page }) => {
  const name = uniqueName("e2e-cognito");
  const email = `${name}@example.com`;
  let poolId = "";
  try {
    await page.goto("/cognito/user-pools");
    await expect(page.getByRole("heading", { name: /^User pools/ })).toBeVisible();
    await page.getByRole("link", { name: "Create user pool" }).first().click();
    await page.getByLabel("User pool name").fill(name);
    await page.getByLabel("App client name").fill(`${name}-app`);
    await page.getByRole("button", { name: "Create user pool" }).click();

    await expect(page.getByTestId("kv-User pool name")).toHaveText(name);
    poolId = (await page.getByTestId("kv-User pool ID").textContent()) ?? "";
    expect(poolId).toMatch(/^us-east-1_/);
    const clients = await aws<{ UserPoolClients: { ClientName: string }[] }>("cognito-idp", "list-user-pool-clients", "--user-pool-id", poolId);
    expect(clients?.UserPoolClients.map((c) => c.ClientName)).toContain(`${name}-app`);
    const pools = await aws<{ UserPools: { Id: string }[] }>("cognito-idp", "list-user-pools", "--max-results", "60");
    expect(pools?.UserPools.some((p) => p.Id === poolId)).toBe(true);

    await runAction(page, "Create user");
    await page.getByLabel("User name").fill(email);
    await page.getByLabel("Email address - optional").fill(email);
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("Created user");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    await expect(page.getByRole("cell", { name: email }).first()).toBeVisible();

    await runAction(page, "Disable user access");
    await page.getByTestId("action-submit").click();
    const table = page.getByTestId("result-table");
    await table.getByRole("checkbox").first().check();
    await page.getByRole("button", { name: /^Disable user access \(1\)/ }).click();
    await expect(page.getByRole("dialog")).toContainText("Disabled 1 user");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    const users = await aws<{ Users: { Enabled: boolean }[] }>("cognito-idp", "list-users", "--user-pool-id", poolId);
    expect(users?.Users[0]?.Enabled).toBe(false);

    await page.getByRole("button", { name: "Delete", exact: true }).click();
    // confirmText "name": the dialog asks for the pool's name, not its id.
    await page.getByLabel("Confirm deletion").fill(name);
    await page.getByTestId("confirm-delete").click();
    await expect(page).toHaveURL(/\/cognito\/user-pools\?deleted=/);
    const after = await aws<{ UserPools: { Id: string }[] }>("cognito-idp", "list-user-pools", "--max-results", "60");
    expect(after?.UserPools.some((p) => p.Id === poolId)).toBe(false);
  } finally {
    const left = await aws<{ UserPools: { Id: string; Name: string }[] }>("cognito-idp", "list-user-pools", "--max-results", "60");
    for (const p of left?.UserPools ?? []) if (p.Name === name) await aws("cognito-idp", "delete-user-pool", "--user-pool-id", p.Id);
  }
});

interface PoolDesc {
  UserPool: {
    DeletionProtection?: string;
    MfaConfiguration?: string;
    AutoVerifiedAttributes?: string[];
    AdminCreateUserConfig?: { AllowAdminCreateUserOnly?: boolean };
    Policies?: { PasswordPolicy?: { MinimumLength?: number; RequireSymbols?: boolean; TemporaryPasswordValidityDays?: number } };
  };
}

async function openAction(page: Page, label: string) {
  await runAction(page, label);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByTestId("action-submit")).toBeEnabled();
  return dialog;
}

test("Cognito: edit dialogs show the pool's settings and deletion protection keeps the rest of the pool (IDS-1)", async ({ page }) => {
  const name = uniqueName("fix-cognito-pool");
  let poolId = "";
  try {
    const created = await aws<{ UserPool: { Id: string } }>(
      "cognito-idp", "create-user-pool", "--pool-name", name,
      "--policies", "PasswordPolicy={MinimumLength=12,RequireUppercase=true,RequireLowercase=true,RequireNumbers=true,RequireSymbols=false,TemporaryPasswordValidityDays=3}",
      "--admin-create-user-config", "AllowAdminCreateUserOnly=true",
      "--auto-verified-attributes", "email",
    );
    poolId = created?.UserPool.Id ?? "";
    expect(poolId).not.toBe("");
    await aws("cognito-idp", "set-user-pool-mfa-config", "--user-pool-id", poolId, "--mfa-configuration", "OPTIONAL", "--software-token-mfa-configuration", "Enabled=true");
    const before = await aws<PoolDesc>("cognito-idp", "describe-user-pool", "--user-pool-id", poolId);

    await page.goto(`/cognito/user-pools/${poolId}`);
    await expect(page.getByTestId("kv-User pool ID")).toHaveText(poolId);

    // Deletion protection: shows the current (inactive) value; turning it on changes nothing else.
    let dialog = await openAction(page, "Edit deletion protection");
    await expect(dialog.getByTestId("field-on")).not.toBeChecked();
    await dialog.getByTestId("field-on").check();
    await dialog.getByTestId("action-submit").click();
    await expect(dialog.getByTestId("flash")).toContainText("Deletion protection activated");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    const after = await aws<PoolDesc>("cognito-idp", "describe-user-pool", "--user-pool-id", poolId);
    expect(after?.UserPool.DeletionProtection).toBe("ACTIVE");
    expect(after?.UserPool.Policies?.PasswordPolicy?.MinimumLength).toBe(12);
    expect(after?.UserPool.Policies?.PasswordPolicy?.TemporaryPasswordValidityDays).toBe(3);
    expect(after?.UserPool.AdminCreateUserConfig?.AllowAdminCreateUserOnly).toBe(true);
    expect(after?.UserPool.AutoVerifiedAttributes).toEqual(["email"]);
    expect(after?.UserPool.MfaConfiguration).toBe(before?.UserPool.MfaConfiguration);

    // Password policy: prefilled; saving unchanged keeps it.
    dialog = await openAction(page, "Edit password policy");
    await expect(dialog.getByTestId("field-minLength")).toHaveValue("12");
    await expect(dialog.getByTestId("field-symbols")).not.toBeChecked();
    await expect(dialog.getByTestId("field-tempDays")).toHaveValue("3");
    await dialog.getByTestId("action-submit").click();
    await expect(dialog.getByTestId("flash")).toContainText("Password policy updated");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    const again = await aws<PoolDesc>("cognito-idp", "describe-user-pool", "--user-pool-id", poolId);
    expect(again?.UserPool.Policies?.PasswordPolicy).toEqual(after?.UserPool.Policies?.PasswordPolicy);
    expect(again?.UserPool.DeletionProtection).toBe("ACTIVE");
    expect(again?.UserPool.AdminCreateUserConfig?.AllowAdminCreateUserOnly).toBe(true);

    // MFA and self-registration show the pool's values.
    dialog = await openAction(page, "Edit multi-factor authentication");
    await expect(dialog.getByTestId("field-mfa").getByRole("radio", { name: "Optional MFA" })).toBeChecked();
    await dialog.getByTestId("action-submit").click();
    await expect(dialog.getByTestId("flash")).toContainText("Nothing changed");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    dialog = await openAction(page, "Edit self-service sign-up");
    await expect(dialog.getByTestId("field-selfSignUp")).not.toBeChecked();
  } finally {
    if (poolId) {
      await aws("cognito-idp", "update-user-pool", "--user-pool-id", poolId, "--deletion-protection", "INACTIVE");
      await aws("cognito-idp", "delete-user-pool", "--user-pool-id", poolId);
    }
  }
});

test("Cognito: create an identity pool, its edit dialog shows its settings, delete it", async ({ page }) => {
  const name = uniqueName("fix_cognito_idp").replace(/-/g, "_");
  const find = async () => (await aws<{ IdentityPools: { IdentityPoolId: string; IdentityPoolName: string }[] }>("cognito-identity", "list-identity-pools", "--max-results", "60"))?.IdentityPools.find((p) => p.IdentityPoolName === name);
  try {
    await page.goto("/cognito/identity-pools");
    await expect(page.getByRole("heading", { name: /^Identity pools/ })).toBeVisible();
    await page.getByRole("link", { name: "Create identity pool" }).first().click();
    await page.getByLabel("Identity pool name").fill(name);
    await page.getByTestId("field-allowUnauth").check();
    await page.getByRole("button", { name: "Create identity pool" }).click();
    await expect(page.getByTestId("kv-Identity pool name")).toHaveText(name);
    await expect(page.getByTestId("kv-Guest access")).toHaveText("Activated");
    const pool = await find();
    expect(pool).toBeTruthy();
    const desc = await aws<{ AllowUnauthenticatedIdentities: boolean }>("cognito-identity", "describe-identity-pool", "--identity-pool-id", pool?.IdentityPoolId ?? "");
    expect(desc?.AllowUnauthenticatedIdentities).toBe(true);

    const dialog = await openAction(page, "Edit identity pool");
    await expect(dialog.getByTestId("field-name")).toHaveValue(name);
    await expect(dialog.getByTestId("field-allowUnauth")).toBeChecked();
    await dialog.getByTestId("action-submit").click();
    await expect(dialog.getByTestId("flash")).toContainText("Nothing changed");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    const same = await aws<{ AllowUnauthenticatedIdentities: boolean; IdentityPoolName: string }>("cognito-identity", "describe-identity-pool", "--identity-pool-id", pool?.IdentityPoolId ?? "");
    expect(same?.AllowUnauthenticatedIdentities).toBe(true);
    expect(same?.IdentityPoolName).toBe(name);

    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill(name);
    await page.getByTestId("confirm-delete").click();
    await expect(page).toHaveURL(/\/cognito\/identity-pools\?deleted=/);
    expect(await find()).toBeUndefined();
  } finally {
    const left = await find();
    if (left) await aws("cognito-identity", "delete-identity-pool", "--identity-pool-id", left.IdentityPoolId);
  }
});
