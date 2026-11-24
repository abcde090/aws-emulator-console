import { expect, test } from "@playwright/test";
import { aws, uniqueName } from "./aws-cli";

async function quietly(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch {
    // Already gone.
  }
}

interface Executions {
  pipelineExecutionSummaries: { status: string }[];
}

test("CodePipeline: create a pipeline with an approval, approve it, see the history, delete", async ({ page }) => {
  const name = uniqueName("e2e-codepipeline");
  const repo = `${name}-src`;
  const role = `AWSCodePipelineServiceRole-us-east-1-${name}`.slice(0, 64);
  const artifactBucket = "codepipeline-us-east-1-000000000000";
  const buckets = await aws<{ Buckets?: { Name?: string }[] }>("s3api", "list-buckets");
  const bucketExisted = buckets?.Buckets?.some((b) => b.Name === artifactBucket) ?? false;
  await aws("codecommit", "create-repository", "--repository-name", repo);
  try {
    await aws("codecommit", "put-file", "--repository-name", repo, "--branch-name", "main", "--file-path", "index.html", "--file-content", "aGVsbG8K", "--commit-message", "first");

    await page.goto("/codepipeline/pipelines");
    await expect(page.getByRole("heading", { name: /^Pipelines/ })).toBeVisible();
    await page.getByRole("link", { name: "Create pipeline" }).first().click();
    await page.getByLabel("Pipeline name").fill(name);
    await page.getByLabel("Repository name").selectOption(repo);
    await page.getByLabel("Branch name").fill("main");
    await page.getByText("Add a manual approval stage").click();
    await page.getByLabel("Comments for the reviewer - optional").fill("Please check the e2e change");
    await page.getByRole("button", { name: "Create pipeline" }).click();

    await expect(page).toHaveURL(new RegExp(`/codepipeline/pipelines/${name}`));
    await expect(page.getByTestId("flash").first()).toContainText(`Created pipeline ${name}`);
    const listed = await aws<{ pipelines: { name: string }[] }>("codepipeline", "list-pipelines");
    expect(listed?.pipelines.some((p) => p.name === name)).toBe(true);

    // The first execution reaches the approval stage; approve it in the diagram.
    const approval = page.getByTestId("stage-Approval");
    await expect(async () => {
      await page.reload();
      await expect(approval.getByRole("button", { name: "Review" })).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 45_000 });
    await expect(approval).toContainText("Please check the e2e change");
    await approval.getByRole("button", { name: "Review" }).click();
    await page.getByLabel("Comments").fill("Looks good");
    await page.getByTestId("submit-approval").click();
    await expect(page.getByTestId("pipeline-view").getByTestId("flash")).toContainText("ManualApproval approved");

    await expect(async () => {
      const ex = await aws<Executions>("codepipeline", "list-pipeline-executions", "--pipeline-name", name);
      expect(ex?.pipelineExecutionSummaries[0]?.status).toBe("Succeeded");
    }).toPass({ timeout: 45_000 });
    await page.reload();
    await expect(approval.getByTestId("pipeline-status").first()).toHaveText(/Succeeded/);

    // Execution history and the action executions of the run.
    await page.getByRole("tab", { name: "Execution history" }).click();
    await expect(page.getByTestId("execution-history")).toContainText("Succeeded");
    await page.getByTestId("execution-history").getByRole("link").first().click();
    await expect(page.getByTestId("action-executions")).toContainText("ManualApproval");

    // Delete.
    await page.goto("/codepipeline/pipelines");
    const row = page.getByTestId("resource-table").getByRole("row", { name: new RegExp(name) });
    await row.getByRole("radio").check();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill("delete");
    await page.getByTestId("confirm-delete").click();
    await expect(page.getByTestId("flash")).toContainText(`Deleted pipeline ${name}`);
    const after = await aws<{ pipelines: { name: string }[] }>("codepipeline", "list-pipelines");
    expect(after?.pipelines.some((p) => p.name === name)).toBe(false);
  } finally {
    await quietly(() => aws("codepipeline", "delete-pipeline", "--name", name));
    await quietly(() => aws("codecommit", "delete-repository", "--repository-name", repo));
    await quietly(() => aws("iam", "delete-role-policy", "--role-name", role, "--policy-name", `AWSCodePipelineServiceRole-${name}`));
    await quietly(() => aws("iam", "delete-role", "--role-name", role));
    await quietly(() => aws("s3", "rm", `s3://${artifactBucket}/${name}/`, "--recursive"));
    // Remove the default artifact bucket only if this test created it and nothing else is in it.
    if (!bucketExisted) await quietly(() => aws("s3api", "delete-bucket", "--bucket", artifactBucket));
  }
});

test("CodePipeline: Edit tags shows the current tags and saving unchanged changes nothing", async ({ page }) => {
  const name = uniqueName("fix-codepipeline");
  const bucket = name.toLowerCase();
  const role = `${name}-role`.slice(0, 64);
  const trust = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "codepipeline.amazonaws.com" }, Action: "sts:AssumeRole" }] };
  try {
    await aws("s3api", "create-bucket", "--bucket", bucket);
    const roleArn = (await aws<{ Role: { Arn: string } }>("iam", "create-role", "--role-name", role, "--assume-role-policy-document", JSON.stringify(trust)))?.Role.Arn ?? "";
    const pipeline = {
      name,
      roleArn,
      artifactStore: { type: "S3", location: bucket },
      stages: [
        { name: "Source", actions: [{ name: "Source", actionTypeId: { category: "Source", owner: "AWS", provider: "S3", version: "1" }, configuration: { S3Bucket: bucket, S3ObjectKey: "src.zip", PollForSourceChanges: "false" }, outputArtifacts: [{ name: "SourceArtifact" }] }] },
        { name: "Approval", actions: [{ name: "Approve", actionTypeId: { category: "Approval", owner: "AWS", provider: "Manual", version: "1" } }] },
      ],
    };
    await aws("codepipeline", "create-pipeline", "--pipeline", JSON.stringify(pipeline), "--tags", JSON.stringify([{ key: "team", value: "ops" }]));
    await page.goto(`/codepipeline/pipelines/${name}`);
    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Edit tags" }).click();
    await expect(page.getByLabel("Tags key 1")).toHaveValue("team");
    await expect(page.getByLabel("Tags value 1")).toHaveValue("ops");
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog")).toContainText("No tag changes");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    const arn = (await aws<{ metadata: { pipelineArn: string } }>("codepipeline", "get-pipeline", "--name", name))?.metadata.pipelineArn ?? "";
    expect((await aws<{ tags: { key: string; value: string }[] }>("codepipeline", "list-tags-for-resource", "--resource-arn", arn))?.tags).toEqual([{ key: "team", value: "ops" }]);
  } finally {
    await quietly(() => aws("codepipeline", "delete-pipeline", "--name", name));
    await quietly(() => aws("iam", "delete-role", "--role-name", role));
    await quietly(() => aws("s3", "rb", `s3://${bucket}`, "--force"));
  }
});
