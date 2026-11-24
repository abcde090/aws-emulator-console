import { expect, test, type Page } from "@playwright/test";
import { aws, uniqueName } from "./aws-cli";

/** Console gaps found by walking the lab book in the console. */

async function openMenuItem(page: Page, label: string): Promise<void> {
  const item = page.getByRole("menuitem", { name: label, exact: true });
  await expect(async () => {
    if (!(await item.isVisible())) await page.getByRole("button", { name: "Actions" }).click();
    await expect(item).toBeVisible({ timeout: 1000 });
  }).toPass();
  await item.click();
}

test("EC2 Connect shows the connection details as soon as it opens", async ({ page }) => {
  test.setTimeout(120_000);
  const name = uniqueName("lab-fix-ec2");
  let id = "";
  try {
    const images = await aws<{ Images?: { ImageId?: string }[] }>("ec2", "describe-images", "--owners", "amazon", "--filters", "Name=architecture,Values=x86_64");
    const ami = images?.Images?.[0]?.ImageId as string;
    const run = await aws<{ Instances?: { InstanceId?: string }[] }>(
      "ec2", "run-instances", "--image-id", ami, "--instance-type", "t3.micro", "--count", "1",
      "--tag-specifications", `ResourceType=instance,Tags=[{Key=Name,Value=${name}}]`
    );
    id = run?.Instances?.[0]?.InstanceId as string;
    await page.goto(`/ec2/instances/${id}`);
    await page.waitForLoadState("networkidle");
    await openMenuItem(page, "Connect");
    const dialog = page.getByRole("dialog");
    // No click on a "Connect" button inside the dialog: the details are already there.
    await expect(dialog.getByTestId("flash")).toContainText("Connect using an SSH client");
    await expect(dialog.getByText("Private IPv4 address")).toBeVisible();
    await expect(dialog.getByTestId("action-submit")).toHaveCount(0);
  } finally {
    if (id) await aws("ec2", "terminate-instances", "--instance-ids", id);
  }
});

test("CloudWatch composite alarm History lists its state changes", async ({ page }) => {
  const child = uniqueName("lab-fix-child");
  const composite = uniqueName("lab-fix-comp");
  try {
    await aws(
      "cloudwatch", "put-metric-alarm", "--alarm-name", child, "--namespace", "LabFix", "--metric-name", "Errors",
      "--statistic", "Sum", "--period", "60", "--evaluation-periods", "1", "--threshold", "1", "--comparison-operator", "GreaterThanOrEqualToThreshold"
    );
    await aws("cloudwatch", "put-composite-alarm", "--alarm-name", composite, "--alarm-rule", `ALARM("${child}")`);
    await aws("cloudwatch", "set-alarm-state", "--alarm-name", composite, "--state-value", "ALARM", "--state-reason", "lab fix check");
    const history = await aws<{ AlarmHistoryItems?: unknown[] }>("cloudwatch", "describe-alarm-history", "--alarm-name", composite, "--alarm-types", "CompositeAlarm");
    expect(history?.AlarmHistoryItems?.length ?? 0).toBeGreaterThan(0);

    await page.goto(`/cloudwatch/alarms/${encodeURIComponent(composite)}`);
    await page.getByRole("tab", { name: "History" }).click();
    await expect(page.getByText(/to ALARM/).first()).toBeVisible();
  } finally {
    await aws("cloudwatch", "delete-alarms", "--alarm-names", composite);
    await aws("cloudwatch", "delete-alarms", "--alarm-names", child);
  }
});
