import { expect, test, type Page } from "@playwright/test";
import { aws, uniqueName } from "./aws-cli";

/** Re-check review: dialogs that used to change settings when saved unchanged (RC-1, RC-2). */

async function openAction(page: Page, label: string) {
  const item = page.getByRole("menuitem", { name: label, exact: true });
  await expect(async () => {
    if (!(await item.isVisible())) await page.getByRole("button", { name: "Actions" }).click();
    await expect(item).toBeVisible({ timeout: 1000 });
  }).toPass();
  await item.click();
  await expect(page.getByTestId("action-submit")).toBeEnabled();
}

test("RC-1: Edit CloudWatch Logs on a trail without it is off, and saving unchanged connects nothing", async ({ page }) => {
  const bucket = uniqueName("recheck-ct");
  const trail = uniqueName("recheck-ct");
  try {
    await aws("s3api", "create-bucket", "--bucket", bucket);
    const policy = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "cloudtrail.amazonaws.com" }, Action: ["s3:GetBucketAcl", "s3:PutObject"], Resource: [`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/*`] }] };
    await aws("s3api", "put-bucket-policy", "--bucket", bucket, "--policy", JSON.stringify(policy));
    await aws("cloudtrail", "create-trail", "--name", trail, "--s3-bucket-name", bucket);
    await page.goto(`/cloudtrail/trails/${trail}`);
    await page.waitForLoadState("networkidle");
    await openAction(page, "Edit CloudWatch Logs");
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByTestId("field-enabled")).not.toBeChecked();
    await expect(dialog.getByTestId("field-logGroup")).toBeHidden();
    await page.getByTestId("action-submit").click();
    await expect(dialog.getByTestId("flash")).toContainText("No changes to save.");
    const t = await aws<{ Trail: { CloudWatchLogsLogGroupArn?: string } }>("cloudtrail", "get-trail", "--name", trail);
    expect(t?.Trail.CloudWatchLogsLogGroupArn).toBeUndefined();
  } finally {
    await aws("cloudtrail", "delete-trail", "--name", trail).catch(() => null);
    await aws("s3", "rb", `s3://${bucket}`, "--force").catch(() => null);
  }
});

test("RC-2: Edit automatic key rotation shows rotation off, and saving unchanged keeps it off", async ({ page }) => {
  const key = await aws<{ KeyMetadata: { KeyId: string } }>("kms", "create-key", "--description", uniqueName("recheck-kms"));
  const keyId = key?.KeyMetadata.KeyId as string;
  try {
    await page.goto(`/kms/keys/${keyId}`);
    await page.waitForLoadState("networkidle");
    await openAction(page, "Edit automatic key rotation");
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByTestId("field-enabled")).not.toBeChecked();
    await page.getByTestId("action-submit").click();
    await expect(dialog.getByTestId("flash")).toContainText("No changes to save.");
    const r = await aws<{ KeyRotationEnabled: boolean }>("kms", "get-key-rotation-status", "--key-id", keyId);
    expect(r?.KeyRotationEnabled).toBe(false);
  } finally {
    await aws("kms", "schedule-key-deletion", "--key-id", keyId, "--pending-window-in-days", "7").catch(() => null);
  }
});
