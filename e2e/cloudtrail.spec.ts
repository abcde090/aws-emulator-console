import { expect, test } from "@playwright/test";
import { aws, uniqueName } from "./aws-cli";

const trailNames = async () => ((await aws<{ trailList: { Name: string }[] }>("cloudtrail", "describe-trails"))?.trailList ?? []).map((t) => t.Name);

async function removeBucket(bucket: string): Promise<void> {
  const head = await aws<{ Buckets: { Name: string }[] }>("s3api", "list-buckets");
  if (!head?.Buckets.some((b) => b.Name === bucket)) return;
  const objs = await aws<{ Contents?: { Key: string }[] }>("s3api", "list-objects-v2", "--bucket", bucket);
  for (const o of objs?.Contents ?? []) await aws("s3api", "delete-object", "--bucket", bucket, "--key", o.Key);
  await aws("s3api", "delete-bucket", "--bucket", bucket);
}

test("CloudTrail: create a trail with a new bucket, stop logging, delete it", async ({ page }) => {
  const name = uniqueName("e2e-cloudtrail");
  const bucket = `${name}-logs`;
  try {
    await page.goto("/cloudtrail/trails");
    await expect(page.getByRole("heading", { name: /^Trails/ })).toBeVisible();
    await page.getByRole("link", { name: "Create trail" }).first().click();
    await page.getByLabel("Trail name").fill(name);
    await page.getByLabel("Trail log bucket name").fill(bucket);
    await page.getByRole("button", { name: "Create trail" }).click();
    await expect(page.getByTestId("kv-Trail name")).toHaveText(name);
    await expect(page.getByTestId("kv-Trail logging")).toHaveText("Logging");
    await expect(page.getByTestId("kv-Log file validation")).toHaveText("Enabled");
    expect(await trailNames()).toContain(name);

    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Stop logging" }).click();
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("Logging stopped");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    expect((await aws<{ IsLogging: boolean }>("cloudtrail", "get-trail-status", "--name", name))?.IsLogging).toBe(false);

    await page.goto("/cloudtrail/trails");
    const row = page.getByTestId("resource-table").getByRole("row", { name: new RegExp(name) });
    await expect(row).toBeVisible();
    await row.getByRole("radio").check();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill(name);
    await page.getByTestId("confirm-delete").click();
    await expect(page.getByTestId("resource-table").getByRole("row", { name: new RegExp(name) })).toHaveCount(0);
    expect(await trailNames()).not.toContain(name);
  } finally {
    if ((await trailNames()).includes(name)) await aws("cloudtrail", "delete-trail", "--name", name);
    await removeBucket(bucket);
  }
});

test("CloudTrail: event history filters and event detail", async ({ page }) => {
  await page.goto("/cloudtrail/event-history");
  const table = page.getByTestId("events-table");
  await expect(table).toBeVisible();
  await page.getByLabel("Lookup attribute").selectOption("ReadOnly");
  await page.getByLabel("Lookup value").selectOption("true");
  await page.getByRole("button", { name: "Apply" }).click();
  const first = table.getByRole("link").first();
  await expect(first).toBeVisible();
  await first.click();
  await expect(page).toHaveURL(/\/cloudtrail\/event-history\/.+/);
  await expect(page.getByTestId("kv-Read-only")).toHaveText("true");
  await expect(page.getByRole("tab", { name: "Event record" })).toBeVisible();
});

interface TrailInfo { IsMultiRegionTrail: boolean; LogFileValidationEnabled: boolean; KmsKeyId?: string; SnsTopicARN?: string }
const getTrail = async (name: string) => (await aws<{ Trail: TrailInfo }>("cloudtrail", "get-trail", "--name", name))?.Trail;

test("CloudTrail: Edit dialogs show the trail's current settings and saving unchanged changes nothing", async ({ page }) => {
  const name = uniqueName("fix-cloudtrail-edit");
  const bucket = `${name}-logs`;
  try {
    await aws("s3api", "create-bucket", "--bucket", bucket);
    await aws("s3api", "put-bucket-policy", "--bucket", bucket, "--policy", JSON.stringify({
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Principal: { Service: "cloudtrail.amazonaws.com" }, Action: ["s3:GetBucketAcl", "s3:PutObject"], Resource: [`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/*`] }],
    }));
    // Non-default settings: single-Region, no log file validation, write-only management events, a tag.
    await aws("cloudtrail", "create-trail", "--name", name, "--s3-bucket-name", bucket, "--no-is-multi-region-trail", "--no-enable-log-file-validation", "--tags-list", "Key=team,Value=blue");
    await aws("cloudtrail", "put-event-selectors", "--trail-name", name, "--event-selectors", JSON.stringify([{ ReadWriteType: "WriteOnly", IncludeManagementEvents: true }]));
    const before = await getTrail(name);
    expect(before?.IsMultiRegionTrail).toBe(false);
    expect(before?.LogFileValidationEnabled).toBe(false);

    await page.goto(`/cloudtrail/trails/${name}`);
    await expect(page.getByTestId("kv-Trail name")).toHaveText(name);

    // Edit general details: prefilled with the trail's values, not the field defaults.
    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Edit general details" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByTestId("field-validation")).not.toBeChecked();
    await expect(dialog.getByTestId("field-multiRegion")).not.toBeChecked();
    await page.getByTestId("action-submit").click();
    await expect(dialog.getByTestId("flash")).toContainText("No changes to save");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    const after = await getTrail(name);
    expect(after?.IsMultiRegionTrail).toBe(false);
    expect(after?.LogFileValidationEnabled).toBe(false);

    // Edit event types: shows Write-only management events.
    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Edit event types" }).click();
    await expect(dialog.getByTestId("field-management")).toBeChecked();
    await expect(dialog.getByTestId("field-readWrite").getByRole("radio", { name: "Write", exact: true })).toBeChecked();
    await page.getByRole("button", { name: "Cancel" }).click();

    // Manage tags: shows the existing tag; saving unchanged keeps it.
    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Manage tags" }).click();
    await expect(dialog.getByTestId("field-tags").locator("input").first()).toHaveValue("team");
    await page.getByTestId("action-submit").click();
    await expect(dialog.getByTestId("flash")).toContainText("No tag changes");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    const tags = await aws<{ ResourceTagList: { TagsList: { Key: string; Value: string }[] }[] }>("cloudtrail", "list-tags", "--resource-id-list", `arn:aws:cloudtrail:us-east-1:000000000000:trail/${name}`);
    expect(tags?.ResourceTagList[0]?.TagsList).toEqual([{ Key: "team", Value: "blue" }]);
  } finally {
    if ((await trailNames()).includes(name)) await aws("cloudtrail", "delete-trail", "--name", name);
    await removeBucket(bucket);
  }
});
