import { expect, test } from "@playwright/test";
import { aws } from "./aws-cli";

// Quota increases can't be withdrawn (in AWS or the emulator), so this test raises a
// harmless ACM API-rate quota by 1 on each run.
const SERVICE = "acm";
const QUOTA = "L-DD60D132";

test("Service Quotas: request an increase, see it applied and in the request history", async ({ page }) => {
  const before = await aws<{ Quota: { Value: number; QuotaName: string } }>("service-quotas", "get-service-quota", "--service-code", SERVICE, "--quota-code", QUOTA);
  const current = before?.Quota.Value ?? 0;
  const desired = current + 1;

  await page.goto("/servicequotas/services");
  await expect(page.getByRole("heading", { name: /^AWS services/ })).toBeVisible();
  await page.getByLabel("Find aws services").fill("Certificate Manager");
  await page.getByTestId("resource-table").getByRole("link", { name: /AWS Certificate Manager/ }).click();
  await expect(page.getByTestId("kv-Service code")).toHaveText(SERVICE);
  const table = page.getByTestId("quota-table");
  await expect(table).toContainText(QUOTA);

  await page.getByRole("button", { name: `Request increase for ${before?.Quota.QuotaName}` }).click();
  await page.getByLabel("Increase quota value").fill(String(current));
  await page.getByTestId("submit-increase").click();
  await expect(page.getByRole("dialog").getByTestId("error-banner")).toContainText("greater than the current");
  await page.getByLabel("Increase quota value").fill(String(desired));
  await page.getByTestId("submit-increase").click();
  await expect(page.getByTestId("flash")).toContainText(`= ${desired}`);

  // The emulator approves requests about a second after they are made, as AWS does asynchronously.
  await expect
    .poll(async () => (await aws<{ Quota: { Value: number } }>("service-quotas", "get-service-quota", "--service-code", SERVICE, "--quota-code", QUOTA))?.Quota.Value, { timeout: 15_000 })
    .toBe(desired);
  const history = await aws<{ RequestedQuotas: { Id: string; DesiredValue: number }[] }>("service-quotas", "list-requested-service-quota-change-history-by-quota", "--service-code", SERVICE, "--quota-code", QUOTA);
  const req = history?.RequestedQuotas.find((r) => r.DesiredValue === desired);
  expect(req).toBeTruthy();

  await page.goto("/servicequotas/history");
  const row = page.getByTestId("resource-table").getByRole("row", { name: new RegExp(`${desired}`) }).filter({ hasText: "ListAcmeDomainValidations" });
  await expect(row.first()).toBeVisible();
  await row.first().getByRole("link").click();
  await expect(page.getByTestId("kv-Request ID")).toHaveText(req?.Id ?? "");
  await expect(page.getByTestId("kv-Requested value")).toHaveText(String(desired));
});

test("Service Quotas: a service page is titled with the service name, X-Ray Traces has a header", async ({ page }) => {
  await page.goto("/servicequotas/services/ec2");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Amazon Elastic Compute Cloud (Amazon EC2)");
  await page.goto("/xray/traces");
  await expect(page.getByRole("heading", { level: 1, name: "Traces" })).toBeVisible();
});
