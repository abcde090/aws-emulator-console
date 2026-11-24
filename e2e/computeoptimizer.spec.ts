import { expect, test } from "@playwright/test";
import { aws } from "./aws-cli";

const ACCOUNT = "000000000000";

interface Prefs {
  recommendationPreferencesDetails?: { resourceType?: string; scope?: { name?: string; value?: string }; lookBackPeriod?: string }[];
}

async function ebsPrefs(): Promise<Prefs["recommendationPreferencesDetails"]> {
  const r = await aws<Prefs>("compute-optimizer", "get-recommendation-preferences", "--resource-type", "EbsVolume", "--scope", `name=AccountId,value=${ACCOUNT}`);
  return r?.recommendationPreferencesDetails ?? [];
}

test("Compute Optimizer: set, edit and delete a recommendation preference; browse recommendations", async ({ page }) => {
  const before = await aws<{ status?: string }>("compute-optimizer", "get-enrollment-status");
  const wasActive = before?.status === "Active";
  try {
    // Opt in through the Account page if needed.
    await page.goto("/computeoptimizer/account");
    await expect(page.getByRole("heading", { name: /^Account/ })).toBeVisible();
    if (!wasActive) {
      await page.getByRole("link", { name: ACCOUNT }).click();
      await expect(page.getByTestId("kv-Opt-in status")).toHaveText("Inactive");
      await expect(async () => {
        await page.getByRole("button", { name: "Actions" }).click();
        await expect(page.getByRole("menuitem", { name: "Opt in" })).toBeVisible({ timeout: 1000 });
      }).toPass();
      await page.getByRole("menuitem", { name: "Opt in" }).click();
      await page.getByTestId("action-submit").click();
      await expect(page.getByRole("dialog")).toContainText("Opt-in status: Active");
      await page.getByRole("button", { name: "Close", exact: true }).last().click();
    }
    expect((await aws<{ status?: string }>("compute-optimizer", "get-enrollment-status"))?.status).toBe("Active");
    if ((await ebsPrefs())?.length) throw new Error("An EbsVolume account-scope preference already exists; refusing to overwrite it.");

    // Recommendations come from the emulator.
    await page.goto("/computeoptimizer/dashboard");
    await expect(page.getByTestId("resource-table")).toContainText("Ec2Instance");

    // Create a preference through the form.
    await page.goto("/computeoptimizer/preferences");
    await expect(page.getByRole("heading", { name: /^Recommendation preferences/ })).toBeVisible();
    await page.getByRole("link", { name: "Set recommendation preferences" }).first().click();
    await expect(page.getByTestId("create-form")).toBeVisible();
    await page.getByLabel("Resource type", { exact: true }).selectOption("EbsVolume");
    await page.getByLabel(/^Look-back period/).selectOption("DAYS_32");
    await page.getByRole("button", { name: "Set recommendation preferences" }).click();

    await expect(page).toHaveURL(/\/computeoptimizer\/preferences\/EbsVolume/);
    await expect(page.getByTestId("flash")).toContainText("Created recommendation preference");
    await expect(page.getByTestId("kv-Look-back period")).toHaveText("32 days");
    expect((await ebsPrefs())?.[0]?.lookBackPeriod).toBe("DAYS_32");

    // Edit opens with the current value; saving it unchanged changes nothing.
    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Edit preferences" }).click();
    await expect(page.getByTestId("field-lookBackPeriod")).toHaveValue("DAYS_32");
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog")).toContainText("No changes");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    expect((await ebsPrefs())?.[0]?.lookBackPeriod).toBe("DAYS_32");

    // Edit it.
    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Edit preferences" }).click();
    await expect(page.getByTestId("field-lookBackPeriod")).toHaveValue("DAYS_32");
    await page.getByRole("dialog").getByLabel(/^Look-back period/).selectOption("DAYS_93");
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog")).toContainText("Preferences saved for EbsVolume");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    await expect(page.getByTestId("kv-Look-back period")).toHaveText("93 days");
    expect((await ebsPrefs())?.[0]?.lookBackPeriod).toBe("DAYS_93");

    // The list shows it; delete from the list.
    await page.goto("/computeoptimizer/preferences");
    const row = page.getByTestId("resource-table").getByRole("row", { name: /EbsVolume/ });
    await expect(row).toBeVisible();
    await row.getByRole("radio").check();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill("delete");
    await page.getByTestId("confirm-delete").click();
    await expect(page.getByTestId("resource-table").getByRole("row", { name: /EbsVolume/ })).toHaveCount(0);
    expect(await ebsPrefs()).toHaveLength(0);
  } finally {
    let leftover = false;
    try {
      leftover = Boolean((await ebsPrefs())?.length);
    } catch {
      leftover = false; // not opted in: no preferences can exist
    }
    if (leftover) {
      await aws("compute-optimizer", "delete-recommendation-preferences", "--resource-type", "EbsVolume", "--scope", `name=AccountId,value=${ACCOUNT}`, "--recommendation-preference-names", "LookBackPeriodPreference");
    }
    if (!wasActive) await aws("compute-optimizer", "update-enrollment-status", "--status", "Inactive");
  }
});
