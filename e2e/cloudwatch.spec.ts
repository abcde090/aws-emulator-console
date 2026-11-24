import { expect, test, type Page } from "@playwright/test";
import { aws, uniqueName } from "./aws-cli";

async function deleteFromDetail(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByLabel("Confirm deletion").fill("delete");
  await page.getByTestId("confirm-delete").click();
}

async function runAction(page: Page, label: string): Promise<void> {
  await page.getByRole("button", { name: "Actions" }).click();
  await page.getByRole("menuitem", { name: label }).click();
}

test("CloudWatch Logs: create a log group, set retention, read events, delete it", async ({ page }) => {
  const name = `/e2e-cloudwatch/${uniqueName("lg")}`;
  try {
    await page.goto("/cloudwatch/log-groups");
    await expect(page.getByRole("heading", { name: /^Log groups/ })).toBeVisible();
    await page.getByRole("link", { name: "Create log group" }).first().click();
    await page.getByLabel("Log group name").fill(name);
    await page.getByLabel(/^Retention setting/).selectOption({ label: "7 days" });
    await page.getByRole("button", { name: "Create log group" }).click();

    await expect(page.getByTestId("flash")).toContainText(`Created log group ${name}`);
    await expect(page.getByTestId("kv-Log group name")).toHaveText(name);
    await expect(page.getByTestId("kv-Retention")).toHaveText("7 days");
    const listed = await aws<{ logGroups: { logGroupName: string; retentionInDays?: number }[] }>("logs", "describe-log-groups", "--log-group-name-prefix", name);
    expect(listed?.logGroups.find((g) => g.logGroupName === name)?.retentionInDays).toBe(7);

    // Action: change retention.
    await runAction(page, "Edit retention setting");
    await page.getByLabel("Expire events after").selectOption({ label: "1 month" });
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog")).toContainText("Retention for");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    await expect(page.getByTestId("kv-Retention")).toHaveText("1 month");

    // Events written with the CLI show up in the Log events viewer, filtered.
    await aws("logs", "create-log-stream", "--log-group-name", name, "--log-stream-name", "s1");
    const now = Date.now();
    await aws("logs", "put-log-events", "--log-group-name", name, "--log-stream-name", "s1", "--log-events", JSON.stringify([{ timestamp: now, message: "e2e ERROR boom" }, { timestamp: now, message: "e2e all good" }]));
    await page.reload();
    await page.getByRole("tab", { name: "Log events" }).click();
    await page.getByLabel("Filter events").fill("ERROR");
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page.getByTestId("log-events")).toContainText("e2e ERROR boom");
    await expect(page.getByTestId("log-events")).not.toContainText("e2e all good");

    // The list shows it.
    await page.goto("/cloudwatch/log-groups");
    // The shared emulator can hold more log groups than one table page: filter to ours.
    await page.getByLabel("Find log groups").fill(name);
    await expect(page.getByTestId("resource-table").getByRole("row", { name: new RegExp(name) })).toBeVisible();
    await page.getByTestId("resource-table").getByRole("link", { name }).click();
    await expect(page.getByTestId("kv-Log group name")).toHaveText(name);
    await deleteFromDetail(page);
    await expect(page).toHaveURL(/\/cloudwatch\/log-groups\?deleted=/);
    const after = await aws<{ logGroups: unknown[] }>("logs", "describe-log-groups", "--log-group-name-prefix", name);
    expect(after?.logGroups ?? []).toHaveLength(0);
  } finally {
    await aws("logs", "delete-log-group", "--log-group-name", name).catch(() => null);
  }
});

