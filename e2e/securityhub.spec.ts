import { expect, test } from "@playwright/test";
import { aws, uniqueName } from "./aws-cli";

let enabledHere = false;

test.beforeAll(async () => {
  try {
    await aws("securityhub", "describe-hub");
  } catch {
    await aws("securityhub", "enable-security-hub", "--no-enable-default-standards");
    enabledHere = true;
  }
});

test.afterAll(async () => {
  if (enabledHere) await aws("securityhub", "disable-security-hub");
});

interface RuleMeta { RuleArn: string; RuleName: string; RuleStatus: string }
const rules = async () => (await aws<{ AutomationRulesMetadata: RuleMeta[] }>("securityhub", "list-automation-rules"))?.AutomationRulesMetadata ?? [];

test("Security Hub: create an automation rule, disable it, delete it", async ({ page }) => {
  const name = uniqueName("e2e-securityhub-rule");
  try {
    await page.goto("/securityhub/automations");
    await expect(page.getByRole("heading", { name: /^Automations/ })).toBeVisible();
    await page.getByRole("link", { name: "Create rule" }).first().click();
    await page.getByLabel("Rule name").fill(name);
    await page.getByLabel("Description", { exact: true }).fill("Suppress low findings");
    await page.getByLabel("Severity label is").selectOption(["LOW"]);
    await page.getByLabel(/^Set workflow status/).selectOption("SUPPRESSED");
    await page.getByRole("button", { name: "Create rule" }).click();
    await expect(page.getByTestId("kv-Rule name")).toHaveText(name);
    await expect(page.getByText("EQUALS LOW")).toBeVisible();

    const created = (await rules()).find((r) => r.RuleName === name);
    expect(created?.RuleStatus).toBe("ENABLED");

    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Disable" }).click();
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("Rule disabled");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    expect((await rules()).find((r) => r.RuleName === name)?.RuleStatus).toBe("DISABLED");

    await page.goto("/securityhub/automations");
    const row = page.getByTestId("resource-table").getByRole("row", { name: new RegExp(name) });
    await row.getByRole("radio").check();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill("delete");
    await page.getByTestId("confirm-delete").click();
    await expect(page.getByTestId("resource-table").getByRole("row", { name: new RegExp(name) })).toHaveCount(0);
    expect((await rules()).some((r) => r.RuleName === name)).toBe(false);
  } finally {
    const left = (await rules()).filter((r) => r.RuleName === name).map((r) => r.RuleArn);
    if (left.length) await aws("securityhub", "batch-delete-automation-rules", "--automation-rules-arns", ...left);
  }
});

test("Security Hub: Edit dialogs show current values and saving unchanged changes nothing", async ({ page }) => {
  const name = uniqueName("fix-securityhub-rule");
  let ruleArn = "";
  try {
    ruleArn = (await aws<{ RuleArn: string }>("securityhub", "create-automation-rule", "--rule-name", name, "--description", "keep me", "--rule-order", "7", "--is-terminal", "--rule-status", "ENABLED",
      "--criteria", JSON.stringify({ SeverityLabel: [{ Value: "LOW", Comparison: "EQUALS" }] }),
      "--actions", JSON.stringify([{ Type: "FINDING_FIELDS_UPDATE", FindingFieldsUpdate: { Workflow: { Status: "SUPPRESSED" } } }])))?.RuleArn ?? "";
    const id = ruleArn.split("/").pop() ?? "";

    await page.goto(`/securityhub/automations/${id}`);
    await expect(page.getByTestId("kv-Rule name")).toHaveText(name);
    await page.getByRole("button", { name: "Actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Enable", exact: true })).toHaveCount(0);
    await page.getByRole("menuitem", { name: "Edit rule" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByTestId("field-name")).toHaveValue(name);
    await expect(dialog.getByTestId("field-description")).toHaveValue("keep me");
    await expect(dialog.getByTestId("field-order")).toHaveValue("7");
    await expect(dialog.getByTestId("field-terminal")).toBeChecked();
    await page.getByTestId("action-submit").click();
    await expect(dialog.getByTestId("flash")).toContainText("No changes to save");
    const rule = (await aws<{ Rules: { RuleOrder: number; IsTerminal: boolean; Description: string }[] }>("securityhub", "batch-get-automation-rules", "--automation-rules-arns", ruleArn))?.Rules[0];
    expect(rule).toMatchObject({ RuleOrder: 7, IsTerminal: true, Description: "keep me" });

    await page.getByRole("button", { name: "Close", exact: true }).last().click();

    // A real change sends only that field.
    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Edit rule" }).click();
    await dialog.getByTestId("field-description").fill("changed");
    await page.getByTestId("action-submit").click();
    await expect(dialog.getByTestId("flash")).toContainText("Rule updated");
    const changed = (await aws<{ Rules: { RuleOrder: number; IsTerminal: boolean; Description: string; RuleName: string }[] }>("securityhub", "batch-get-automation-rules", "--automation-rules-arns", ruleArn))?.Rules[0];
    expect(changed).toMatchObject({ RuleName: name, RuleOrder: 7, IsTerminal: true, Description: "changed" });
  } finally {
    if (ruleArn) await aws("securityhub", "batch-delete-automation-rules", "--automation-rules-arns", ruleArn);
  }
});
