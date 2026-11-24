import { expect, test, type Page } from "@playwright/test";
import { aws, uniqueName } from "./aws-cli";

async function runAction(page: Page, label: string, fill?: () => Promise<void>): Promise<void> {
  await page.getByRole("button", { name: "Actions" }).click();
  await page.getByRole("menuitem", { name: label, exact: true }).click();
  if (fill) await fill();
  await page.getByTestId("action-submit").click();
}

const closeDialog = (page: Page) => page.getByRole("button", { name: "Close", exact: true }).last().click();

const made = { stream: "", firehose: "", bucket: "", role: "" };

test.afterEach(async () => {
  if (made.stream) await aws("kinesis", "delete-stream", "--stream-name", made.stream, "--enforce-consumer-deletion").catch(() => null);
  if (made.firehose) await aws("firehose", "delete-delivery-stream", "--delivery-stream-name", made.firehose).catch(() => null);
  if (made.bucket) await aws("s3", "rb", `s3://${made.bucket}`, "--force").catch(() => null);
  if (made.role) await aws("iam", "delete-role", "--role-name", made.role).catch(() => null);
  Object.assign(made, { stream: "", firehose: "", bucket: "", role: "" });
});

test("Kinesis: create a provisioned data stream, put and read a record, delete it", async ({ page }) => {
  const name = uniqueName("e2e-kinesis");
  made.stream = name;

  await page.goto("/kinesis/data-streams");
  await expect(page.getByRole("heading", { name: /^Data streams/ })).toBeVisible();
  await page.getByRole("link", { name: "Create data stream" }).first().click();
  await page.getByLabel("Data stream name", { exact: true }).fill(name);
  await page.getByRole("radio", { name: /^Provisioned/ }).check();
  await page.getByLabel("Provisioned shards", { exact: true }).fill("2");
  await page.getByRole("button", { name: "Create data stream" }).click();

  await expect(page).toHaveURL(new RegExp(`/kinesis/data-streams/${name}`));
  await expect(page.getByTestId("flash")).toContainText(`Created data stream ${name}`);
  await expect(page.getByTestId("kv-Capacity mode")).toHaveText("Provisioned");
  // New streams are CREATING for a moment.
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId("kv-Status")).toHaveText("ACTIVE", { timeout: 1000 });
  }).toPass({ timeout: 20_000 });
  await expect(page.getByTestId("kv-Open shards")).toHaveText("2");

  const summary = await aws<{ StreamDescriptionSummary: { OpenShardCount: number; StreamStatus: string } }>("kinesis", "describe-stream-summary", "--stream-name", name);
  expect(summary?.StreamDescriptionSummary.OpenShardCount).toBe(2);

  await runAction(page, "Put record", async () => {
    await page.getByLabel("Partition key", { exact: true }).fill("customer-1");
    await page.getByLabel("Data", { exact: true }).fill('{"hello":"kinesis"}');
  });
  await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("Record put into shardId-");
  await closeDialog(page);

  await runAction(page, "Get records (data viewer)");
  await expect(page.getByTestId("result-table")).toContainText('{"hello":"kinesis"}');
  await expect(page.getByTestId("result-table")).toContainText("customer-1");
  await closeDialog(page);

  await runAction(page, "Edit data retention period", async () => {
    await page.getByLabel("Data retention period (hours)").fill("48");
  });
  await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("48 hours");
  await closeDialog(page);
  const after = await aws<{ StreamDescriptionSummary: { RetentionPeriodHours: number } }>("kinesis", "describe-stream-summary", "--stream-name", name);
  expect(after?.StreamDescriptionSummary.RetentionPeriodHours).toBe(48);

  await page.goto("/kinesis/data-streams");
  const row = page.getByTestId("resource-table").getByRole("row", { name: new RegExp(name) });
  await expect(row).toBeVisible();
  await row.getByRole("radio").check();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByLabel("Confirm deletion").fill(name);
  await page.getByTestId("confirm-delete").click();
  await expect(page.getByTestId("flash")).toContainText(`Deleted data stream ${name}`);
  await expect(async () => {
    const listed = await aws<{ StreamNames: string[] }>("kinesis", "list-streams");
    expect(listed?.StreamNames).not.toContain(name);
  }).toPass({ timeout: 30_000 });
  made.stream = "";
});

