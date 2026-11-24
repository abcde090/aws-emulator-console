import { expect, test, type Page } from "@playwright/test";
import { aws, uniqueName } from "./aws-cli";

const ACCOUNT = "000000000000";

async function runAction(page: Page, label: string) {
  await page.getByRole("button", { name: "Actions" }).click();
  await page.getByRole("menuitem", { name: label }).click();
}

async function closeDialog(page: Page) {
  await page.getByRole("button", { name: "Close", exact: true }).last().click();
}

test("EventBridge: custom bus, rule with an SQS target, send events, test pattern, disable, delete", async ({ page }) => {
  const bus = uniqueName("e2e-eventbridge-bus");
  const rule = uniqueName("e2e-eventbridge-rule");
  const queue = uniqueName("e2e-eventbridge-q");
  const queueArn = `arn:aws:sqs:us-east-1:${ACCOUNT}:${queue}`;
  const ruleArn = `arn:aws:events:us-east-1:${ACCOUNT}:rule/${bus}/${rule}`;
  const policy = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "events.amazonaws.com" }, Action: "sqs:SendMessage", Resource: queueArn }] };
  const created = await aws<{ QueueUrl: string }>("sqs", "create-queue", "--queue-name", queue, "--attributes", JSON.stringify({ Policy: JSON.stringify(policy) }));
  const queueUrl = created?.QueueUrl ?? "";
  try {
    // Event bus.
    await page.goto("/eventbridge/event-buses");
    await expect(page.getByRole("heading", { name: /^Event buses/ })).toBeVisible();
    await page.getByRole("link", { name: "Create event bus" }).first().click();
    await page.getByLabel("Name", { exact: true }).fill(bus);
    await page.getByLabel("Description - optional").fill("e2e bus");
    await page.getByRole("button", { name: "Create event bus" }).click();
    await expect(page.getByTestId("flash")).toContainText(`Created event bus ${bus}`);
    await expect(page.getByTestId("kv-Description")).toHaveText("e2e bus");
    const buses = await aws<{ EventBuses?: { Name: string }[] }>("events", "list-event-buses");
    expect(buses?.EventBuses?.some((b) => b.Name === bus)).toBe(true);

    // Rule with the pattern form and an SQS target.
    await page.goto("/eventbridge/rules/create");
    await page.getByLabel("Name", { exact: true }).fill(rule);
    await page.getByLabel("Event bus", { exact: true }).selectOption(bus);
    await page.getByLabel("Event source").fill("e2e.orders");
    await page.getByLabel("Event type (detail-type) - optional").fill("Order Placed");
    await page.getByLabel("Target type").selectOption("sqs");
    await page.getByLabel("Queue", { exact: true }).selectOption({ label: queue });
    await page.getByRole("button", { name: "Create rule" }).click();
    await expect(page.getByTestId("kv-Name")).toHaveText(rule);
    await expect(page.getByTestId("kv-Status")).toContainText("ENABLED");
    await page.getByRole("tab", { name: /Targets \(1\)/ }).click();
    await expect(page.getByText(queueArn).first()).toBeVisible();
    const rules = await aws<{ Rules?: { Name: string; EventPattern?: string }[] }>("events", "list-rules", "--event-bus-name", bus);
    expect(rules?.Rules?.find((r) => r.Name === rule)?.EventPattern).toContain("e2e.orders");

    // Test the pattern.
    await runAction(page, "Test event pattern");
    await page.getByRole("dialog").getByLabel("Sample event (JSON)").fill(JSON.stringify({ id: "1", account: ACCOUNT, source: "e2e.orders", time: "2026-01-01T00:00:00Z", region: "us-east-1", resources: [], "detail-type": "Order Placed", detail: {} }));
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("matched the event pattern");
    await closeDialog(page);

    // Send an event from the bus page and receive it from the queue.
    await page.goto(`/eventbridge/event-buses/${bus}`);
    await runAction(page, "Send events");
    await page.getByLabel("Event source").fill("e2e.orders");
    await page.getByLabel("Detail type").fill("Order Placed");
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("Event sent successfully");
    await closeDialog(page);
    await expect
      .poll(async () => {
        const r = await aws<{ Messages?: { Body: string }[] }>("sqs", "receive-message", "--queue-url", queueUrl, "--wait-time-seconds", "2");
        return (r?.Messages ?? []).map((m) => m.Body).join("\n");
      }, { timeout: 20_000 })
      .toContain("e2e.orders");

    // Disable, then delete the rule from the list (the console removes its targets first).
    await page.goto(`/eventbridge/rules/${encodeURIComponent(ruleArn)}`);
    await runAction(page, "Disable");
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("disabled");
    await closeDialog(page);
    await expect(page.getByTestId("kv-Status")).toContainText("DISABLED");

    await page.goto("/eventbridge/rules");
    const row = page.getByTestId("resource-table").getByRole("row", { name: new RegExp(rule) });
    await row.getByRole("radio").check();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill("delete");
    await page.getByTestId("confirm-delete").click();
    await expect(page.getByTestId("resource-table").getByRole("row", { name: new RegExp(rule) })).toHaveCount(0);

    // Delete the bus from its page.
    await page.goto(`/eventbridge/event-buses/${bus}`);
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill(bus);
    await page.getByTestId("confirm-delete").click();
    await expect(page).toHaveURL(/\/eventbridge\/event-buses\?deleted=/);
    const after = await aws<{ EventBuses?: { Name: string }[] }>("events", "list-event-buses");
    expect(after?.EventBuses?.some((b) => b.Name === bus)).toBe(false);
  } finally {
    await aws("events", "remove-targets", "--rule", rule, "--event-bus-name", bus, "--ids", "Target0").catch(() => null);
    await aws("events", "delete-rule", "--name", rule, "--event-bus-name", bus).catch(() => null);
    await aws("events", "delete-event-bus", "--name", bus).catch(() => null);
    if (queueUrl) await aws("sqs", "delete-queue", "--queue-url", queueUrl).catch(() => null);
  }
});

