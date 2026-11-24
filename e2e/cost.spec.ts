import { expect, test, type Page } from "@playwright/test";
import { aws, uniqueName } from "./aws-cli";

const ACCOUNT = "000000000000";

interface Budget {
  BudgetName: string;
  BudgetLimit?: { Amount: string };
}

async function budgetNames(): Promise<Budget[]> {
  return (await aws<{ Budgets?: Budget[] }>("budgets", "describe-budgets", "--account-id", ACCOUNT))?.Budgets ?? [];
}

async function runAction(page: Page, label: string) {
  await page.getByRole("button", { name: "Actions" }).click();
  await page.getByRole("menuitem", { name: label }).click();
}

test("Billing: create a cost budget with an alert, edit it, delete it", async ({ page }) => {
  const name = uniqueName("e2e-cost-budget");
  try {
    await page.goto("/cost/budgets");
    await expect(page.getByRole("heading", { name: /^Budgets/ })).toBeVisible();
    await page.getByRole("link", { name: "Create budget" }).first().click();
    await expect(page.getByTestId("create-form")).toBeVisible();
    await page.waitForLoadState("networkidle");
    await page.getByLabel("Budget name").fill(name);
    await page.getByLabel("Budgeted amount").fill("250");
    await page.getByLabel("Email recipients").fill("finops@example.com");
    await page.getByRole("button", { name: "Create budget" }).click();

    await expect(page).toHaveURL(new RegExp(`/cost/budgets/${name}`));
    await expect(page.getByTestId("kv-Budgeted amount")).toHaveText("$250.00");
    await expect(page.getByTestId("kv-Amount used")).toHaveText("$0.00");

    const created = (await budgetNames()).find((b) => b.BudgetName === name);
    expect(created?.BudgetLimit?.Amount).toBe("250");
    const notes = await aws<{ Notifications?: { Threshold: number }[] }>("budgets", "describe-notifications-for-budget", "--account-id", ACCOUNT, "--budget-name", name);
    expect(notes?.Notifications?.[0]?.Threshold).toBe(80);

    await page.waitForLoadState("networkidle");
    await expect(async () => {
      await page.getByRole("tab", { name: "Alerts" }).click();
      await expect(page.locator("main")).toContainText("finops@example.com", { timeout: 2_000 });
    }).toPass();

    // Edit the budgeted amount.
    await runAction(page, "Edit budgeted amount");
    await page.getByRole("dialog").getByLabel("Budgeted amount").fill("300");
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("$300.00");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    expect((await budgetNames()).find((b) => b.BudgetName === name)?.BudgetLimit?.Amount).toBe("300");

    // The list shows it; delete from the list.
    await page.goto("/cost/budgets");
    const row = page.getByTestId("resource-table").getByRole("row", { name: new RegExp(name) });
    await expect(row).toContainText("$300.00");
    await row.getByRole("radio").check();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill(name);
    await page.getByTestId("confirm-delete").click();
    await expect(page.getByTestId("flash")).toContainText(`Deleted budget ${name}`);
    expect((await budgetNames()).some((b) => b.BudgetName === name)).toBe(false);
  } finally {
    if ((await budgetNames()).some((b) => b.BudgetName === name)) await aws("budgets", "delete-budget", "--account-id", ACCOUNT, "--budget-name", name);
  }
});

test("Billing: create, rename and delete a cost anomaly monitor", async ({ page }) => {
  const name = uniqueName("e2e-cost-monitor");
  const monitors = async () => (await aws<{ AnomalyMonitors?: { MonitorArn: string; MonitorName: string }[] }>("ce", "get-anomaly-monitors"))?.AnomalyMonitors ?? [];
  try {
    await page.goto("/cost/anomaly-monitors/create");
    await page.waitForLoadState("networkidle");
    await page.getByLabel("Monitor name").fill(name);
    await page.getByRole("button", { name: "Create monitor" }).click();
    await expect(page.getByTestId("kv-Name")).toHaveText(name);
    await expect(page.getByTestId("kv-Monitor type")).toHaveText("AWS services");
    expect((await monitors()).some((m) => m.MonitorName === name)).toBe(true);

    await runAction(page, "Edit monitor name");
    await page.getByRole("dialog").getByLabel("Monitor name").fill(`${name}-2`);
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("renamed");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    await expect(page.getByTestId("kv-Name")).toHaveText(`${name}-2`);

    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill("delete");
    await page.getByTestId("confirm-delete").click();
    await expect(page).toHaveURL(/\/cost\/anomaly-monitors\?deleted=/);
    expect((await monitors()).some((m) => m.MonitorName.startsWith(name))).toBe(false);
  } finally {
    for (const m of await monitors()) if (m.MonitorName.startsWith(name)) await aws("ce", "delete-anomaly-monitor", "--monitor-arn", m.MonitorArn);
  }
});

