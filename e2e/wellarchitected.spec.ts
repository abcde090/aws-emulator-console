import { expect, test } from "@playwright/test";
import { aws, uniqueName } from "./aws-cli";

interface WorkloadList {
  WorkloadSummaries?: { WorkloadId?: string; WorkloadName?: string }[];
}

async function findWorkload(name: string): Promise<string | null> {
  const r = await aws<WorkloadList>("wellarchitected", "list-workloads", "--workload-name-prefix", name);
  return r?.WorkloadSummaries?.find((w) => w.WorkloadName === name)?.WorkloadId ?? null;
}

test("Well-Architected: define a workload, save a milestone, answer a question, get the report, delete it", async ({ page }) => {
  const name = uniqueName("e2e-wellarchitected");
  try {
    await page.goto("/wellarchitected/workloads");
    await expect(page.getByRole("heading", { name: /^Workloads/ })).toBeVisible();

    await page.getByRole("link", { name: "Define workload" }).first().click();
    await expect(page.getByTestId("create-form")).toBeVisible();
    await page.getByLabel("Name", { exact: true }).fill(name);
    await page.getByLabel("Description").fill("Workload created by the e2e test");
    await page.getByLabel("Review owner").fill("e2e@example.com");
    await page.getByRole("radio", { name: "Pre-production" }).check();
    await page.getByRole("button", { name: "Define workload" }).click();

    await expect(page).toHaveURL(/\/wellarchitected\/workloads\/[0-9a-f]{32}/);
    await expect(page.getByTestId("flash")).toContainText("Created workload");
    await expect(page.getByTestId("kv-Name")).toHaveText(name);
    await expect(page.getByTestId("kv-Environment")).toHaveText("Pre-production");
    const workloadId = page.url().match(/workloads\/([0-9a-f]{32})/)?.[1] ?? "";
    expect(await findWorkload(name)).toBe(workloadId);

    // Save a milestone.
    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Save milestone" }).click();
    await page.getByLabel("Milestone name").fill("e2e-milestone-1");
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("Saved milestone 1");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    const milestones = await aws<{ MilestoneSummaries?: { MilestoneName?: string }[] }>("wellarchitected", "list-milestones", "--workload-id", workloadId);
    expect(milestones?.MilestoneSummaries?.map((m) => m.MilestoneName)).toContain("e2e-milestone-1");

    // Answer a question in the lens review.
    await page.getByRole("tab", { name: "Lens reviews" }).click();
    await page.getByTestId("lens-reviews").getByRole("link", { name: "AWS Well-Architected Framework" }).click();
    await expect(page.getByTestId("lens-review")).toBeVisible();
    await page.getByRole("navigation", { name: "Pillars" }).getByRole("link", { name: "Security" }).click();
    await page.getByTestId("questions").getByRole("link", { name: /How do you securely operate your workload/ }).click();
    await page.getByRole("checkbox", { name: /Separate workloads using accounts/ }).check();
    await page.getByLabel(/^Notes/).fill("answered by e2e");
    await page.getByTestId("save-answer").click();
    await expect(page.getByTestId("flash")).toContainText("Answer saved");
    const answer = await aws<{ Answer?: { SelectedChoices?: string[]; Notes?: string } }>(
      "wellarchitected", "get-answer", "--workload-id", workloadId, "--lens-alias", "wellarchitected", "--question-id", "securely-operate"
    );
    expect(answer?.Answer?.SelectedChoices).toContain("sec_securely_operate_multi_accounts");
    expect(answer?.Answer?.Notes).toBe("answered by e2e");
    await expect(page.getByTestId("improvements")).toContainText("How do you securely operate your workload?");

    // The report link returns a PDF.
    const report = await page.request.get(`/wellarchitected/workloads/${workloadId}/report?lens=wellarchitected`);
    expect(report.status()).toBe(200);
    expect(report.headers()["content-type"]).toBe("application/pdf");
    expect((await report.body()).subarray(0, 5).toString()).toBe("%PDF-");

    // Delete from the list.
    await page.goto("/wellarchitected/workloads");
    const row = page.getByTestId("resource-table").getByRole("row", { name: new RegExp(name) });
    await expect(row).toBeVisible();
    await row.getByRole("radio").check();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill("delete");
    await page.getByTestId("confirm-delete").click();
    await expect(page.getByTestId("flash")).toContainText(`Deleted workload ${workloadId}`);
    expect(await findWorkload(name)).toBeNull();
  } finally {
    const left = await findWorkload(name).catch(() => null);
    if (left) await aws("wellarchitected", "delete-workload", "--workload-id", left, "--client-request-token", `cleanup-${Date.now()}`);
  }
});

test("Well-Architected: Edit properties shows current values and saving unchanged changes nothing", async ({ page }) => {
  const name = uniqueName("fix-wellarchitected");
  let id = "";
  try {
    id =
      (await aws<{ WorkloadId: string }>(
        "wellarchitected", "create-workload", "--workload-name", name, "--description", "fix workload desc", "--review-owner", "fix@example.com",
        "--environment", "PREPRODUCTION", "--aws-regions", "us-east-1", "us-west-2", "--lenses", "wellarchitected", "--client-request-token", name
      ))?.WorkloadId ?? "";
    await page.goto(`/wellarchitected/workloads/${id}`);
    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Edit properties" }).click();
    await expect(page.getByTestId("field-description")).toHaveValue("fix workload desc");
    await expect(page.getByTestId("field-reviewOwner")).toHaveValue("fix@example.com");
    await expect(page.getByTestId("field-environment")).toHaveValue("PREPRODUCTION");
    await expect(page.getByTestId("field-regions")).toHaveValue("us-east-1, us-west-2");
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog")).toContainText("No changes");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    const w = await aws<{ Workload: { Description: string; ReviewOwner: string; Environment: string; AwsRegions: string[] } }>("wellarchitected", "get-workload", "--workload-id", id);
    expect(w?.Workload).toMatchObject({ Description: "fix workload desc", ReviewOwner: "fix@example.com", Environment: "PREPRODUCTION", AwsRegions: ["us-east-1", "us-west-2"] });
  } finally {
    if (id) await aws("wellarchitected", "delete-workload", "--workload-id", id, "--client-request-token", `${name}-del`).catch(() => null);
  }
});
