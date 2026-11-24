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

/** Removes everything the console's delete would, in case the test stopped half-way. */
async function cleanupUser(name: string) {
  const users = await aws<{ Users: { UserName: string }[] }>("iam", "list-users");
  if (!users?.Users.some((u) => u.UserName === name)) return;
  const keys = await aws<{ AccessKeyMetadata: { AccessKeyId: string }[] }>("iam", "list-access-keys", "--user-name", name);
  for (const k of keys?.AccessKeyMetadata ?? []) await aws("iam", "delete-access-key", "--user-name", name, "--access-key-id", k.AccessKeyId);
  const att = await aws<{ AttachedPolicies: { PolicyArn: string }[] }>("iam", "list-attached-user-policies", "--user-name", name);
  for (const p of att?.AttachedPolicies ?? []) await aws("iam", "detach-user-policy", "--user-name", name, "--policy-arn", p.PolicyArn);
  await aws("iam", "delete-user", "--user-name", name);
}

async function cleanupRole(name: string) {
  const roles = await aws<{ Roles: { RoleName: string }[] }>("iam", "list-roles");
  if (!roles?.Roles.some((r) => r.RoleName === name)) return;
  const profiles = await aws<{ InstanceProfiles: { InstanceProfileName: string }[] }>("iam", "list-instance-profiles-for-role", "--role-name", name);
  for (const p of profiles?.InstanceProfiles ?? []) {
    await aws("iam", "remove-role-from-instance-profile", "--instance-profile-name", p.InstanceProfileName, "--role-name", name);
    await aws("iam", "delete-instance-profile", "--instance-profile-name", p.InstanceProfileName);
  }
  const att = await aws<{ AttachedPolicies: { PolicyArn: string }[] }>("iam", "list-attached-role-policies", "--role-name", name);
  for (const p of att?.AttachedPolicies ?? []) await aws("iam", "detach-role-policy", "--role-name", name, "--policy-arn", p.PolicyArn);
  await aws("iam", "delete-role", "--role-name", name);
}

test("IAM: create a user with a policy, simulate, create an access key, delete the user", async ({ page }) => {
  const name = uniqueName("e2e-iam-user");
  try {
    await page.goto("/iam/users");
    await expect(page.getByRole("heading", { name: /^Users/ })).toBeVisible();
    await page.getByRole("link", { name: "Create user" }).first().click();
    await page.getByLabel("User name", { exact: true }).fill(name);
    await page.getByRole("radio", { name: /Attach policies directly/ }).check();
    await page.locator("#field-policies").selectOption({ label: "ReadOnlyAccess (AWS managed)" });
    await page.getByRole("button", { name: "Create user" }).click();

    await expect(page).toHaveURL(new RegExp(`/iam/users/${name}`));
    await expect(page.getByTestId("flash")).toContainText(`Created user ${name}`);
    await expect(page.getByTestId("kv-User name")).toHaveText(name);
    await expect(page.getByRole("cell", { name: "ReadOnlyAccess", exact: true })).toBeVisible();

    const attached = await aws<{ AttachedPolicies: { PolicyName: string }[] }>("iam", "list-attached-user-policies", "--user-name", name);
    expect(attached?.AttachedPolicies.map((p) => p.PolicyName)).toContain("ReadOnlyAccess");

    await runAction(page, "Create access key");
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("Access key created");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    const keys = await aws<{ AccessKeyMetadata: unknown[] }>("iam", "list-access-keys", "--user-name", name);
    expect(keys?.AccessKeyMetadata).toHaveLength(1);

    // The policy simulator evaluates the user's policies in the emulator.
    await page.goto("/iam/policy-simulator");
    await page.locator("#sim-principal").selectOption({ label: `${name} (User)` });
    await page.locator("#sim-actions").fill("s3:GetObject, iam:CreateUser");
    await page.getByTestId("simulate").click();
    const results = page.getByTestId("simulation-results");
    await expect(results.getByRole("row", { name: /s3:GetObject/ })).toContainText("Allowed");
    await expect(results.getByRole("row", { name: /iam:CreateUser/ })).toContainText("Denied");

    await page.goto("/iam/users");
    await page.getByLabel("Find users").fill(name);
    const row = page.getByTestId("resource-table").getByRole("row", { name: new RegExp(name) });
    await expect(row).toBeVisible();
    await row.getByRole("radio").check();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill(name);
    await page.getByTestId("confirm-delete").click();
    await expect(page.getByTestId("flash")).toContainText(`Deleted user ${name}`);
    const after = await aws<{ Users: { UserName: string }[] }>("iam", "list-users");
    expect(after?.Users.some((u) => u.UserName === name)).toBe(false);
  } finally {
    await cleanupUser(name);
  }
});

