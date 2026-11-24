import { expect, test } from "@playwright/test";
import { aws, uniqueName } from "./aws-cli";

test("Resilience Hub: create a policy and an application, attach and add a component, delete both", async ({ page }) => {
  const policy = uniqueName("e2e-resiliencehub-pol").slice(0, 60);
  const app = uniqueName("e2e-resiliencehub-app").slice(0, 60);
  let policyArn = "";
  let appArn = "";
  try {
    await page.goto("/resiliencehub/policies/create");
    await page.getByLabel("Policy name").fill(policy);
    await page.getByLabel(/^Tier/).selectOption("MissionCritical");
    await page.getByLabel("Customer application RTO (seconds)").fill("300");
    await page.getByRole("button", { name: "Create resiliency policy" }).click();
    await expect(page.getByTestId("kv-Policy name")).toHaveText(policy);
    policyArn = (await page.getByTestId("kv-ARN").textContent()) ?? "";
    const cli = await aws<{ policy: { tier: string; policy: { Software: { rtoInSecs: number } } } }>("resiliencehub", "describe-resiliency-policy", "--policy-arn", policyArn);
    expect(cli?.policy.tier).toBe("MissionCritical");
    expect(cli?.policy.policy.Software.rtoInSecs).toBe(300);
    await page.getByRole("tab", { name: "RTO and RPO targets" }).click();
    await expect(page.getByRole("cell", { name: "5m" })).toBeVisible();

    await page.goto("/resiliencehub/applications");
    await page.getByRole("link", { name: "Add application" }).first().click();
    await page.getByLabel("Application name").fill(app);
    await page.getByRole("button", { name: "Add application" }).click();
    await expect(page.getByTestId("kv-Name")).toHaveText(app);
    appArn = (await page.getByTestId("kv-ARN").textContent()) ?? "";
    const apps = await aws<{ appSummaries: { name: string }[] }>("resiliencehub", "list-apps", "--name", app);
    expect(apps?.appSummaries.map((a) => a.name)).toContain(app);

    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Attach resiliency policy" }).click();
    await page.getByLabel("Resiliency policy ARN").fill(policyArn);
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog")).toContainText("Resiliency policy attached");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    await expect(page.getByTestId("kv-Resiliency policy")).toHaveText(policyArn);

    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Add application component" }).click();
    await page.getByLabel("Component name").fill("e2e-storage");
    await page.getByLabel("Component type").selectOption({ label: "Storage" });
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog")).toContainText("Component e2e-storage added");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    await expect(page.getByText("AWS::ResilienceHub::StorageAppComponent")).toBeVisible();

    // The policy is now listed (via the application that uses it).
    await page.goto("/resiliencehub/policies");
    await expect(page.getByTestId("resource-table").getByRole("row", { name: new RegExp(policy) })).toBeVisible();

    await page.goto("/resiliencehub/applications");
    const row = page.getByTestId("resource-table").getByRole("row", { name: new RegExp(app) });
    await row.getByRole("radio").check();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill("delete");
    await page.getByTestId("confirm-delete").click();
    await expect(page.getByTestId("flash")).toContainText("Deleted application");
    appArn = "";

    await page.goto(`/resiliencehub/policies/${policyArn.split("/").pop()}`);
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill("delete");
    await page.getByTestId("confirm-delete").click();
    await expect(page).toHaveURL(/\/resiliencehub\/policies\?deleted=/);
    const gone = await aws("resiliencehub", "describe-resiliency-policy", "--policy-arn", policyArn).then(() => false, () => true);
    expect(gone).toBe(true);
    policyArn = "";
  } finally {
    if (appArn) await aws("resiliencehub", "delete-app", "--app-arn", appArn, "--force-delete").catch(() => null);
    if (policyArn) await aws("resiliencehub", "delete-resiliency-policy", "--policy-arn", policyArn).catch(() => null);
  }
});

test("Resilience Hub: Edit policy shows current values and saving unchanged changes nothing", async ({ page }) => {
  const policy = uniqueName("fix-resiliencehub").slice(0, 60);
  let policyArn = "";
  const targets = { Software: { rtoInSecs: 300, rpoInSecs: 60 }, Hardware: { rtoInSecs: 600, rpoInSecs: 120 }, AZ: { rtoInSecs: 900, rpoInSecs: 180 } };
  try {
    policyArn =
      (await aws<{ policy: { policyArn: string } }>(
        "resiliencehub", "create-resiliency-policy", "--policy-name", policy, "--tier", "Important", "--policy-description", "fix desc",
        "--data-location-constraint", "SameCountry", "--policy", JSON.stringify(targets)
      ))?.policy.policyArn ?? "";
    const id = policyArn.slice(policyArn.lastIndexOf("/") + 1);
    await page.goto(`/resiliencehub/policies/${id}`);
    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Edit policy" }).click();
    await expect(page.getByTestId("field-tier")).toHaveValue("Important");
    await expect(page.getByTestId("field-location")).toHaveValue("SameCountry");
    await expect(page.getByTestId("field-description")).toHaveValue("fix desc");
    await expect(page.getByTestId("field-SoftwareRto")).toHaveValue("300");
    await expect(page.getByTestId("field-AZRpo")).toHaveValue("180");
    await expect(page.getByTestId("field-RegionRto")).toHaveValue("");
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog")).toContainText("No changes");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    const after = await aws<{ policy: { tier: string; policyDescription?: string; dataLocationConstraint?: string; policy: Record<string, unknown> } }>("resiliencehub", "describe-resiliency-policy", "--policy-arn", policyArn);
    expect(after?.policy).toMatchObject({ tier: "Important", policyDescription: "fix desc", dataLocationConstraint: "SameCountry" });
    expect(after?.policy.policy).toEqual(targets);
  } finally {
    if (policyArn) await aws("resiliencehub", "delete-resiliency-policy", "--policy-arn", policyArn).catch(() => null);
  }
});