test("EventBridge Scheduler: create a rate schedule, disable it, delete it", async ({ page }) => {
  const name = uniqueName("e2e-eventbridge-sched");
  const queue = uniqueName("e2e-eventbridge-sq");
  const role = uniqueName("e2e-eventbridge-role");
  const created = await aws<{ QueueUrl: string }>("sqs", "create-queue", "--queue-name", queue);
  const trust = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "scheduler.amazonaws.com" }, Action: "sts:AssumeRole" }] };
  await aws("iam", "create-role", "--role-name", role, "--assume-role-policy-document", JSON.stringify(trust));
  try {
    await page.goto("/eventbridge/schedules/create");
    await page.getByLabel("Schedule name").fill(name);
    await page.getByRole("radio", { name: "Recurring schedule: rate-based" }).check();
    await page.getByLabel("Rate value").fill("10");
    await page.getByLabel("SQS queue").selectOption({ label: queue });
    await page.getByLabel("Execution role").selectOption({ label: role });
    await page.getByRole("button", { name: "Create schedule" }).click();
    await expect(page.getByTestId("kv-Schedule expression")).toHaveText("rate(10 minutes)");
    const got = await aws<{ ScheduleExpression: string; State: string }>("scheduler", "get-schedule", "--name", name);
    expect(got?.ScheduleExpression).toBe("rate(10 minutes)");

    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Disable" }).click();
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("Schedule disabled");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    await expect(page.getByTestId("kv-Status")).toContainText("DISABLED");

    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill("delete");
    await page.getByTestId("confirm-delete").click();
    await expect(page).toHaveURL(/\/eventbridge\/schedules\?deleted=/);
    const list = await aws<{ Schedules?: { Name: string }[] }>("scheduler", "list-schedules");
    expect(list?.Schedules?.some((s) => s.Name === name)).toBe(false);
  } finally {
    await aws("scheduler", "delete-schedule", "--name", name).catch(() => null);
    await aws("iam", "delete-role", "--role-name", role).catch(() => null);
    if (created?.QueueUrl) await aws("sqs", "delete-queue", "--queue-url", created.QueueUrl).catch(() => null);
  }
});