test("Billing: Cost Explorer shows the emulator's answer to GetCostAndUsage", async ({ page }) => {
  await page.goto("/cost/cost-explorer");
  await page.waitForLoadState("networkidle");
  const notSupported = page.getByTestId("cost-not-supported");
  if (await notSupported.isVisible()) {
    // AWS Emulator answers NotImplemented today: the page says so and offers no dead Apply button.
    await expect(notSupported).toContainText("NotImplemented");
    await expect(page.getByRole("button", { name: "Apply" })).toHaveCount(0);
    return;
  }
  await page.getByLabel("Group by").selectOption("SERVICE");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByTestId("error-banner").or(page.getByTestId("cost-results")).or(page.getByTestId("empty-state"))).toBeVisible();
});

test("Billing: create, edit and delete a cost category", async ({ page }) => {
  const name = uniqueName("e2e-cost-cc");
  const categories = async () => (await aws<{ CostCategoryReferences?: { CostCategoryArn: string; Name: string; Values?: string[] }[] }>("ce", "list-cost-category-definitions"))?.CostCategoryReferences ?? [];
  try {
    await page.goto("/cost/cost-categories/create");
    await page.waitForLoadState("networkidle");
    await page.getByLabel("Cost category name").fill(name);
    await page.getByLabel("Default value").fill("Other");
    await page.getByLabel("Cost category value").fill("Prod");
    await page.getByLabel("Dimension values").fill(ACCOUNT);
    await page.getByRole("button", { name: "Create cost category" }).click();
    await expect(page.getByTestId("kv-Name")).toHaveText(name);
    await expect(page.getByTestId("kv-Default value")).toHaveText("Other");
    expect((await categories()).some((c) => c.Name === name)).toBe(true);

    await runAction(page, "Edit rules");
    await page.getByRole("dialog").getByLabel("Rules JSON").fill(JSON.stringify([{ Value: "Dev", Rule: { Dimensions: { Key: "LINKED_ACCOUNT", Values: [ACCOUNT] } } }]));
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("updated");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    await expect(async () => {
      await page.getByRole("tab", { name: "Rules" }).click();
      await expect(page.locator("main")).toContainText("LINKED_ACCOUNT", { timeout: 2_000 });
    }).toPass();
    await expect(page.locator("main")).toContainText("Dev");

    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill("delete");
    await page.getByTestId("confirm-delete").click();
    await expect(page).toHaveURL(/\/cost\/cost-categories\?deleted=/);
    expect((await categories()).some((c) => c.Name === name)).toBe(false);
  } finally {
    for (const c of await categories()) if (c.Name === name) await aws("ce", "delete-cost-category-definition", "--cost-category-arn", c.CostCategoryArn);
  }
});

test("Billing: Edit budgeted amount and Edit monitor name show current values and saving unchanged changes nothing", async ({ page }) => {
  const budget = uniqueName("fix-cost-budget");
  const monitor = uniqueName("fix-cost-monitor");
  let monitorArn = "";
  try {
    await aws("budgets", "create-budget", "--account-id", ACCOUNT, "--budget", JSON.stringify({ BudgetName: budget, BudgetType: "COST", TimeUnit: "MONTHLY", BudgetLimit: { Amount: "123", Unit: "USD" } }));
    await page.goto(`/cost/budgets/${encodeURIComponent(budget)}`);
    await runAction(page, "Edit budgeted amount");
    await expect(page.getByTestId("field-amount")).toHaveValue("123");
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog")).toContainText("No changes");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    expect(Number((await budgetNames()).find((b) => b.BudgetName === budget)?.BudgetLimit?.Amount)).toBe(123);

    monitorArn = (await aws<{ MonitorArn: string }>("ce", "create-anomaly-monitor", "--anomaly-monitor", JSON.stringify({ MonitorName: monitor, MonitorType: "DIMENSIONAL", MonitorDimension: "SERVICE" })))?.MonitorArn ?? "";
    await page.goto(`/cost/anomaly-monitors/${encodeURIComponent(monitorArn)}`);
    await runAction(page, "Edit monitor name");
    await expect(page.getByTestId("field-name")).toHaveValue(monitor);
  } finally {
    await aws("budgets", "delete-budget", "--account-id", ACCOUNT, "--budget-name", budget).catch(() => null);
    if (monitorArn) await aws("ce", "delete-anomaly-monitor", "--monitor-arn", monitorArn).catch(() => null);
  }
});
