import { expect, test } from "@playwright/test";
import { aws, uniqueName } from "./aws-cli";

let createdDetector: string | null = null;

async function detector(): Promise<string> {
  const r = await aws<{ DetectorIds: string[] }>("guardduty", "list-detectors");
  if (r?.DetectorIds[0]) return r.DetectorIds[0];
  const c = await aws<{ DetectorId: string }>("guardduty", "create-detector", "--enable");
  createdDetector = c?.DetectorId ?? null;
  return createdDetector ?? "";
}

test.afterAll(async () => {
  if (createdDetector) await aws("guardduty", "delete-detector", "--detector-id", createdDetector);
});

test("GuardDuty: add a threat list, deactivate it, delete it; suppression rule", async ({ page }) => {
  const d = await detector();
  const name = uniqueName("e2e-guardduty-threats");
  const rule = uniqueName("e2e-guardduty-rule");
  const ids = async () => (await aws<{ ThreatIntelSetIds: string[] }>("guardduty", "list-threat-intel-sets", "--detector-id", d))?.ThreatIntelSetIds ?? [];
  const before = new Set(await ids());
  try {
    await page.goto("/guardduty/threat-lists");
    await expect(page.getByRole("heading", { name: /^Threat lists/ })).toBeVisible();
    await page.getByRole("link", { name: "Add threat list" }).first().click();
    await page.getByLabel("List name").fill(name);
    await page.getByLabel("Location").fill("https://s3.amazonaws.com/e2e-guardduty/ips.txt");
    await page.getByRole("button", { name: "Add threat list" }).click();
    await expect(page.getByTestId("kv-List name")).toHaveText(name);
    await expect(page.getByTestId("kv-Status")).toContainText(/ACTIV/);

    const added = (await ids()).filter((i) => !before.has(i));
    expect(added).toHaveLength(1);

    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Deactivate" }).click();
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("List deactivated");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    const got = await aws<{ Status: string }>("guardduty", "get-threat-intel-set", "--detector-id", d, "--threat-intel-set-id", added[0]);
    expect(got?.Status).toMatch(/DEACTIVATING|INACTIVE/);

    await page.goto("/guardduty/threat-lists");
    const row = page.getByTestId("resource-table").getByRole("row", { name: new RegExp(name) });
    await row.getByRole("radio").check();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill("delete");
    await page.getByTestId("confirm-delete").click();
    await expect(page.getByTestId("resource-table").getByRole("row", { name: new RegExp(name) })).toHaveCount(0);
    expect(await ids()).not.toContain(added[0]);

    // Suppression rule (filter) round trip.
    await page.goto("/guardduty/suppression-rules/create");
    await page.getByLabel("Suppression rule name").fill(rule);
    await page.getByLabel(/^Finding type/).fill("Recon:EC2/PortProbeUnprotectedPort");
    await page.getByRole("button", { name: "Create suppression rule" }).click();
    await expect(page.getByTestId("kv-Action")).toContainText("Archive");
    const filters = await aws<{ FilterNames: string[] }>("guardduty", "list-filters", "--detector-id", d);
    expect(filters?.FilterNames).toContain(rule);
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill(rule);
    await page.getByTestId("confirm-delete").click();
    await expect(page).toHaveURL(/\/guardduty\/suppression-rules\?deleted=/);
  } finally {
    for (const id of (await ids()).filter((i) => !before.has(i))) await aws("guardduty", "delete-threat-intel-set", "--detector-id", d, "--threat-intel-set-id", id);
    const f = await aws<{ FilterNames: string[] }>("guardduty", "list-filters", "--detector-id", d);
    if (f?.FilterNames.includes(rule)) await aws("guardduty", "delete-filter", "--detector-id", d, "--filter-name", rule);
  }
});