test("IAM: create an EC2 role, edit its trust policy, delete it", async ({ page }) => {
  const name = uniqueName("e2e-iam-role");
  try {
    await page.goto("/iam/roles/create");
    await page.locator("#field-service").selectOption({ label: "EC2" });
    await page.getByLabel("Role name", { exact: true }).fill(name);
    await page.getByRole("button", { name: "Create role" }).click();
    await expect(page).toHaveURL(new RegExp(`/iam/roles/${name}`));
    await expect(page.getByTestId("kv-Role name")).toHaveText(name);

    const role = await aws<{ Role: { AssumeRolePolicyDocument: unknown } }>("iam", "get-role", "--role-name", name);
    expect(JSON.stringify(role?.Role.AssumeRolePolicyDocument)).toContain("ec2.amazonaws.com");
    const profiles = await aws<{ InstanceProfiles: unknown[] }>("iam", "list-instance-profiles-for-role", "--role-name", name);
    expect(profiles?.InstanceProfiles).toHaveLength(1);

    await page.getByRole("tab", { name: "Trust relationships", exact: true }).click();
    await page.getByTestId("json-edit").click();
    const editor = page.getByLabel("Trusted entities JSON");
    await editor.fill("{ not json");
    await expect(page.getByTestId("json-check")).toContainText("Invalid JSON");
    await editor.fill(JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] }, null, 2));
    await page.getByTestId("json-save").click();
    await expect(page.getByTestId("flash").filter({ hasText: "Trust policy updated" })).toBeVisible();
    const updated = await aws<{ Role: { AssumeRolePolicyDocument: unknown } }>("iam", "get-role", "--role-name", name);
    expect(JSON.stringify(updated?.Role.AssumeRolePolicyDocument)).toContain("lambda.amazonaws.com");

    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill(name);
    await page.getByTestId("confirm-delete").click();
    await expect(page).toHaveURL(/\/iam\/roles\?deleted=/);
    const roles = await aws<{ Roles: { RoleName: string }[] }>("iam", "list-roles");
    expect(roles?.Roles.some((r) => r.RoleName === name)).toBe(false);
  } finally {
    await cleanupRole(name);
  }
});

test("IAM: create a customer managed policy, save a new version in the editor, delete it", async ({ page }) => {
  const name = uniqueName("e2e-iam-policy");
  const arn = `arn:aws:iam::000000000000:policy/${name}`;
  const doc = (action: string) => JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: action, Resource: "*" }] }, null, 2);
  try {
    await page.goto("/iam/policies/create");
    await page.getByLabel("Policy editor").fill(doc("s3:ListBucket"));
    await page.getByLabel("Policy name").fill(name);
    await page.getByRole("button", { name: "Create policy" }).click();
    await expect(page.getByTestId("kv-Policy name")).toHaveText(name);
    await expect(page.getByTestId("kv-Type")).toHaveText("Customer managed");

    await page.getByTestId("json-edit").click();
    await page.getByLabel(/Policy document \(v1\) JSON/).fill(doc("s3:GetObject"));
    await page.getByTestId("json-save").click();
    await expect(page.getByTestId("flash").filter({ hasText: "Saved as version v2" })).toBeVisible();
    const v = await aws<{ Policy: { DefaultVersionId: string } }>("iam", "get-policy", "--policy-arn", arn);
    expect(v?.Policy.DefaultVersionId).toBe("v2");

    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill("delete");
    await page.getByTestId("confirm-delete").click();
    await expect(page).toHaveURL(/\/iam\/policies\?deleted=/);
    const list = await aws<{ Policies: { Arn: string }[] }>("iam", "list-policies", "--scope", "Local");
    expect(list?.Policies.some((p) => p.Arn === arn)).toBe(false);
  } finally {
    const list = await aws<{ Policies: { Arn: string }[] }>("iam", "list-policies", "--scope", "Local");
    if (list?.Policies.some((p) => p.Arn === arn)) {
      const versions = await aws<{ Versions: { VersionId: string; IsDefaultVersion: boolean }[] }>("iam", "list-policy-versions", "--policy-arn", arn);
      for (const x of versions?.Versions ?? []) if (!x.IsDefaultVersion) await aws("iam", "delete-policy-version", "--policy-arn", arn, "--version-id", x.VersionId);
      await aws("iam", "delete-policy", "--policy-arn", arn);
    }
  }
});

