import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { aws, uniqueName } from "./aws-cli";

test("X-Ray groups: create a group, edit its filter, delete it", async ({ page }) => {
  const name = uniqueName("e2e-xray").slice(0, 32);
  try {
    await page.goto("/xray/groups");
    await expect(page.getByRole("heading", { name: /^Groups/ })).toBeVisible();
    await page.getByRole("link", { name: "Create group" }).first().click();
    await page.getByLabel("Group name").fill(name);
    await page.getByLabel("Filter expression", { exact: true }).fill('service("e2e-xray-svc")');
    await page.getByRole("button", { name: "Create group" }).click();
    await expect(page.getByTestId("flash")).toContainText(`Created group ${name}`);
    await expect(page.getByTestId("kv-Filter expression")).toHaveText('service("e2e-xray-svc")');

    const cli = await aws<{ Group: { FilterExpression: string } }>("xray", "get-group", "--group-name", name);
    expect(cli?.Group.FilterExpression).toBe('service("e2e-xray-svc")');

    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Edit filter expression" }).click();
    await page.getByLabel("Filter expression", { exact: true }).fill("responsetime > 1");
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog")).toContainText(`Group ${name} updated`);
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    await expect(page.getByTestId("kv-Filter expression")).toHaveText("responsetime > 1");

    await page.goto("/xray/groups");
    const row = page.getByTestId("resource-table").getByRole("row", { name: new RegExp(name) });
    await expect(row).toBeVisible();
    await row.getByRole("radio").check();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill("delete");
    await page.getByTestId("confirm-delete").click();
    await expect(page.getByTestId("flash")).toContainText(`Deleted group ${name}`);
    const after = await aws<{ Groups: { GroupName: string }[] }>("xray", "get-groups");
    expect(after?.Groups.some((g) => g.GroupName === name)).toBe(false);
  } finally {
    await aws("xray", "delete-group", "--group-name", name).catch(() => null);
  }
});

test("X-Ray traces: filter by service and open the segment timeline", async ({ page }) => {
  const svc = uniqueName("e2e-xray-svc");
  const now = Date.now() / 1000;
  const traceId = `1-${Math.floor(now).toString(16)}-${randomBytes(12).toString("hex")}`;
  const doc = { trace_id: traceId, id: randomBytes(8).toString("hex"), name: svc, start_time: now - 1, end_time: now, http: { request: { method: "POST", url: "https://shop/checkout" }, response: { status: 500 } }, fault: true, subsegments: [{ id: randomBytes(8).toString("hex"), name: "e2e-db-call", start_time: now - 0.9, end_time: now - 0.4 }] };
  await aws("xray", "put-trace-segments", "--trace-segment-documents", JSON.stringify(doc));

  await page.goto("/xray/traces");
  await page.getByLabel("Filter expression", { exact: true }).fill(`service("${svc}")`);
  await page.getByLabel("Time range").selectOption({ label: "Last 15 minutes" });
  await page.getByRole("button", { name: "Run query" }).click();
  const table = page.getByTestId("trace-table");
  await expect(table).toContainText(traceId);
  await expect(table).toContainText("Fault");
  await expect(page.getByTestId("trace-table").getByRole("row")).toHaveCount(2);
  await table.getByRole("link", { name: traceId }).click();
  await expect(page.getByTestId("kv-Root segment")).toHaveText(svc);
  const timeline = page.getByTestId("trace-timeline");
  await expect(timeline).toContainText("e2e-db-call");
  await expect(timeline).toContainText("Fault");
});

test("X-Ray: Edit dialogs show current values and saving unchanged changes nothing", async ({ page }) => {
  const group = uniqueName("fix-xray").slice(0, 32);
  const rule = uniqueName("fix-xray").slice(0, 32);
  const save = async () => {
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toBeVisible();
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
  };
  try {
    await aws("xray", "create-group", "--group-name", group, "--filter-expression", 'service("fix-xray-svc")');
    await page.goto(`/xray/groups/${group}`);
    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Edit filter expression" }).click();
    await expect(page.getByTestId("field-filter")).toHaveValue('service("fix-xray-svc")');
    await save();
    expect((await aws<{ Group: { FilterExpression: string } }>("xray", "get-group", "--group-name", group))?.Group.FilterExpression).toBe('service("fix-xray-svc")');

    await aws(
      "xray", "create-sampling-rule", "--sampling-rule",
      JSON.stringify({ RuleName: rule, Priority: 4321, ReservoirSize: 7, FixedRate: 0.25, ServiceName: "*", ServiceType: "*", Host: "*", HTTPMethod: "*", URLPath: "*", ResourceARN: "*", Version: 1 })
    );
    await page.goto(`/xray/sampling-rules/${rule}`);
    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Edit limits" }).click();
    await expect(page.getByTestId("field-priority")).toHaveValue("4321");
    await expect(page.getByTestId("field-reservoir")).toHaveValue("7");
    await expect(page.getByTestId("field-rate")).toHaveValue("0.25");
    await save();
    type R = { SamplingRuleRecords: { SamplingRule: { RuleName: string; Priority: number; ReservoirSize: number; FixedRate: number } }[] };
    const r = (await aws<R>("xray", "get-sampling-rules"))?.SamplingRuleRecords.find((x) => x.SamplingRule.RuleName === rule)?.SamplingRule;
    expect(r).toMatchObject({ Priority: 4321, ReservoirSize: 7, FixedRate: 0.25 });

    // The Default group can't be edited, so Edit filter expression isn't offered there.
    await page.goto("/xray/groups/Default");
    await expect(page.getByTestId("kv-Group name")).toHaveText("Default");
    await expect(page.getByTestId("actions-menu")).toHaveCount(0);
    // Nor can the Default group or the Default sampling rule be deleted (OG-9): no Delete button.
    await expect(page.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
    await page.goto("/xray/sampling-rules/Default");
    await expect(page.getByTestId("kv-Name")).toHaveText("Default");
    await expect(page.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
    await page.goto(`/xray/sampling-rules/${rule}`);
    await expect(page.getByRole("button", { name: "Delete", exact: true })).toBeVisible();
  } finally {
    await aws("xray", "delete-group", "--group-name", group).catch(() => null);
    await aws("xray", "delete-sampling-rule", "--rule-name", rule).catch(() => null);
  }
});
