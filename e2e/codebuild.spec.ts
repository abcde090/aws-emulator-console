import { expect, test } from "@playwright/test";
import { aws, uniqueName } from "./aws-cli";

async function quietly(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch {
    // Already gone.
  }
}

test("CodeBuild: create a project, run a build, read its phases and logs, delete", async ({ page }) => {
  const name = uniqueName("e2e-codebuild");
  const role = `codebuild-${name}-service-role`.slice(0, 64);
  try {
    await page.goto("/codebuild/build-projects");
    await expect(page.getByRole("heading", { name: /^Build projects/ })).toBeVisible();
    await page.getByRole("link", { name: "Create build project" }).first().click();
    await page.getByLabel("Project name").fill(name);
    await page.getByLabel("Source provider").selectOption("NO_SOURCE");
    await page.getByLabel("Build commands (buildspec YAML)").fill('version: 0.2\nphases:\n  build:\n    commands:\n      - echo "e2e build says hi"\n');
    await page.getByRole("button", { name: "Create build project" }).click();

    await expect(page).toHaveURL(new RegExp(`/codebuild/build-projects/${name}`));
    await expect(page.getByTestId("flash")).toContainText(`Created build project ${name}`);
    await expect(page.getByTestId("kv-source")).toHaveText("No source");
    const projects = await aws<{ projects: { name: string; serviceRole: string }[] }>("codebuild", "batch-get-projects", "--names", name);
    expect(projects?.projects[0]?.name).toBe(name);
    expect(projects?.projects[0]?.serviceRole).toContain(role);

    // Start a build.
    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Start build" }).click();
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("Started build");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();

    // Build history (first tab) shows it; wait for it to finish.
    await expect(async () => {
      await page.reload();
      await expect(page.getByTestId("build-history")).toContainText("SUCCEEDED", { timeout: 1000 });
    }).toPass({ timeout: 45_000 });
    await page.getByTestId("build-history").getByRole("link").first().click();
    await expect(page).toHaveURL(/\/codebuild\/build-history\//);
    await expect(page.getByTestId("kv-status")).toHaveText(/SUCCEEDED/);
    await expect(page.getByText("e2e build says hi")).toBeVisible();
    await page.getByRole("tab", { name: "Phase details" }).click();
    await expect(page.getByText("POST_BUILD")).toBeVisible();
    const builds = await aws<{ ids: string[] }>("codebuild", "list-builds-for-project", "--project-name", name);
    expect(builds?.ids.length).toBe(1);

    // Delete the project from its page.
    await page.goto(`/codebuild/build-projects/${name}`);
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill("delete");
    await page.getByTestId("confirm-delete").click();
    await expect(page).toHaveURL(/\/codebuild\/build-projects\?deleted=/);
    const after = await aws<{ projectsNotFound: string[] }>("codebuild", "batch-get-projects", "--names", name);
    expect(after?.projectsNotFound).toContain(name);
  } finally {
    await quietly(async () => {
      // list-builds, not list-builds-for-project: the project may already be deleted.
      const ids = ((await aws<{ ids: string[] }>("codebuild", "list-builds"))?.ids ?? []).filter((id) => id.startsWith(`${name}:`));
      if (ids.length) await aws("codebuild", "batch-delete-builds", "--ids", ...ids);
    });
    await quietly(() => aws("codebuild", "delete-project", "--name", name));
    await quietly(() => aws("iam", "delete-role-policy", "--role-name", role, "--policy-name", `CodeBuildBasePolicy-${name}-us-east-1`));
    await quietly(() => aws("iam", "delete-role", "--role-name", role));
  }
});

test("CodeBuild: Edit dialogs show the project's current settings and saving unchanged changes nothing", async ({ page }) => {
  const name = uniqueName("fix-codebuild");
  const role = `${name}-role`.slice(0, 64);
  const trust = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "codebuild.amazonaws.com" }, Action: "sts:AssumeRole" }] });
  const buildspec = "version: 0.2\nphases:\n  build:\n    commands:\n      - echo custom\n";
  type P = { projects: { description?: string; timeoutInMinutes?: number; environment?: { image?: string; computeType?: string; environmentVariables?: { name: string; value: string }[] }; source?: { buildspec?: string }; tags?: { key: string; value: string }[] }[] };
  const read = async () => (await aws<P>("codebuild", "batch-get-projects", "--names", name))?.projects[0];
  try {
    const arn = (await aws<{ Role: { Arn: string } }>("iam", "create-role", "--role-name", role, "--assume-role-policy-document", trust))?.Role.Arn ?? "";
    await aws(
      "codebuild", "create-project", "--name", name, "--description", "keep me", "--timeout-in-minutes", "30", "--service-role", arn,
      "--source", JSON.stringify({ type: "NO_SOURCE", buildspec }),
      "--artifacts", JSON.stringify({ type: "NO_ARTIFACTS" }),
      "--environment", JSON.stringify({ type: "LINUX_CONTAINER", image: "aws/codebuild/standard:7.0", computeType: "BUILD_GENERAL1_MEDIUM", environmentVariables: [{ name: "FOO", value: "bar", type: "PLAINTEXT" }] }),
      "--tags", JSON.stringify([{ key: "team", value: "ops" }])
    );
    const before = await read();
    await page.goto(`/codebuild/build-projects/${name}`);

    const open = async (label: string) => {
      await page.getByRole("button", { name: "Actions" }).click();
      await page.getByRole("menuitem", { name: label, exact: true }).click();
    };
    const saveUnchanged = async () => {
      await page.getByTestId("action-submit").click();
      await expect(page.getByRole("dialog").getByTestId("flash")).toBeVisible();
      await page.getByRole("button", { name: "Close", exact: true }).last().click();
    };

    await open("Edit project configuration");
    await expect(page.getByTestId("field-description")).toHaveValue("keep me");
    await expect(page.getByTestId("field-timeout")).toHaveValue("30");
    await saveUnchanged();

    await open("Edit environment");
    await expect(page.getByTestId("field-image")).toHaveValue("aws/codebuild/standard:7.0");
    await expect(page.getByTestId("field-computeType")).toHaveValue("BUILD_GENERAL1_MEDIUM");
    await expect(page.getByLabel("Environment variables key 1")).toHaveValue("FOO");
    await saveUnchanged();

    await open("Edit buildspec");
    await expect(page.getByTestId("field-buildspec")).toHaveValue(buildspec);
    await saveUnchanged();

    await open("Edit tags");
    await expect(page.getByLabel("Tags key 1")).toHaveValue("team");
    await expect(page.getByLabel("Tags value 1")).toHaveValue("ops");
    await saveUnchanged();

    const after = await read();
    expect(after?.description).toBe("keep me");
    expect(after?.timeoutInMinutes).toBe(30);
    expect(after?.environment?.image).toBe(before?.environment?.image);
    expect(after?.environment?.computeType).toBe("BUILD_GENERAL1_MEDIUM");
    expect(after?.environment?.environmentVariables?.map((e) => `${e.name}=${e.value}`)).toEqual(["FOO=bar"]);
    expect(after?.source?.buildspec).toBe(buildspec);
    expect(after?.tags?.map((t) => `${t.key}=${t.value}`)).toEqual(["team=ops"]);
  } finally {
    await quietly(() => aws("codebuild", "delete-project", "--name", name));
    await quietly(() => aws("iam", "delete-role", "--role-name", role));
  }
});