test("IAM: Edit password policy shows the current policy and saving it unchanged changes nothing", async ({ page }) => {
  // Account-wide setting: remember the policy that was there and put it back afterwards.
  const before = await aws<{ PasswordPolicy: Record<string, unknown> }>("iam", "get-account-password-policy").catch(() => null);
  try {
    await aws("iam", "update-account-password-policy", "--minimum-password-length", "13", "--require-numbers", "--max-password-age", "45", "--password-reuse-prevention", "4", "--no-allow-users-to-change-password");
    await page.goto("/iam/account-settings/Password%20policy");
    await runAction(page, "Edit password policy");
    await expect(page.getByTestId("field-MinimumPasswordLength")).toHaveValue("13");
    await expect(page.getByTestId("field-RequireNumbers")).toBeChecked();
    await expect(page.getByTestId("field-RequireSymbols")).not.toBeChecked();
    await expect(page.getByTestId("field-AllowUsersToChangePassword")).not.toBeChecked();
    await expect(page.getByTestId("field-ExpirePasswords")).toBeChecked();
    await expect(page.getByTestId("field-MaxPasswordAge")).toHaveValue("45");
    await expect(page.getByTestId("field-PasswordReusePrevention")).toHaveValue("4");
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("Password policy updated");
    const p = await aws<{ PasswordPolicy: Record<string, unknown> }>("iam", "get-account-password-policy");
    expect(p?.PasswordPolicy).toMatchObject({ MinimumPasswordLength: 13, RequireNumbers: true, RequireSymbols: false, AllowUsersToChangePassword: false, MaxPasswordAge: 45, PasswordReusePrevention: 4 });
  } finally {
    await restorePasswordPolicy(before?.PasswordPolicy ?? null);
  }
});

async function restorePasswordPolicy(p: Record<string, unknown> | null) {
  if (!p) {
    await aws("iam", "delete-account-password-policy").catch(() => null);
    return;
  }
  const flag = (k: string, name: string) => (p[k] === true ? [`--${name}`] : [`--no-${name}`]);
  await aws(
    "iam", "update-account-password-policy",
    "--minimum-password-length", String(p.MinimumPasswordLength ?? 8),
    ...flag("RequireSymbols", "require-symbols"), ...flag("RequireNumbers", "require-numbers"),
    ...flag("RequireUppercaseCharacters", "require-uppercase-characters"), ...flag("RequireLowercaseCharacters", "require-lowercase-characters"),
    ...flag("AllowUsersToChangePassword", "allow-users-to-change-password"), ...flag("HardExpiry", "hard-expiry"),
    ...(p.MaxPasswordAge ? ["--max-password-age", String(p.MaxPasswordAge)] : []),
    ...(p.PasswordReusePrevention ? ["--password-reuse-prevention", String(p.PasswordReusePrevention)] : []),
  );
}