test("GuardDuty: Edit dialogs show current values and saving unchanged changes nothing", async ({ page }) => {
  const d = await detector();
  const name = uniqueName("fix-guardduty-list");
  const rule = uniqueName("fix-guardduty-rule");
  const location = "https://s3.amazonaws.com/fix-guardduty/ips.txt";
  let listId = "";
  try {
    listId = (await aws<{ ThreatIntelSetId: string }>("guardduty", "create-threat-intel-set", "--detector-id", d, "--name", name, "--format", "TXT", "--location", location, "--no-activate"))?.ThreatIntelSetId ?? "";
    await aws("guardduty", "create-filter", "--detector-id", d, "--name", rule, "--action", "NOOP", "--rank", "3", "--description", "keep me",
      "--finding-criteria", JSON.stringify({ Criterion: { type: { Eq: ["Recon:EC2/PortProbeUnprotectedPort"] } } }));

    // The emulator rewrites the S3 URL to its own endpoint; the dialog must show what GuardDuty returns.
    const stored = (await aws<{ Location: string }>("guardduty", "get-threat-intel-set", "--detector-id", d, "--threat-intel-set-id", listId))?.Location ?? "";
    expect(stored).toMatch(/fix-guardduty\/ips\.txt$/);

    // Threat list: Edit shows its name and location; Deactivate isn't offered for an inactive list.
    await page.goto(`/guardduty/threat-lists/${listId}`);
    await expect(page.getByTestId("kv-List name")).toHaveText(name);
    await page.getByRole("button", { name: "Actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Deactivate" })).toHaveCount(0);
    await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByTestId("field-name")).toHaveValue(name);
    await expect(dialog.getByTestId("field-location")).toHaveValue(stored);
    await page.getByTestId("action-submit").click();
    await expect(dialog.getByTestId("flash")).toContainText("No changes to save");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    const list = await aws<{ Name: string; Location: string }>("guardduty", "get-threat-intel-set", "--detector-id", d, "--threat-intel-set-id", listId);
    expect(list).toMatchObject({ Name: name, Location: stored });

    // Suppression rule: Edit shows description, action, rank and criteria; saving unchanged keeps them.
    await page.goto(`/guardduty/suppression-rules/${rule}`);
    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Edit suppression rule" }).click();
    await expect(dialog.getByTestId("field-description")).toHaveValue("keep me");
    await expect(dialog.getByTestId("field-action").locator('input[value="NOOP"]')).toBeChecked();
    await expect(dialog.getByTestId("field-rank")).toHaveValue("3");
    await expect(dialog.getByTestId("field-criteria")).toHaveValue(/PortProbeUnprotectedPort/);
    await page.getByTestId("action-submit").click();
    await expect(dialog.getByTestId("flash")).toContainText("Suppression rule updated");
    const f = await aws<{ Action: string; Rank: number; Description: string; FindingCriteria: unknown }>("guardduty", "get-filter", "--detector-id", d, "--filter-name", rule);
    expect(f).toMatchObject({ Action: "NOOP", Rank: 3, Description: "keep me", FindingCriteria: { Criterion: { type: { Eq: ["Recon:EC2/PortProbeUnprotectedPort"] } } } });
    await page.getByRole("button", { name: "Close", exact: true }).last().click();

    // The detector is account-wide: only check its Edit dialog when this run created it.
    if (createdDetector === d) {
      await aws("guardduty", "update-detector", "--detector-id", d, "--finding-publishing-frequency", "ONE_HOUR");
      await page.goto(`/guardduty/settings/${d}`);
      await page.getByRole("button", { name: "Actions" }).click();
      await expect(page.getByRole("menuitem", { name: "Re-enable GuardDuty" })).toHaveCount(0);
      await page.getByRole("menuitem", { name: "Edit findings export frequency" }).click();
      await expect(dialog.getByTestId("field-frequency")).toHaveValue("ONE_HOUR");
      await page.getByTestId("action-submit").click();
      await expect(dialog.getByTestId("flash")).toContainText("ONE_HOUR");
      expect((await aws<{ FindingPublishingFrequency: string }>("guardduty", "get-detector", "--detector-id", d))?.FindingPublishingFrequency).toBe("ONE_HOUR");
    }
  } finally {
    if (listId) await aws("guardduty", "delete-threat-intel-set", "--detector-id", d, "--threat-intel-set-id", listId);
    const f = await aws<{ FilterNames: string[] }>("guardduty", "list-filters", "--detector-id", d);
    if (f?.FilterNames.includes(rule)) await aws("guardduty", "delete-filter", "--detector-id", d, "--filter-name", rule);
  }
});
