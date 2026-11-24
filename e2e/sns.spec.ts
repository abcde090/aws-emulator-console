import { expect, test } from "@playwright/test";
import { aws, uniqueName } from "./aws-cli";

const ACCOUNT = "000000000000";

test("SNS: create a topic, subscribe an SQS queue, publish and receive, delete", async ({ page }) => {
  const name = uniqueName("e2e-sns-topic");
  const queue = uniqueName("e2e-sns-queue");
  const topicArn = `arn:aws:sns:us-east-1:${ACCOUNT}:${name}`;
  const queueArn = `arn:aws:sqs:us-east-1:${ACCOUNT}:${queue}`;
  // The queue policy lets SNS deliver, as on real AWS.
  const policy = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "sns.amazonaws.com" }, Action: "sqs:SendMessage", Resource: queueArn }] };
  const created = await aws<{ QueueUrl: string }>("sqs", "create-queue", "--queue-name", queue, "--attributes", JSON.stringify({ Policy: JSON.stringify(policy) }));
  const queueUrl = created?.QueueUrl ?? "";
  try {
    await page.goto("/sns/topics");
    await expect(page.getByRole("heading", { name: /^Topics/ })).toBeVisible();
    await page.getByRole("link", { name: "Create topic" }).first().click();
    await expect(page.getByTestId("create-form")).toBeVisible();
    await page.getByRole("radio", { name: /^Standard/ }).check();
    await page.getByLabel("Name", { exact: true }).fill(name);
    await page.getByLabel("Display name - optional").fill("E2E topic");
    await page.getByRole("button", { name: "Create topic" }).click();

    await expect(page.getByTestId("flash")).toContainText("Created topic");
    await expect(page.getByTestId("kv-Name")).toHaveText(name);
    await expect(page.getByTestId("kv-Type")).toHaveText("Standard");
    await expect(page.getByTestId("kv-Display name")).toHaveText("E2E topic");

    const topics = await aws<{ Topics?: { TopicArn: string }[] }>("sns", "list-topics");
    expect(topics?.Topics?.some((t) => t.TopicArn === topicArn)).toBe(true);

    // Subscribe the queue.
    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Create subscription" }).click();
    await page.getByRole("dialog").getByLabel("Protocol").selectOption("sqs");
    await page.getByRole("dialog").getByLabel("Endpoint", { exact: true }).selectOption({ label: queue });
    await page.getByText("Enable raw message delivery").click();
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("Subscription created");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();

    // Publish, then read it from the queue.
    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Publish message" }).click();
    await page.getByLabel("Message body").fill("hello from e2e sns");
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("Message published");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();

    await expect
      .poll(async () => {
        const r = await aws<{ Messages?: { Body: string }[] }>("sqs", "receive-message", "--queue-url", queueUrl, "--wait-time-seconds", "2");
        return (r?.Messages ?? []).map((m) => m.Body).join("\n");
      }, { timeout: 20_000 })
      .toContain("hello from e2e sns");

    await page.reload();
    await page.getByRole("tab", { name: /Subscriptions \(1\)/ }).click();
    await expect(page.getByText(queueArn).first()).toBeVisible();

    // Delete the topic from the list.
    await page.goto("/sns/topics");
    const row = page.getByTestId("resource-table").getByRole("row", { name: new RegExp(name) });
    await expect(row).toBeVisible();
    await row.getByRole("radio").check();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill("delete");
    await page.getByTestId("confirm-delete").click();
    await expect(page.getByTestId("resource-table").getByRole("row", { name: new RegExp(name) })).toHaveCount(0);

    const after = await aws<{ Topics?: { TopicArn: string }[] }>("sns", "list-topics");
    expect(after?.Topics?.some((t) => t.TopicArn === topicArn)).toBe(false);
  } finally {
    const subs = await aws<{ Subscriptions?: { SubscriptionArn: string; TopicArn: string }[] }>("sns", "list-subscriptions").catch(() => null);
    for (const s of subs?.Subscriptions ?? []) if (s.TopicArn === topicArn && s.SubscriptionArn.startsWith("arn:")) await aws("sns", "unsubscribe", "--subscription-arn", s.SubscriptionArn).catch(() => null);
    await aws("sns", "delete-topic", "--topic-arn", topicArn).catch(() => null);
    if (queueUrl) await aws("sqs", "delete-queue", "--queue-url", queueUrl).catch(() => null);
  }
});

