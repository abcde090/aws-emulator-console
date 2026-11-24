import { expect, test, type Page } from "@playwright/test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aws, uniqueName } from "./aws-cli";

async function runInCloudShell(page: Page, command: string) {
  const input = page.getByLabel("CloudShell command");
  await input.fill(command);
  await input.press("Enter");
  await expect(input).toBeEnabled({ timeout: 20_000 });
}

test("CloudShell runs aws commands as the admin and refuses anything else", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "CloudShell" }).click();
  await runInCloudShell(page, "aws sts get-caller-identity");
  await expect(page.getByTestId("cloudshell-output").last()).toContainText('"Account": "000000000000"');
  await runInCloudShell(page, "cat ~/.aws/credentials");
  await expect(page.getByTestId("cloudshell-output").last()).toContainText("Only aws commands can run here");
  await runInCloudShell(page, "aws s3 ls | head");
  await expect(page.getByTestId("cloudshell-output").last()).toContainText("Shell operators");
  // OG-10: the input keeps focus after a command.
  await expect(page.getByLabel("CloudShell command")).toBeFocused();
  // History: up arrow recalls the last command.
  await page.getByLabel("CloudShell command").press("ArrowUp");
  await expect(page.getByLabel("CloudShell command")).toHaveValue("aws s3 ls | head");
});

test("switching to a limited IAM user: the simulator denies what its policy does not allow", async ({ page }) => {
  const user = uniqueName("e2e-user");
  const policy = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["sqs:ListQueues", "sqs:GetQueueAttributes"], Resource: "*" }] });
  await aws("iam", "create-user", "--user-name", user);
  await aws("iam", "put-user-policy", "--user-name", user, "--policy-name", "sqs-read", "--policy-document", policy);
  try {
    await page.goto("/");
    await page.getByTestId("identity-button").click();
    await page.getByRole("menu", { name: "Identity" }).getByRole("button", { name: new RegExp(`user ${user}`) }).click();
    await expect(page.getByTestId("identity-banner")).toContainText(`IAM user ${user}`);

    await page.goto("/s3/buckets");
    await expect(page.getByTestId("error-banner")).toContainText("AccessDenied (simulated by the console)");
    await expect(page.getByTestId("error-banner")).toContainText("s3:ListAllMyBuckets");

    await page.goto("/sqs/queues");
    await expect(page.getByRole("heading", { name: /^Queues/ })).toBeVisible();
    await expect(page.getByTestId("error-banner")).toHaveCount(0);

    await page.getByRole("button", { name: "CloudShell" }).click();
    await runInCloudShell(page, "aws sts get-caller-identity");
    await expect(page.getByTestId("cloudshell-output").last()).toContainText(`user/${user}`);
    await runInCloudShell(page, "aws s3 ls");
    await expect(page.getByTestId("cloudshell-output").last()).toContainText("AccessDenied (simulated by the console)");

    await page.getByRole("button", { name: "Switch back to admin" }).click();
    await expect(page.getByTestId("identity-banner")).toHaveCount(0);
    await page.goto("/s3/buckets");
    await expect(page.getByTestId("error-banner")).toHaveCount(0);
  } finally {
    await aws("iam", "delete-user-policy", "--user-name", user, "--policy-name", "sqs-read");
    await aws("iam", "delete-user", "--user-name", user);
  }
});

test("SEC-1: CloudShell cannot write a host file through a --x=--name split, nor read the key copies", async ({ page }) => {
  const bucket = uniqueName("e2e-sec1");
  const dir = mkdtempSync(join(tmpdir(), "e2e-sec1-"));
  const target = join(dir, "pwn.txt");
  const body = join(dir, "body.txt");
  writeFileSync(body, "object content");
  await aws("s3api", "create-bucket", "--bucket", bucket);
  await aws("s3api", "put-object", "--bucket", bucket, "--key", "k", "--body", body);
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "CloudShell" }).click();
    // The reviewer's exploit: the guard refuses it, and the sandbox would block the write anyway.
    await runInCloudShell(page, `aws s3api get-object --bucket ${bucket} --key k --response-content-language=--name ${target}`);
    await expect(page.getByTestId("cloudshell-output").last()).toContainText("looks like a path on this computer");
    expect(existsSync(target)).toBe(false);
    // Relative names resolve in an empty folder: the emulator key copies are not there.
    await runInCloudShell(page, `aws s3api put-object --bucket ${bucket} --key leak --body emulator_credentials`);
    await expect(page.getByTestId("cloudshell-output").last()).toContainText("Blob values must be a path to a file");
    await runInCloudShell(page, "aws sqs list-queues --cli-auto-prompt");
    await expect(page.getByTestId("cloudshell-output").last()).toContainText("interactive prompt");
    // Ordinary output-to-screen still works.
    await runInCloudShell(page, `aws s3 cp s3://${bucket}/k -`);
    await expect(page.getByTestId("cloudshell-output").last()).toContainText("object content");
    await runInCloudShell(page, "aws help");
    await expect(page.getByTestId("cloudshell-output").last()).toContainText("aws -");
  } finally {
    await aws("s3api", "delete-object", "--bucket", bucket, "--key", "k");
    await aws("s3api", "delete-bucket", "--bucket", bucket);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("IDS-5: a secret-scoped Allow lets a limited user open that secret, and only that one", async ({ page }) => {
  const user = uniqueName("e2e-secret-user");
  const secret = uniqueName("e2e-scoped-secret");
  const other = uniqueName("e2e-other-secret");
  await aws("secretsmanager", "create-secret", "--name", secret, "--secret-string", "v1");
  await aws("secretsmanager", "create-secret", "--name", other, "--secret-string", "v2");
  const policy = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      { Effect: "Allow", Action: "secretsmanager:ListSecrets", Resource: "*" },
      { Effect: "Allow", Action: ["secretsmanager:DescribeSecret", "secretsmanager:ListSecretVersionIds", "secretsmanager:GetResourcePolicy"], Resource: `arn:aws:secretsmanager:us-east-1:000000000000:secret:${secret}-*` },
    ],
  });
  await aws("iam", "create-user", "--user-name", user);
  await aws("iam", "put-user-policy", "--user-name", user, "--policy-name", "one-secret", "--policy-document", policy);
  try {
    await page.goto("/");
    await page.getByTestId("identity-button").click();
    await page.getByRole("menu", { name: "Identity" }).getByRole("button", { name: new RegExp(`user ${user}`) }).click();
    await expect(page.getByTestId("identity-banner")).toContainText(`IAM user ${user}`);
    await page.goto(`/secretsmanager/secrets/${encodeURIComponent(secret)}`);
    await expect(page.getByText("secretsmanager:DescribeSecret on resource")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: secret })).toBeVisible();
    await page.goto(`/secretsmanager/secrets/${encodeURIComponent(other)}`);
    await expect(page.getByText(/secretsmanager:DescribeSecret on resource: arn:aws:secretsmanager:us-east-1:000000000000:secret:/).first()).toBeVisible();
    await page.getByRole("button", { name: "Switch back to admin" }).click();
  } finally {
    await aws("iam", "delete-user-policy", "--user-name", user, "--policy-name", "one-secret");
    await aws("iam", "delete-user", "--user-name", user);
    await aws("secretsmanager", "delete-secret", "--secret-id", secret, "--force-delete-without-recovery");
    await aws("secretsmanager", "delete-secret", "--secret-id", other, "--force-delete-without-recovery");
  }
});