test("CloudWatch alarms: create a static threshold alarm, set its state, delete it", async ({ page }) => {
  const name = uniqueName("e2e-cloudwatch-alarm");
  try {
    await page.goto("/cloudwatch/alarms/create");
    await page.getByLabel("Namespace").fill("E2E/CloudWatch");
    await page.getByLabel("Metric name").fill("Latency");
    await page.getByLabel(/^Dimensions/).fill("Host=web-1");
    await page.getByLabel("than...").fill("100");
    await page.getByLabel(/^Missing data treatment/).selectOption("notBreaching");
    await page.getByLabel("Alarm name").fill(name);
    await page.getByRole("button", { name: "Create alarm" }).click();

    await expect(page.getByTestId("kv-Name")).toHaveText(name);
    await expect(page.getByTestId("kv-Type")).toHaveText("Metric alarm");
    const cli = await aws<{ MetricAlarms: { AlarmName: string; Threshold: number; TreatMissingData: string }[] }>("cloudwatch", "describe-alarms", "--alarm-names", name);
    expect(cli?.MetricAlarms[0]?.Threshold).toBe(100);
    expect(cli?.MetricAlarms[0]?.TreatMissingData).toBe("notBreaching");

    await runAction(page, "Set alarm state");
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog")).toContainText("set to ALARM");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    await expect(page.getByTestId("kv-State")).toHaveText("ALARM");
    await page.getByRole("tab", { name: "History" }).click();
    await expect(page.getByText(/to ALARM/).first()).toBeVisible();

    await page.goto("/cloudwatch/alarms");
    const row = page.getByTestId("resource-table").getByRole("row", { name: new RegExp(name) });
    await expect(row).toContainText("ALARM");
    await row.getByRole("radio").check();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill("delete");
    await page.getByTestId("confirm-delete").click();
    await expect(page.getByTestId("flash")).toContainText(`Deleted alarm ${name}`);
    const after = await aws<{ MetricAlarms: unknown[] }>("cloudwatch", "describe-alarms", "--alarm-names", name);
    expect(after?.MetricAlarms ?? []).toHaveLength(0);
  } finally {
    await aws("cloudwatch", "delete-alarms", "--alarm-names", name).catch(() => null);
  }
});

test("CloudWatch metrics and dashboards: graph a metric, render it on a dashboard", async ({ page }) => {
  const ns = "E2E/CloudWatchSpec";
  const dash = uniqueName("e2e-cloudwatch-dash");
  await aws("cloudwatch", "put-metric-data", "--namespace", ns, "--metric-name", "Requests", "--dimensions", "Service=e2e", "--value", "42");
  try {
    await page.goto("/cloudwatch/metrics");
    await page.getByRole("button", { name: new RegExp(`^${ns.replace("/", "\\/")}`) }).click();
    await page.getByTestId("metrics-explorer").getByRole("button", { name: "Service", exact: true }).click();
    await page.getByRole("checkbox", { name: /Graph Requests Service=e2e/ }).check();
    await expect(page.getByTestId("metric-chart")).toContainText("Requests");
    await expect(page.getByTestId("metric-chart").locator("circle, path[stroke]")).not.toHaveCount(0);
    await page.getByRole("tab", { name: /Graphed metrics/ }).click();
    await page.getByLabel("Math expression").fill("m1 * 2");
    await page.getByRole("button", { name: "Add math expression" }).click();
    await expect(page.getByTestId("graphed-metrics")).toContainText("m1 * 2");
    await expect(page.getByTestId("metric-chart").getByLabel("Legend")).toContainText("m1 * 2");

    const body = JSON.stringify({ widgets: [{ type: "metric", x: 0, y: 0, width: 12, height: 6, properties: { metrics: [[ns, "Requests", "Service", "e2e"]], stat: "Sum", period: 60, region: "us-east-1", title: "E2E requests" } }] });
    await page.goto("/cloudwatch/dashboards/create");
    await page.getByLabel("Dashboard name").fill(dash);
    await page.getByLabel("Dashboard body (source)").fill(body);
    await page.getByRole("button", { name: "Create dashboard" }).click();
    await expect(page.getByTestId("flash")).toContainText(`Created dashboard ${dash}`);
    await expect(page.getByTestId("dashboard-widgets")).toContainText("E2E requests");
    await expect(page.getByTestId("dashboard-widgets").getByTestId("metric-chart")).toBeVisible();
    const cli = await aws<{ DashboardName: string }>("cloudwatch", "get-dashboard", "--dashboard-name", dash);
    expect(cli?.DashboardName).toBe(dash);
    await deleteFromDetail(page);
    await expect(page).toHaveURL(/\/cloudwatch\/dashboards\?deleted=/);
  } finally {
    await aws("cloudwatch", "delete-dashboards", "--dashboard-names", dash).catch(() => null);
  }
});