test("EventBridge: Edit dialogs open with current values, saving unchanged changes nothing, state-aware actions", async ({ page }) => {
  const rule = uniqueName("fix-eventbridge-rule");
  const queue = uniqueName("fix-eventbridge-q");
  const sched = uniqueName("fix-eventbridge-sched");
  const role = uniqueName("fix-eventbridge-role");
  const archive = uniqueName("fix-eb-arch").slice(0, 48);
  const queueArn = `arn:aws:sqs:us-east-1:${ACCOUNT}:${queue}`;
  const ruleArn = `arn:aws:events:us-east-1:${ACCOUNT}:rule/${rule}`;
  const created = await aws<{ QueueUrl: string }>("sqs", "create-queue", "--queue-name", queue);
  const trust = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "scheduler.amazonaws.com" }, Action: "sts:AssumeRole" }] };
  const roleArn = (await aws<{ Role: { Arn: string } }>("iam", "create-role", "--role-name", role, "--assume-role-policy-document", JSON.stringify(trust)))?.Role.Arn ?? "";
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
  try {
    await aws("events", "put-rule", "--name", rule, "--description", "fix description", "--event-pattern", JSON.stringify({ source: ["fix.orders"], "detail-type": ["Order Placed"] }), "--tags", "Key=env,Value=prod");
    await aws("events", "put-targets", "--rule", rule, "--targets", JSON.stringify([{ Id: "first", Arn: queueArn }, { Id: "second", Arn: queueArn }]));
    const ruleBefore = await aws<Record<string, unknown>>("events", "describe-rule", "--name", rule);

    await page.goto(`/eventbridge/rules/${encodeURIComponent(ruleArn)}`);
    await expect(page.getByTestId("kv-Status")).toContainText("ENABLED");
    await page.getByRole("button", { name: "Actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Disable" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Enable", exact: true })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "Edit schedule expression" })).toHaveCount(0);
    await page.getByRole("menuitem", { name: "Edit event pattern" }).click();
    await expect(dialog.getByTestId("field-pattern")).toHaveValue(/"fix\.orders"/);
    await saveExpecting(/No changes/);

    await openAction("Edit description");
    await expect(dialog.getByTestId("field-description")).toHaveValue("fix description");
    await saveExpecting(/No changes/);

    await openAction("Manage tags");
    await expect(dialog.getByLabel("Tags key 1")).toHaveValue("env");
    await expect(dialog.getByLabel("Tags value 1")).toHaveValue("prod");
    await saveExpecting(/No tag changes/);

    expect(await aws<Record<string, unknown>>("events", "describe-rule", "--name", rule)).toEqual(ruleBefore);
    const ruleTags = await aws<{ Tags: { Key: string; Value: string }[] }>("events", "list-tags-for-resource", "--resource-arn", ruleArn);
    expect(ruleTags?.Tags).toEqual([{ Key: "env", Value: "prod" }]);

    // Remove target picks from the rule's own targets.
    await openAction("Remove target");
    const picker = dialog.getByTestId("field-targetId");
    await expect(picker.locator("option")).toHaveText([/^first/, /^second/]);
    await picker.selectOption("second");
    await saveExpecting(/Target second removed/);
    const targets = await aws<{ Targets: { Id: string }[] }>("events", "list-targets-by-rule", "--rule", rule);
    expect(targets?.Targets.map((t) => t.Id)).toEqual(["first"]);

    // Scheduler: Edit schedule shows the schedule's settings; saving unchanged changes nothing.
    await aws("scheduler", "create-schedule", "--name", sched, "--description", "fix schedule", "--schedule-expression", "rate(15 minutes)", "--schedule-expression-timezone", "Australia/Sydney",
      "--flexible-time-window", JSON.stringify({ Mode: "FLEXIBLE", MaximumWindowInMinutes: 10 }),
      "--target", JSON.stringify({ Arn: queueArn, RoleArn: roleArn, Input: JSON.stringify({ job: "nightly" }), RetryPolicy: { MaximumRetryAttempts: 3, MaximumEventAgeInSeconds: 600 } }));
    const schedBefore = await aws<Record<string, unknown>>("scheduler", "get-schedule", "--name", sched);
    await page.goto(`/eventbridge/schedules/${encodeURIComponent(`default/${sched}`)}`);
    await page.getByRole("button", { name: "Actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Enable", exact: true })).toHaveCount(0);
    await page.getByRole("menuitem", { name: "Edit schedule" }).click();
    await expect(dialog.getByTestId("field-description")).toHaveValue("fix schedule");
    await expect(dialog.getByRole("radio", { name: "Recurring schedule: rate-based" })).toBeChecked();
    await expect(dialog.getByTestId("field-rateValue")).toHaveValue("15");
    await expect(dialog.getByTestId("field-rateUnit")).toHaveValue("minutes");
    await expect(dialog.getByTestId("field-timezone")).toHaveValue("Australia/Sydney");
    await expect(dialog.getByTestId("field-flex")).toHaveValue("10");
    await expect(dialog.getByTestId("field-roleArn")).toHaveValue(roleArn);
    await expect(dialog.getByTestId("field-retries")).toHaveValue("3");
    await expect(dialog.getByTestId("field-maxAge")).toHaveValue("600");
    await expect(dialog.getByTestId("field-input")).toHaveValue(/"nightly"/);
    await saveExpecting(/No changes/);
    expect(await aws<Record<string, unknown>>("scheduler", "get-schedule", "--name", sched)).toEqual(schedBefore);

    // A real edit keeps everything else.
    await openAction("Edit schedule");
    await dialog.getByTestId("field-rateValue").fill("20");
    await saveExpecting(/Schedule updated/);
    const edited = await aws<{ ScheduleExpression: string; ScheduleExpressionTimezone: string; Description: string; Target: { RetryPolicy: unknown; Input: string } }>("scheduler", "get-schedule", "--name", sched);
    expect(edited?.ScheduleExpression).toBe("rate(20 minutes)");
    expect(edited?.ScheduleExpressionTimezone).toBe("Australia/Sydney");
    expect(edited?.Description).toBe("fix schedule");
    expect(edited?.Target.RetryPolicy).toEqual({ MaximumRetryAttempts: 3, MaximumEventAgeInSeconds: 600 });

    // Archive edit.
    await aws("events", "create-archive", "--archive-name", archive, "--event-source-arn", `arn:aws:events:us-east-1:${ACCOUNT}:event-bus/default`, "--description", "fix archive", "--retention-days", "7");
    const archiveBefore = await aws<Record<string, unknown>>("events", "describe-archive", "--archive-name", archive);
    await page.goto(`/eventbridge/archives/${encodeURIComponent(archive)}`);
    await openAction("Edit archive");
    await expect(dialog.getByTestId("field-description")).toHaveValue("fix archive");
    await expect(dialog.getByTestId("field-indefinite")).not.toBeChecked();
    await expect(dialog.getByTestId("field-days")).toHaveValue("7");
    await saveExpecting(/No changes/);
    // Event count and size change as events reach the default bus; the settings must not.
    const settings = (a: Record<string, unknown> | null) => ({ Description: a?.Description, RetentionDays: a?.RetentionDays, EventPattern: a?.EventPattern, State: a?.State });
    expect(settings(await aws<Record<string, unknown>>("events", "describe-archive", "--archive-name", archive))).toEqual(settings(archiveBefore));
  } finally {
    await aws("events", "delete-archive", "--archive-name", archive).catch(() => null);
    await aws("scheduler", "delete-schedule", "--name", sched).catch(() => null);
    await aws("events", "remove-targets", "--rule", rule, "--ids", "first", "second").catch(() => null);
    await aws("events", "delete-rule", "--name", rule).catch(() => null);
    await aws("iam", "delete-role", "--role-name", role).catch(() => null);
    if (created?.QueueUrl) await aws("sqs", "delete-queue", "--queue-url", created.QueueUrl).catch(() => null);
  }
});
