import { expect, test } from "@playwright/test";
import { aws, uniqueName } from "./aws-cli";

interface Envs {
  Environments?: { EnvironmentId?: string; EnvironmentName?: string; Status?: string }[];
}

async function liveEnvs(app: string): Promise<Envs["Environments"]> {
  const r = await aws<Envs>("elasticbeanstalk", "describe-environments", "--application-name", app, "--no-include-deleted").catch(() => null);
  return (r?.Environments ?? []).filter((e) => e.Status !== "Terminated");
}

async function waitFor(check: () => Promise<boolean>, what: string, timeoutMs = 45_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

test("Elastic Beanstalk: create an application and environment, request logs, terminate, delete", async ({ page }) => {
  test.setTimeout(150_000);
  const app = uniqueName("e2e-eb-app");
  const env = uniqueName("e2e-eb-env");
  let envId = "";
  try {
    // Application.
    await page.goto("/elasticbeanstalk/applications");
    await expect(page.getByRole("heading", { name: /^Applications/ })).toBeVisible();
    await page.getByRole("link", { name: "Create application" }).first().click();
    await page.getByLabel("Application name", { exact: true }).fill(app);
    await page.getByLabel(/^Description/).fill("created by e2e");
    await page.getByRole("button", { name: "Create application" }).click();
    await expect(page).toHaveURL(new RegExp(`/elasticbeanstalk/applications/${app}`));
    await expect(page.getByTestId("kv-name")).toHaveText(app);
    const apps = await aws<{ Applications?: { ApplicationName?: string; Description?: string }[] }>("elasticbeanstalk", "describe-applications", "--application-names", app);
    expect(apps?.Applications?.[0]?.Description).toBe("created by e2e");

    // Environment with the sample application.
    await page.goto("/elasticbeanstalk/environments/create");
    await expect(page.getByTestId("create-form")).toBeVisible();
    await page.getByLabel("Application name", { exact: true }).selectOption(app);
    await page.getByLabel("Environment name", { exact: true }).fill(env);
    await page.getByLabel(/^Min instances/).fill("1");
    await page.getByLabel(/^Max instances/).fill("2");
    await page.getByRole("button", { name: "Create environment" }).click();
    await expect(page).toHaveURL(/\/elasticbeanstalk\/environments\/e-/);
    envId = new URL(page.url()).pathname.split("/").pop() ?? "";
    await expect(page.getByTestId("kv-name")).toHaveText(env);
    const envs = await liveEnvs(app);
    expect(envs?.map((e) => e.EnvironmentName)).toContain(env);

    await waitFor(async () => (await liveEnvs(app))?.some((e) => e.EnvironmentName === env && e.Status === "Ready") === true, "environment Ready");
    await page.reload();
    await expect(page.getByTestId("kv-status")).toHaveText(/Ready/);
    await page.getByRole("tab", { name: "Configuration" }).click();
    await expect(page.getByText("MaxSize", { exact: true })).toBeVisible();

    // The environment is in the list.
    await page.goto("/elasticbeanstalk/environments");
    await expect(page.getByTestId("resource-table").getByRole("row", { name: new RegExp(env) })).toBeVisible();
    await page.getByTestId("resource-table").getByRole("link", { name: env }).click();
    await expect(page).toHaveURL(/\/elasticbeanstalk\/environments\/e-/);
    await expect(page.getByTestId("kv-name")).toHaveText(env);

    // Request logs: the action waits for the instance logs and reads them from S3.
    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Request logs" }).click();
    await page.getByTestId("action-submit").click();
    await expect(page.getByTestId("result-table")).toContainText("createEnvironment is starting", { timeout: 30_000 });
    await page.getByRole("button", { name: "Close", exact: true }).last().click();

    // Terminate the environment.
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill("delete");
    await page.getByTestId("confirm-delete").click();
    await expect(page).toHaveURL(/\/elasticbeanstalk\/environments\?deleted=/);
    await waitFor(async () => (await liveEnvs(app))?.length === 0, "environment terminated");

    // Delete the application from the list.
    await page.goto("/elasticbeanstalk/applications");
    const row = page.getByTestId("resource-table").getByRole("row", { name: new RegExp(app) });
    await row.getByRole("radio").check();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill(app);
    await page.getByTestId("confirm-delete").click();
    await expect(page.getByTestId("flash")).toContainText(`Deleted application ${app}`);
    // DeleteApplication finishes asynchronously, as in AWS.
    await waitFor(async () => ((await aws<{ Applications?: unknown[] }>("elasticbeanstalk", "describe-applications", "--application-names", app))?.Applications ?? []).length === 0, "application deleted");
  } finally {
    const left = await aws<{ Applications?: unknown[] }>("elasticbeanstalk", "describe-applications", "--application-names", app).catch(() => null);
    if (left?.Applications?.length) await aws("elasticbeanstalk", "delete-application", "--application-name", app, "--terminate-env-by-force").catch(() => null);
    // Request logs leaves the log files in Elastic Beanstalk's storage bucket; remove ours.
    if (envId) {
      for (const kind of ["tail", "bundle"]) {
        await aws("s3", "rm", `s3://elasticbeanstalk-us-east-1-000000000000/resources/environments/logs/${kind}/${envId}/`, "--recursive").catch(() => null);
      }
    }
  }
});

test("Elastic Beanstalk: application edit dialogs open with the current values; saving them unchanged changes nothing", async ({ page }) => {
  const app = uniqueName("fix-eb-app");
  const role = uniqueName("fix-eb-role");
  const trust = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "elasticbeanstalk.amazonaws.com" }, Action: "sts:AssumeRole" }] });
  const roleArn = (await aws<{ Role: { Arn: string } }>("iam", "create-role", "--role-name", role, "--assume-role-policy-document", trust))?.Role.Arn ?? "";
  type App = { Applications?: { Description?: string; ApplicationArn?: string; ResourceLifecycleConfig?: unknown }[] };
  const describe = async () => (await aws<App>("elasticbeanstalk", "describe-applications", "--application-names", app))?.Applications?.[0];
  const dialog = page.getByRole("dialog");
  const open = async (label: string) => {
    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: label, exact: true }).click();
  };
  const submitUnchanged = async (text: string) => {
    await page.getByTestId("action-submit").click();
    await expect(dialog.getByTestId("flash")).toContainText(text);
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
  };
  try {
    await aws("elasticbeanstalk", "create-application", "--application-name", app, "--description", "orig desc", "--tags", "Key=team,Value=blue");
    await aws(
      "elasticbeanstalk", "update-application-resource-lifecycle", "--application-name", app, "--resource-lifecycle-config",
      JSON.stringify({ ServiceRole: roleArn, VersionLifecycleConfig: { MaxCountRule: { Enabled: true, MaxCount: 50, DeleteSourceFromS3: true }, MaxAgeRule: { Enabled: false, MaxAgeInDays: 180, DeleteSourceFromS3: false } } })
    );
    const before = await describe();
    await page.goto(`/elasticbeanstalk/applications/${app}`);

    await open("Edit description");
    await expect(dialog.getByTestId("field-description")).toHaveValue("orig desc");
    await submitUnchanged("No changes to save");

    await open("Edit application version lifecycle settings");
    await expect(dialog.getByTestId("field-rule").locator('input[value="count"]')).toBeChecked();
    await expect(dialog.getByTestId("field-maxCount")).toHaveValue("50");
    await expect(dialog.getByTestId("field-deleteSource")).toBeChecked();
    await expect(dialog.getByTestId("field-serviceRole")).toHaveValue(roleArn);
    await page.getByTestId("action-submit").click();
    await expect(dialog.getByTestId("flash")).toContainText("No changes to save");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();

    await open("Manage tags");
    await expect(dialog.getByLabel("Tags key 1")).toHaveValue("team");
    await expect(dialog.getByLabel("Tags value 1")).toHaveValue("blue");
    await submitUnchanged("No tag changes");

    const after = await describe();
    expect(after?.Description).toBe("orig desc");
    expect(after?.ResourceLifecycleConfig).toEqual(before?.ResourceLifecycleConfig);
    const tags = await aws<{ ResourceTags?: { Key: string; Value: string }[] }>("elasticbeanstalk", "list-tags-for-resource", "--resource-arn", after?.ApplicationArn ?? "");
    expect(tags?.ResourceTags?.filter((t) => !t.Key.startsWith("elasticbeanstalk:"))).toEqual([{ Key: "team", Value: "blue" }]);
  } finally {
    await aws("elasticbeanstalk", "delete-application", "--application-name", app).catch(() => null);
    await aws("iam", "delete-role", "--role-name", role).catch(() => null);
  }
});