test("Kinesis: create a Firehose stream to S3, put a record, delete it", async ({ page }) => {
  const name = uniqueName("e2e-kinesis-fh");
  const bucket = uniqueName("e2e-kinesis-fh-dest");
  const role = uniqueName("e2e-kinesis-fh-role");
  Object.assign(made, { firehose: name, bucket, role });
  await aws("s3api", "create-bucket", "--bucket", bucket);
  await aws("iam", "create-role", "--role-name", role, "--assume-role-policy-document", JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "firehose.amazonaws.com" }, Action: "sts:AssumeRole" }] }));

  await page.goto("/kinesis/firehose/create");
  await page.getByLabel("Firehose stream name", { exact: true }).fill(name);
  await page.getByLabel("S3 bucket", { exact: true }).selectOption(bucket);
  await page.getByLabel("S3 bucket prefix - optional").fill("raw/");
  await page.getByLabel("Buffer interval (seconds) - optional").fill("60");
  await page.getByLabel("IAM role", { exact: true }).selectOption({ label: `${role} (trusts firehose.amazonaws.com)` });
  await page.getByRole("button", { name: "Create Firehose stream" }).click();

  await expect(page).toHaveURL(new RegExp(`/kinesis/firehose/${name}`));
  await expect(page.getByTestId("kv-Destination")).toHaveText("Amazon S3");
  const described = await aws<{ DeliveryStreamDescription: { Destinations: { ExtendedS3DestinationDescription?: { BucketARN: string; Prefix?: string } }[] } }>("firehose", "describe-delivery-stream", "--delivery-stream-name", name);
  expect(described?.DeliveryStreamDescription.Destinations[0].ExtendedS3DestinationDescription?.BucketARN).toBe(`arn:aws:s3:::${bucket}`);

  // The stream is CREATING for a few seconds; Put record works once it is ACTIVE.
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId("kv-Status")).toHaveText("ACTIVE", { timeout: 1000 });
  }).toPass({ timeout: 20_000 });
  await runAction(page, "Put record", async () => {
    await page.getByLabel("Record data", { exact: true }).fill('{"event":"e2e"}');
  });
  await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("Record accepted");
  await closeDialog(page);

  await page.goto("/kinesis/firehose");
  await expect(page.getByTestId("resource-table").getByRole("row", { name: new RegExp(name) })).toBeVisible();
  await page.goto(`/kinesis/firehose/${name}`);
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByLabel("Confirm deletion").fill(name);
  await page.getByTestId("confirm-delete").click();
  await expect(page).toHaveURL(/\/kinesis\/firehose\?deleted=/);
  // Deletion is asynchronous (DELETING first).
  await expect(async () => {
    const listed = await aws<{ DeliveryStreamNames: string[] }>("firehose", "list-delivery-streams");
    expect(listed?.DeliveryStreamNames).not.toContain(name);
  }).toPass({ timeout: 30_000 });
  made.firehose = "";
});

interface SummaryOut {
  StreamDescriptionSummary: { StreamStatus: string; OpenShardCount: number; RetentionPeriodHours: number; EncryptionType?: string; StreamModeDetails?: { StreamMode: string } };
}

async function openAction(page: Page, label: string): Promise<void> {
  await page.getByRole("button", { name: "Actions" }).click();
  await page.getByRole("menuitem", { name: label, exact: true }).click();
}

test("Kinesis: Edit dialogs open with the stream's capacity, retention, encryption and tags; saving unchanged changes nothing", async ({ page }) => {
  const name = uniqueName("fix-kinesis");
  made.stream = name;
  await aws("kinesis", "create-stream", "--stream-name", name, "--shard-count", "1", "--stream-mode-details", "StreamMode=PROVISIONED");
  await expect(async () => {
    const s = await aws<SummaryOut>("kinesis", "describe-stream-summary", "--stream-name", name);
    expect(s?.StreamDescriptionSummary.StreamStatus).toBe("ACTIVE");
  }).toPass({ timeout: 30_000 });
  await aws("kinesis", "increase-stream-retention-period", "--stream-name", name, "--retention-period-hours", "48");
  await aws("kinesis", "add-tags-to-stream", "--stream-name", name, "--tags", "env=prod");
  await expect(async () => {
    const s = await aws<SummaryOut>("kinesis", "describe-stream-summary", "--stream-name", name);
    expect(s?.StreamDescriptionSummary.StreamStatus).toBe("ACTIVE");
  }).toPass({ timeout: 30_000 });
  const before = await aws<SummaryOut>("kinesis", "describe-stream-summary", "--stream-name", name);

  await page.goto(`/kinesis/data-streams/${name}`);
  const dialog = page.getByRole("dialog");

  await openAction(page, "Edit capacity");
  await expect(dialog.getByTestId("field-mode").getByRole("radio", { name: "Provisioned" })).toBeChecked();
  await expect(dialog.getByTestId("field-shards")).toHaveValue("1");
  await dialog.getByTestId("action-submit").click();
  await expect(dialog.getByTestId("flash")).toContainText("already has 1 shard");
  await closeDialog(page);

  await openAction(page, "Edit data retention period");
  await expect(dialog.getByTestId("field-hours")).toHaveValue("48");
  await dialog.getByTestId("action-submit").click();
  await expect(dialog.getByTestId("flash")).toContainText("already 48 hours");
  await closeDialog(page);

  await openAction(page, "Edit encryption");
  await expect(dialog.getByTestId("field-enabled").getByRole("radio", { name: "Disabled" })).toBeChecked();
  await dialog.getByTestId("action-submit").click();
  await expect(dialog.getByTestId("flash")).toContainText("already disabled");
  await closeDialog(page);

  await openAction(page, "Manage tags");
  await expect(dialog.getByLabel("Tags key 1")).toHaveValue("env");
  await expect(dialog.getByLabel("Tags value 1")).toHaveValue("prod");
  await dialog.getByTestId("action-submit").click();
  await expect(dialog.getByTestId("flash")).toContainText("No tag changes");
  await closeDialog(page);

  const after = await aws<SummaryOut>("kinesis", "describe-stream-summary", "--stream-name", name);
  expect(after?.StreamDescriptionSummary).toEqual(before?.StreamDescriptionSummary);
  const tags = await aws<{ Tags: { Key: string; Value: string }[] }>("kinesis", "list-tags-for-stream", "--stream-name", name);
  expect(tags?.Tags).toEqual([{ Key: "env", Value: "prod" }]);
});