test("IAM: Edit role and Manage tags show current values; saving unchanged keeps them", async ({ page }) => {
  const name = uniqueName("fix-iam-role");
  const trust = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] });
  try {
    await aws("iam", "create-role", "--role-name", name, "--assume-role-policy-document", trust, "--description", "keep me", "--max-session-duration", "7200", "--tags", "Key=env,Value=prod", "Key=team,Value=a");
    await page.goto(`/iam/roles/${name}`);
    await expect(page.getByTestId("kv-Description")).toHaveText("keep me");

    await runAction(page, "Edit description and session duration");
    await expect(page.getByTestId("field-description")).toHaveValue("keep me");
    await expect(page.getByTestId("field-maxSession")).toHaveValue("2");
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText(`No changes to role ${name}`);
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    let role = await aws<{ Role: { Description?: string; MaxSessionDuration: number } }>("iam", "get-role", "--role-name", name);
    expect(role?.Role).toMatchObject({ Description: "keep me", MaxSessionDuration: 7200 });

    // Changing only the session keeps the description.
    await runAction(page, "Edit description and session duration");
    await expect(page.getByTestId("field-maxSession")).toHaveValue("2");
    await page.getByTestId("field-maxSession").fill("3");
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText(`Updated role ${name}`);
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    role = await aws<{ Role: { Description?: string; MaxSessionDuration: number } }>("iam", "get-role", "--role-name", name);
    expect(role?.Role).toMatchObject({ Description: "keep me", MaxSessionDuration: 10800 });

    await runAction(page, "Manage tags");
    const dialog = page.getByRole("dialog");
    await expect(dialog.locator('input[value="prod"]')).toBeVisible();
    await expect(dialog.locator('input[value="team"]')).toBeVisible();
    await page.getByTestId("action-submit").click();
    await expect(dialog.getByTestId("flash")).toContainText("No tag changes");
    const tags = await aws<{ Tags: { Key: string; Value: string }[] }>("iam", "list-role-tags", "--role-name", name);
    expect(tags?.Tags.map((t) => `${t.Key}=${t.Value}`).sort()).toEqual(["env=prod", "team=a"]);
  } finally {
    await cleanupRole(name);
  }
});

test("IAM: Access Analyzer analyzer and credential report", async ({ page }) => {
  const name = uniqueName("fix-iam-analyzer");
  try {
    await page.goto("/iam/access-analyzer/create");
    await page.getByRole("radio", { name: /Unused access analysis - current account/ }).check();
    await page.getByTestId("field-name").fill(name);
    await page.getByTestId("field-unusedAccessAge").fill("60");
    await page.getByRole("button", { name: "Create analyzer" }).click();
    await expect(page.getByTestId("kv-Analyzer name")).toHaveText(name);
    await expect(page.getByTestId("kv-Tracking period (days)")).toHaveText("60");
    const a = await aws<{ analyzer: { type: string } }>("accessanalyzer", "get-analyzer", "--analyzer-name", name);
    expect(a?.analyzer.type).toBe("ACCOUNT_UNUSED_ACCESS");

    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill(name);
    await page.getByTestId("confirm-delete").click();
    await expect(page).toHaveURL(/\/iam\/access-analyzer\?deleted=/);
    const list = await aws<{ analyzers: { name: string }[] }>("accessanalyzer", "list-analyzers");
    expect(list?.analyzers.some((x) => x.name === name)).toBe(false);

    await page.goto("/iam/credential-report");
    await expect(async () => {
      await page.getByTestId("page-action-generate").click();
      await expect(page.getByRole("dialog")).toBeVisible({ timeout: 1000 });
    }).toPass();
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("Credential report generated");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    await expect(page.getByTestId("resource-table").getByRole("cell", { name: "<root_account>", exact: true })).toBeVisible();
  } finally {
    await aws("accessanalyzer", "delete-analyzer", "--analyzer-name", name).catch(() => null);
  }
});

test("IAM: edit and reset the account password policy", async ({ page }) => {
  const before = await aws<{ PasswordPolicy: Record<string, unknown> }>("iam", "get-account-password-policy").catch(() => null);
  try {
    await page.goto("/iam/account-settings");
    await page.getByRole("link", { name: "Password policy" }).click();
    await expect(page.getByTestId("kv-Setting")).toHaveText("Password policy");
    // The menu only opens once the page has hydrated; retry the click until it does.
    await expect(async () => {
      await page.getByRole("button", { name: "Actions" }).click();
      await expect(page.getByRole("menuitem", { name: "Edit password policy" })).toBeVisible({ timeout: 1000 });
    }).toPass();
    await page.getByRole("menuitem", { name: "Edit password policy" }).click();
    await page.getByLabel("Password minimum length").fill("14");
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("Password policy updated");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    const p = await aws<{ PasswordPolicy: { MinimumPasswordLength: number } }>("iam", "get-account-password-policy");
    expect(p?.PasswordPolicy.MinimumPasswordLength).toBe(14);
    await expect(page.getByTestId("kv-Status")).toHaveText("Custom password policy");
  } finally {
    await restorePasswordPolicy(before?.PasswordPolicy ?? null);
  }
});