test("CloudWatch: Edit dialogs show current values and saving unchanged changes nothing", async ({ page }) => {
  const group = `/fix-cloudwatch/${uniqueName("lg")}`;
  const dash = uniqueName("fix-cloudwatch-dash");
  const alarm = uniqueName("fix-cloudwatch-alarm");
  const topicName = uniqueName("fix-cloudwatch-topic");
  let topicArn = "";
  const body = { widgets: [{ type: "text", x: 0, y: 0, width: 6, height: 3, properties: { markdown: "fix cloudwatch" } }] };
  const saveUnchanged = async () => {
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toBeVisible();
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
  };
  try {
    // Log group retention.
    await aws("logs", "create-log-group", "--log-group-name", group);
    await aws("logs", "put-retention-policy", "--log-group-name", group, "--retention-in-days", "7");
    await page.goto(`/cloudwatch/log-groups/${encodeURIComponent(group)}`);
    await runAction(page, "Edit retention setting");
    await expect(page.getByTestId("field-retention")).toHaveValue("7");
    await saveUnchanged();
    const lg = await aws<{ logGroups: { logGroupName: string; retentionInDays?: number }[] }>("logs", "describe-log-groups", "--log-group-name-prefix", group);
    expect(lg?.logGroups.find((g) => g.logGroupName === group)?.retentionInDays).toBe(7);

    // Dashboard source.
    await aws("cloudwatch", "put-dashboard", "--dashboard-name", dash, "--dashboard-body", JSON.stringify(body));
    await page.goto(`/cloudwatch/dashboards/${encodeURIComponent(dash)}`);
    await runAction(page, "Edit source");
    await expect(page.getByTestId("field-body")).toHaveValue(/fix cloudwatch/);
    await saveUnchanged();
    const d = await aws<{ DashboardBody: string }>("cloudwatch", "get-dashboard", "--dashboard-name", dash);
    expect(JSON.parse(d?.DashboardBody ?? "{}")).toEqual(body);

    // Alarm actions: the SNS topic and description are prefilled; only the applicable toggle is offered.
    topicArn = (await aws<{ TopicArn: string }>("sns", "create-topic", "--name", topicName))?.TopicArn ?? "";
    await aws(
      "cloudwatch", "put-metric-alarm", "--alarm-name", alarm, "--alarm-description", "fix desc", "--namespace", "FixNs", "--metric-name", "FixMetric",
      "--statistic", "Average", "--period", "300", "--evaluation-periods", "2", "--datapoints-to-alarm", "1", "--threshold", "5",
      "--comparison-operator", "GreaterThanThreshold", "--alarm-actions", topicArn
    );
    await page.goto(`/cloudwatch/alarms/${encodeURIComponent(alarm)}`);
    await page.getByRole("button", { name: "Actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Disable actions" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Enable actions" })).toHaveCount(0);
    await page.getByRole("menuitem", { name: "Edit actions" }).click();
    await expect(page.getByTestId("field-description")).toHaveValue("fix desc");
    await expect(page.getByTestId("field-alarmTopics")).toHaveValues([topicArn]);
    await saveUnchanged();
    type A = { MetricAlarms: { AlarmDescription?: string; AlarmActions?: string[]; ActionsEnabled?: boolean; Threshold?: number; EvaluationPeriods?: number; DatapointsToAlarm?: number }[] };
    const a = (await aws<A>("cloudwatch", "describe-alarms", "--alarm-names", alarm))?.MetricAlarms[0];
    expect(a?.AlarmDescription).toBe("fix desc");
    expect(a?.AlarmActions).toEqual([topicArn]);
    expect(a?.ActionsEnabled).toBe(true);
    expect(a?.Threshold).toBe(5);
    expect(a?.EvaluationPeriods).toBe(2);
    expect(a?.DatapointsToAlarm).toBe(1);
  } finally {
    await aws("logs", "delete-log-group", "--log-group-name", group).catch(() => null);
    await aws("cloudwatch", "delete-dashboards", "--dashboard-names", dash).catch(() => null);
    await aws("cloudwatch", "delete-alarms", "--alarm-names", alarm).catch(() => null);
    if (topicArn) await aws("sns", "delete-topic", "--topic-arn", topicArn).catch(() => null);
  }
});

test("CloudWatch dashboards: alarm widgets show alarm states and log widgets run their Logs Insights query", async ({ page }) => {
  const dash = uniqueName("e2e-dash-widgets");
  const alarm = uniqueName("e2e-dash-alarm");
  const group = `/e2e/${uniqueName("dash-logs")}`;
  const missingGroup = `/e2e/${uniqueName("dash-missing")}`;
  try {
    await aws("cloudwatch", "put-metric-alarm", "--alarm-name", alarm, "--namespace", "E2E/Dash", "--metric-name", "Errors", "--statistic", "Sum", "--period", "60", "--evaluation-periods", "1", "--threshold", "1", "--comparison-operator", "GreaterThanOrEqualToThreshold");
    await aws("cloudwatch", "set-alarm-state", "--alarm-name", alarm, "--state-value", "ALARM", "--state-reason", "e2e");
    await aws("logs", "create-log-group", "--log-group-name", group);
    await aws("logs", "create-log-stream", "--log-group-name", group, "--log-stream-name", "s1");
    await aws("logs", "put-log-events", "--log-group-name", group, "--log-stream-name", "s1", "--log-events", JSON.stringify([{ timestamp: Date.now() - 60_000, message: "dashboard widget hello" }]));
    const arn = `arn:aws:cloudwatch:us-east-1:000000000000:alarm:${alarm}`;
    const body = {
      widgets: [
        { type: "alarm", x: 0, y: 0, width: 12, height: 3, properties: { title: "E2E alarms", alarms: [arn] } },
        { type: "log", x: 0, y: 3, width: 24, height: 6, properties: { title: "E2E logs", region: "us-east-1", view: "table", query: `SOURCE '${group}' | fields @timestamp, @message | sort @timestamp desc | limit 20` } },
        { type: "log", x: 0, y: 9, width: 24, height: 6, properties: { title: "E2E broken", region: "us-east-1", query: `SOURCE '${missingGroup}' | fields @message` } },
      ],
    };
    await aws("cloudwatch", "put-dashboard", "--dashboard-name", dash, "--dashboard-body", JSON.stringify(body));

    await page.goto(`/cloudwatch/dashboards/${encodeURIComponent(dash)}`);
    const widgets = page.getByTestId("dashboard-widgets");
    await expect(widgets.getByTestId(`alarm-status-${alarm}`)).toContainText("ALARM");
    const state = await aws<{ MetricAlarms: { StateValue: string }[] }>("cloudwatch", "describe-alarms", "--alarm-names", alarm);
    expect(state?.MetricAlarms[0].StateValue).toBe("ALARM");

    const logs = widgets.getByTestId("widget-log").first();
    await expect(logs.getByTestId("log-widget-table")).toContainText("dashboard widget hello", { timeout: 30_000 });
    // A query the emulator can't run shows its error inside the widget.
    await expect(widgets.getByTestId("widget-log").nth(1).getByTestId("error-banner")).toBeVisible({ timeout: 30_000 });
  } finally {
    await aws("cloudwatch", "delete-dashboards", "--dashboard-names", dash).catch(() => null);
    await aws("cloudwatch", "delete-alarms", "--alarm-names", alarm).catch(() => null);
    await aws("logs", "delete-log-group", "--log-group-name", group).catch(() => null);
  }
});
