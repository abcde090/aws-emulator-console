import { expect, test } from "@playwright/test";
import { aws, uniqueName } from "./aws-cli";

test("SQS: create a queue, see it, send/poll/delete a message, delete the queue", async ({ page }) => {
  const name = uniqueName("e2e-queue");

  await page.goto("/sqs/queues");
  await expect(page.getByRole("heading", { name: /^Queues/ })).toBeVisible();

  await page.getByRole("link", { name: "Create queue" }).first().click();
  await expect(page.getByTestId("create-form")).toBeVisible();
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Visibility timeout (seconds)").fill("45");
  await page.getByRole("button", { name: "Create queue" }).click();

  await expect(page).toHaveURL(new RegExp(`/sqs/queues/${name}`));
  await expect(page.getByTestId("flash")).toContainText(`Created queue ${name}`);
  await expect(page.getByTestId("kv-Name")).toHaveText(name);
  await expect(page.getByTestId("kv-Type")).toHaveText("Standard");
  await expect(page.getByTestId("kv-Visibility timeout (seconds)")).toHaveText("45");

  const listed = await aws<{ QueueUrls?: string[] }>("sqs", "list-queues", "--queue-name-prefix", name);
  expect(listed?.QueueUrls?.some((u) => u.endsWith(`/${name}`))).toBe(true);

  // Send a message.
  await page.getByRole("button", { name: "Actions" }).click();
  await page.getByRole("menuitem", { name: "Send message" }).click();
  await page.getByLabel("Message body").fill("hello from e2e");
  await page.getByTestId("action-submit").click();
  await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("Message sent");
  await page.getByRole("button", { name: "Close", exact: true }).last().click();

  // Poll, then delete the received message.
  await page.getByRole("button", { name: "Actions" }).click();
  await page.getByRole("menuitem", { name: "Poll for messages" }).click();
  await page.getByTestId("action-submit").click();
  const results = page.getByTestId("result-table");
  await expect(results).toContainText("hello from e2e");
  await results.getByRole("checkbox").first().check();
  await page.getByRole("button", { name: /^Delete \(1\)/ }).click();
  await expect(page.getByRole("dialog")).toContainText("Deleted 1 message");
  await page.getByRole("button", { name: "Close", exact: true }).last().click();

  // The list shows it; delete from the list.
  await page.goto("/sqs/queues");
  const row = page.getByTestId("resource-table").getByRole("row", { name: new RegExp(name) });
  await expect(row).toBeVisible();
  await row.getByRole("radio").check();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByLabel("Confirm deletion").fill("delete");
  await page.getByTestId("confirm-delete").click();
  await expect(page.getByTestId("flash")).toContainText(`Deleted queue ${name}`);
  await expect(page.getByTestId("resource-table").getByRole("row", { name: new RegExp(name) })).toHaveCount(0);

  const after = await aws<{ QueueUrls?: string[] }>("sqs", "list-queues", "--queue-name-prefix", name);
  expect(after?.QueueUrls ?? []).toHaveLength(0);
});

test("SQS: a FIFO queue with a dead-letter queue", async ({ page }) => {
  const dlq = `${uniqueName("e2e-dlq")}.fifo`;
  const main = `${uniqueName("e2e-main")}.fifo`;
  await aws("sqs", "create-queue", "--queue-name", dlq, "--attributes", "FifoQueue=true");
  try {
    await page.goto("/sqs/queues/create");
    await page.getByRole("radio", { name: /FIFO/ }).check();
    await page.getByLabel("Name", { exact: true }).fill(main);
    await page.getByText("Send undeliverable messages to a dead-letter queue").click();
    await page.getByLabel("Dead-letter queue", { exact: true }).selectOption({ label: dlq });
    await page.getByLabel("Maximum receives").fill("3");
    await page.getByRole("button", { name: "Create queue" }).click();
    await expect(page.getByTestId("kv-Type")).toHaveText("FIFO");
    await page.getByRole("tab", { name: "Dead-letter queue" }).click();
    await expect(page.getByTestId("kv-Maximum receives")).toHaveText("3");
    const url = (await aws<{ QueueUrl: string }>("sqs", "get-queue-url", "--queue-name", main))?.QueueUrl ?? "";
    const attrs = await aws<{ Attributes: Record<string, string> }>("sqs", "get-queue-attributes", "--queue-url", url, "--attribute-names", "RedrivePolicy");
    expect(attrs?.Attributes.RedrivePolicy).toContain(dlq);
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill("delete");
    await page.getByTestId("confirm-delete").click();
    await expect(page).toHaveURL(/\/sqs\/queues\?deleted=/);
  } finally {
    const url = (await aws<{ QueueUrl: string }>("sqs", "get-queue-url", "--queue-name", dlq))?.QueueUrl;
    if (url) await aws("sqs", "delete-queue", "--queue-url", url);
  }
});

test("SQS: Edit and Edit tags show the queue's current values; saving unchanged changes nothing", async ({ page }) => {
  const dlqName = uniqueName("fix-sqs-dlq");
  const name = uniqueName("fix-sqs-edit");
  const dlq = await aws<{ QueueUrl: string }>("sqs", "create-queue", "--queue-name", dlqName);
  const dlqArn = `arn:aws:sqs:us-east-1:000000000000:${dlqName}`;
  const redrive = JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: "7" });
  const q = await aws<{ QueueUrl: string }>(
    "sqs", "create-queue", "--queue-name", name,
    "--attributes", JSON.stringify({ VisibilityTimeout: "77", DelaySeconds: "5", RedrivePolicy: redrive }),
    "--tags", "env=prod,team=data"
  );
  const read = () => aws<{ Attributes: Record<string, string> }>("sqs", "get-queue-attributes", "--queue-url", q?.QueueUrl ?? "", "--attribute-names", "All");
  try {
    const before = (await read())?.Attributes ?? {};
    await page.goto(`/sqs/queues/${name}`);
    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
    await expect(page.getByTestId("field-visibilityTimeout")).toHaveValue("77");
    await expect(page.getByTestId("field-delaySeconds")).toHaveValue("5");
    await expect(page.getByTestId("field-enableDlq")).toBeChecked();
    await expect(page.getByTestId("field-dlqArn")).toHaveValue(before.RedrivePolicy ? JSON.parse(before.RedrivePolicy).deadLetterTargetArn : dlqArn);
    await expect(page.getByTestId("field-maxReceiveCount")).toHaveValue("7");
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("No changes to save");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    const after = (await read())?.Attributes ?? {};
    for (const k of ["VisibilityTimeout", "DelaySeconds", "MessageRetentionPeriod", "RedrivePolicy", "LastModifiedTimestamp"]) expect(after[k]).toBe(before[k]);

    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Edit tags" }).click();
    await expect(page.getByLabel("Tags key 1")).toHaveValue("env");
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("No tag changes");
    const tags = await aws<{ Tags: Record<string, string> }>("sqs", "list-queue-tags", "--queue-url", q?.QueueUrl ?? "");
    expect(tags?.Tags).toEqual({ env: "prod", team: "data" });
  } finally {
    await aws("sqs", "delete-queue", "--queue-url", q?.QueueUrl ?? "");
    await aws("sqs", "delete-queue", "--queue-url", dlq?.QueueUrl ?? "");
  }
});
