import { expect, test, type Page } from "@playwright/test";
import { aws, uniqueName } from "./aws-cli";

async function runAction(page: Page, label: string) {
  const item = page.getByRole("menuitem", { name: label, exact: true });
  // The menu only opens once the page has hydrated; retry the click until it does.
  await expect(async () => {
    if (!(await item.isVisible())) await page.getByRole("button", { name: "Actions" }).click();
    await expect(item).toBeVisible({ timeout: 1000 });
  }).toPass();
  await item.click();
}

interface CertList {
  CertificateSummaryList: { CertificateArn: string; DomainName: string }[];
}

test("ACM: request a public certificate, see its DNS validation record, tag it, delete it", async ({ page }) => {
  const domain = `${uniqueName("e2e-acm")}.example.com`;
  try {
    await page.goto("/acm/certificates");
    await expect(page.getByRole("heading", { name: /^Certificates/ })).toBeVisible();
    await page.getByRole("link", { name: "Request certificate" }).first().click();
    await page.getByLabel("Fully qualified domain name").fill(domain);
    await page.getByLabel("Add another name to this certificate - optional").fill(`www.${domain}`);
    await page.getByRole("button", { name: "Request certificate" }).click();

    await expect(page.getByTestId("kv-Domain name")).toHaveText(domain);
    await expect(page.getByTestId("kv-Status")).toHaveText("PENDING_VALIDATION");
    await expect(page.getByTestId("kv-Number of additional names")).toHaveText("1");
    await expect(page.getByRole("cell", { name: "CNAME", exact: true }).first()).toBeVisible();

    const listed = await aws<CertList>("acm", "list-certificates");
    const cert = listed?.CertificateSummaryList.find((c) => c.DomainName === domain);
    expect(cert).toBeTruthy();

    await runAction(page, "Edit tags");
    await page.getByRole("button", { name: "Add new tag" }).click();
    await page.getByLabel("Tags key 1").fill("env");
    await page.getByLabel("Tags value 1").fill("e2e");
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("Added or changed 1 tag, removed 0.");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    const tags = await aws<{ Tags: { Key: string; Value: string }[] }>("acm", "list-tags-for-certificate", "--certificate-arn", cert?.CertificateArn ?? "");
    expect(tags?.Tags).toContainEqual({ Key: "env", Value: "e2e" });

    // Edit dialogs show the current values; saving unchanged changes nothing.
    await runAction(page, "Edit tags");
    await expect(page.getByLabel("Tags key 1")).toHaveValue("env");
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("No tag changes");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    const afterTags = await aws<{ Tags: { Key: string; Value: string }[] }>("acm", "list-tags-for-certificate", "--certificate-arn", cert?.CertificateArn ?? "");
    expect(afterTags?.Tags).toEqual([{ Key: "env", Value: "e2e" }]);

    // Reimport only applies to imported certificates.
    await page.getByRole("button", { name: "Actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Edit tags", exact: true })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Reimport certificate", exact: true })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "Resend validation email", exact: true })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "Edit certificate transparency logging", exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");

    await page.goto("/acm/certificates");
    await page.getByLabel("Find certificates").fill(domain);
    const row = page.getByTestId("resource-table").getByRole("row", { name: new RegExp(domain) });
    await expect(row).toBeVisible();
    await row.getByRole("radio").check();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill("delete");
    await page.getByTestId("confirm-delete").click();
    await expect(page.getByTestId("flash")).toContainText("Deleted certificate");
    const after = await aws<CertList>("acm", "list-certificates");
    expect(after?.CertificateSummaryList.some((c) => c.DomainName === domain)).toBe(false);
  } finally {
    const left = await aws<CertList>("acm", "list-certificates");
    for (const c of left?.CertificateSummaryList ?? []) if (c.DomainName === domain) await aws("acm", "delete-certificate", "--certificate-arn", c.CertificateArn);
  }
});

test("ACM: Create records in Route 53 writes the validation CNAME and the certificate is issued", async ({ page }) => {
  test.setTimeout(150_000);
  const zoneName = `${uniqueName("fix-acm")}.net`;
  const domain = `www.${zoneName}`;
  let zoneId = "";
  let arn = "";
  try {
    const zone = await aws<{ HostedZone: { Id: string } }>("route53", "create-hosted-zone", "--name", zoneName, "--caller-reference", uniqueName("fix-acm-ref"));
    zoneId = zone?.HostedZone.Id.replace("/hostedzone/", "") ?? "";
    const req = await aws<{ CertificateArn: string }>("acm", "request-certificate", "--domain-name", domain, "--validation-method", "DNS");
    arn = req?.CertificateArn ?? "";
    const id = arn.replace(/^.*:certificate\//, "");
    // ACM fills in the CNAME a moment after the request.
    await expect(async () => {
      const d = await aws<{ Certificate: { DomainValidationOptions: { ResourceRecord?: unknown }[] } }>("acm", "describe-certificate", "--certificate-arn", arn);
      expect(d?.Certificate.DomainValidationOptions[0]?.ResourceRecord).toBeTruthy();
    }).toPass({ timeout: 20_000 });

    await page.goto(`/acm/certificates/${id}`);
    await expect(page.getByTestId("kv-Validation method")).toHaveText("DNS");
    await runAction(page, "Create records in Route 53");
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("1 CNAME record created");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();

    const records = await aws<{ ResourceRecordSets: { Name: string; Type: string }[] }>("route53", "list-resource-record-sets", "--hosted-zone-id", zoneId);
    expect(records?.ResourceRecordSets.some((r) => r.Type === "CNAME" && r.Name.endsWith(`${domain}.`))).toBe(true);
    await expect(async () => {
      const d = await aws<{ Certificate: { Status: string } }>("acm", "describe-certificate", "--certificate-arn", arn);
      expect(d?.Certificate.Status).toBe("ISSUED");
    }).toPass({ timeout: 90_000, intervals: [3_000] });

    // Edit transparency logging shows the issued certificate's current setting; saving unchanged keeps it.
    await page.reload();
    await aws("acm", "update-certificate-options", "--certificate-arn", arn, "--options", "CertificateTransparencyLoggingPreference=DISABLED");
    await runAction(page, "Edit certificate transparency logging");
    await expect(page.getByTestId("field-pref").getByRole("radio", { name: "Disabled" })).toBeChecked();
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("updated");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    const opts = await aws<{ Certificate: { Options: { CertificateTransparencyLoggingPreference: string } } }>("acm", "describe-certificate", "--certificate-arn", arn);
    expect(opts?.Certificate.Options.CertificateTransparencyLoggingPreference).toBe("DISABLED");
  } finally {
    if (arn) await aws("acm", "delete-certificate", "--certificate-arn", arn).catch(() => null);
    if (zoneId) {
      const sets = await aws<{ ResourceRecordSets: { Name: string; Type: string; TTL?: number; ResourceRecords?: { Value: string }[] }[] }>("route53", "list-resource-record-sets", "--hosted-zone-id", zoneId);
      const cnames = (sets?.ResourceRecordSets ?? []).filter((r) => r.Type === "CNAME");
      if (cnames.length) await aws("route53", "change-resource-record-sets", "--hosted-zone-id", zoneId, "--change-batch", JSON.stringify({ Changes: cnames.map((r) => ({ Action: "DELETE", ResourceRecordSet: r })) }));
      await aws("route53", "delete-hosted-zone", "--id", zoneId);
    }
  }
});