test("SNS: Edit dialogs open with the current values and saving unchanged changes nothing", async ({ page }) => {
  const name = uniqueName("fix-sns-edit");
  const queue = uniqueName("fix-sns-edit-q");
  const delivery = { http: { defaultHealthyRetryPolicy: { numRetries: 5, minDelayTarget: 20, maxDelayTarget: 20 } } };
  const topic = await aws<{ TopicArn: string }>("sns", "create-topic", "--name", name, "--attributes", JSON.stringify({ DisplayName: "Fix display", KmsMasterKeyId: "alias/fix-key", DeliveryPolicy: JSON.stringify(delivery) }), "--tags", "Key=env,Value=prod", "Key=team,Value=blue");
  const topicArn = topic?.TopicArn ?? "";
  const created = await aws<{ QueueUrl: string }>("sqs", "create-queue", "--queue-name", queue);
  const queueUrl = created?.QueueUrl ?? "";
  const queueArn = `arn:aws:sqs:us-east-1:${ACCOUNT}:${queue}`;
  let subArn = "";
  try {
    const sub = await aws<{ SubscriptionArn: string }>("sns", "subscribe", "--topic-arn", topicArn, "--protocol", "sqs", "--notification-endpoint", queueArn, "--return-subscription-arn",
      "--attributes", JSON.stringify({ RawMessageDelivery: "true", FilterPolicy: JSON.stringify({ eventType: ["order_placed"] }), RedrivePolicy: JSON.stringify({ deadLetterTargetArn: queueArn }) }));
    subArn = sub?.SubscriptionArn ?? "";
    const topicBefore = (await aws<{ Attributes: Record<string, string> }>("sns", "get-topic-attributes", "--topic-arn", topicArn))?.Attributes ?? {};
    const subBefore = (await aws<{ Attributes: Record<string, string> }>("sns", "get-subscription-attributes", "--subscription-arn", subArn))?.Attributes ?? {};

    await page.goto(`/sns/topics/${encodeURIComponent(topicArn)}`);
    const dialog = page.getByRole("dialog");
    const openAction = async (label: string) => {
      await page.getByRole("button", { name: "Actions" }).click();
      await page.getByRole("menuitem", { name: label }).click();
    };
    const saveExpecting = async (text: RegExp) => {
      await page.getByTestId("action-submit").click();
      await expect(dialog.getByTestId("flash")).toContainText(text);
      await page.getByRole("button", { name: "Close", exact: true }).last().click();
    };

    await openAction("Edit display name");
    await expect(dialog.getByTestId("field-displayName")).toHaveValue("Fix display");
    await saveExpecting(/No changes/);

    await openAction("Edit encryption");
    await expect(dialog.getByTestId("field-encryption")).toBeChecked();
    await expect(dialog.getByTestId("field-kmsKey")).toHaveValue("alias/fix-key");
    await saveExpecting(/No changes/);

    await openAction("Edit delivery policy");
    await expect(dialog.getByTestId("field-policy")).toHaveValue(/"numRetries": 5/);
    await saveExpecting(/No changes/);

    await openAction("Manage tags");
    await expect(dialog.getByLabel("Tags key 1")).toHaveValue(/env|team/);
    await expect(dialog.getByLabel("Tags key 2")).toHaveValue(/env|team/);
    await saveExpecting(/No tag changes/);

    // Subscription edit.
    await page.goto(`/sns/subscriptions/${encodeURIComponent(subArn)}`);
    await expect(page.getByTestId("kv-Raw message delivery")).toHaveText("Enabled");
    await openAction("Edit");
    await expect(dialog.getByTestId("field-rawMessageDelivery")).toBeChecked();
    await expect(dialog.getByTestId("field-filterPolicy")).toHaveValue(/order_placed/);
    await expect(dialog.getByTestId("field-dlqArn")).toHaveValue(queueArn);
    await saveExpecting(/No changes/);
    await expect(page.getByRole("button", { name: "Actions" })).toBeEnabled();
    await page.getByRole("button", { name: "Actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Confirm subscription" })).toHaveCount(0);
    await page.keyboard.press("Escape");

    const topicAfter = (await aws<{ Attributes: Record<string, string> }>("sns", "get-topic-attributes", "--topic-arn", topicArn))?.Attributes ?? {};
    for (const key of ["DisplayName", "KmsMasterKeyId", "DeliveryPolicy", "Policy"]) expect(topicAfter[key], key).toBe(topicBefore[key]);
    const tags = await aws<{ Tags: { Key: string; Value: string }[] }>("sns", "list-tags-for-resource", "--resource-arn", topicArn);
    expect((tags?.Tags ?? []).map((t) => `${t.Key}=${t.Value}`).sort()).toEqual(["env=prod", "team=blue"]);
    const subAfter = (await aws<{ Attributes: Record<string, string> }>("sns", "get-subscription-attributes", "--subscription-arn", subArn))?.Attributes ?? {};
    for (const key of ["RawMessageDelivery", "FilterPolicy", "FilterPolicyScope", "RedrivePolicy", "DeliveryPolicy"]) expect(subAfter[key], key).toBe(subBefore[key]);

    // A real edit still goes through: change only the display name.
    await page.goto(`/sns/topics/${encodeURIComponent(topicArn)}`);
    await openAction("Edit display name");
    await dialog.getByTestId("field-displayName").fill("Fix renamed");
    await saveExpecting(/Display name updated/);
    const renamed = (await aws<{ Attributes: Record<string, string> }>("sns", "get-topic-attributes", "--topic-arn", topicArn))?.Attributes ?? {};
    expect(renamed.DisplayName).toBe("Fix renamed");
    expect(renamed.KmsMasterKeyId).toBe("alias/fix-key");
  } finally {
    if (subArn.startsWith("arn:")) await aws("sns", "unsubscribe", "--subscription-arn", subArn).catch(() => null);
    if (topicArn) await aws("sns", "delete-topic", "--topic-arn", topicArn).catch(() => null);
    if (queueUrl) await aws("sqs", "delete-queue", "--queue-url", queueUrl).catch(() => null);
  }
});
