import { expect, test } from "@playwright/test";
import { aws, uniqueName } from "./aws-cli";

interface RecordSet {
  Name: string;
  Type: string;
  SetIdentifier?: string;
  Weight?: number;
  ResourceRecords?: { Value: string }[];
}

async function recordSets(zoneId: string): Promise<RecordSet[]> {
  return (await aws<{ ResourceRecordSets: RecordSet[] }>("route53", "list-resource-record-sets", "--hosted-zone-id", zoneId))?.ResourceRecordSets ?? [];
}

/** Deletes every non-default record, then the zone. Safe to call when it is already gone. */
async function removeZone(domain: string): Promise<void> {
  const zones = (await aws<{ HostedZones: { Id: string; Name: string }[] }>("route53", "list-hosted-zones-by-name", "--dns-name", domain))?.HostedZones ?? [];
  for (const z of zones.filter((x) => x.Name === `${domain}.`)) {
    const id = z.Id.replace("/hostedzone/", "");
    const extra = (await recordSets(id)).filter((r) => !(r.Name === `${domain}.` && (r.Type === "NS" || r.Type === "SOA")));
    if (extra.length) {
      await aws("route53", "change-resource-record-sets", "--hosted-zone-id", id, "--change-batch", JSON.stringify({ Changes: extra.map((r) => ({ Action: "DELETE", ResourceRecordSet: r })) }));
    }
    await aws("route53", "delete-hosted-zone", "--id", id);
  }
}

test("Route 53: create a hosted zone, add/edit/delete a weighted record, test it, delete the zone", async ({ page }) => {
  const domain = `${uniqueName("e2e-route53")}.example.com`;
  try {
    await page.goto("/route53/hosted-zones");
    await expect(page.getByRole("heading", { name: /^Hosted zones/ })).toBeVisible();
    await page.getByRole("link", { name: "Create hosted zone" }).first().click();
    await expect(page.getByTestId("create-form")).toBeVisible();
    await page.getByLabel("Domain name", { exact: true }).fill(domain);
    await page.getByLabel("Description - optional").fill("made by e2e");
    await page.getByRole("button", { name: "Create hosted zone" }).click();

    await expect(page).toHaveURL(/\/route53\/hosted-zones\/[A-Z0-9]+/);
    await expect(page.getByTestId("flash").first()).toContainText("Created hosted zone");
    const zoneId = new URL(page.url()).pathname.split("/").pop() ?? "";
    await expect(page.getByTestId("kv-name")).toHaveText(`${domain}.`);
    await expect(page.getByTestId("kv-type")).toHaveText("Public");

    const listed = await aws<{ HostedZones: { Id: string; Name: string; Config?: { Comment?: string } }[] }>("route53", "list-hosted-zones-by-name", "--dns-name", domain);
    const zone = listed?.HostedZones.find((z) => z.Name === `${domain}.`);
    expect(zone?.Id).toBe(`/hostedzone/${zoneId}`);
    expect(zone?.Config?.Comment).toBe("made by e2e");

    // Records tab: the default NS and SOA records are there; create a weighted record.
    const panel = page.getByTestId("records-panel");
    await expect(panel.getByTestId("records-table")).toContainText("SOA");
    await panel.getByRole("button", { name: "Create record" }).click();
    const editor = page.getByTestId("record-editor");
    await editor.getByLabel("Record name").fill("www");
    await editor.getByLabel("Value", { exact: true }).fill("192.0.2.10");
    await editor.getByLabel("TTL (seconds)").fill("60");
    await editor.getByLabel("Routing policy").selectOption("weighted");
    await editor.getByLabel("Weight").fill("20");
    await editor.getByLabel("Record ID").fill("blue");
    await page.getByTestId("record-save").click();
    await expect(panel.getByTestId("flash")).toContainText("Created record");
    const row = panel.getByTestId("records-table").getByRole("row", { name: new RegExp(`www\\.${domain.replace(/\./g, "\\.")}`) });
    await expect(row).toContainText("Weighted");
    await expect(row).toContainText("192.0.2.10");

    let www = (await recordSets(zoneId)).find((r) => r.Name === `www.${domain}.`);
    expect(www?.Weight).toBe(20);
    expect(www?.SetIdentifier).toBe("blue");

    // Edit the record's weight.
    await row.getByRole("checkbox").check();
    await panel.getByRole("button", { name: "Edit record" }).click();
    await expect(editor.getByLabel("Weight")).toHaveValue("20");
    await editor.getByLabel("Weight").fill("35");
    await page.getByTestId("record-save").click();
    await expect(panel.getByTestId("flash")).toContainText("Saved record");
    www = (await recordSets(zoneId)).find((r) => r.Name === `www.${domain}.`);
    expect(www?.Weight).toBe(35);

    // Run an action: Test record answers from the zone.
    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Test record" }).click();
    await page.getByRole("dialog").getByLabel("Record name").fill("www");
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("NOERROR");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();

    // Delete the record, then the zone from the list.
    await row.getByRole("checkbox").check();
    await panel.getByRole("button", { name: "Delete record" }).click();
    await page.getByTestId("records-confirm-delete").click();
    await expect(panel.getByTestId("flash")).toContainText("Deleted 1 record");
    expect((await recordSets(zoneId)).some((r) => r.Name === `www.${domain}.`)).toBe(false);

    await page.goto("/route53/hosted-zones");
    const zoneRow = page.getByTestId("resource-table").getByRole("row", { name: new RegExp(zoneId) });
    await zoneRow.getByRole("radio").check();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill("delete");
    await page.getByTestId("confirm-delete").click();
    await expect(page.getByTestId("flash")).toContainText(`Deleted hosted zone ${zoneId}`);
    const after = await aws<{ HostedZones: { Name: string }[] }>("route53", "list-hosted-zones-by-name", "--dns-name", domain);
    expect(after?.HostedZones.some((z) => z.Name === `${domain}.`)).toBe(false);
  } finally {
    await removeZone(domain);
  }
});

test("Route 53: create, edit and delete a health check", async ({ page }) => {
  const name = uniqueName("e2e-route53-hc");
  let id = "";
  try {
    await page.goto("/route53/health-checks/create");
    await page.getByLabel("Name", { exact: true }).fill(name);
    await page.getByLabel("IP address or domain name").fill("example.com");
    await page.getByLabel("Path - optional").fill("/health");
    await page.getByRole("button", { name: "Create health check" }).click();
    await expect(page).toHaveURL(/\/route53\/health-checks\/[0-9a-f]{8}-[0-9a-f-]+/);
    id = new URL(page.url()).pathname.split("/").pop() ?? "";
    await expect(page.getByTestId("kv-name")).toHaveText(name);
    await expect(page.getByTestId("kv-description")).toHaveText("http://example.com:80/health");

    const cli = await aws<{ HealthCheck: { HealthCheckConfig: { Type: string; ResourcePath: string; FailureThreshold: number } } }>("route53", "get-health-check", "--health-check-id", id);
    expect(cli?.HealthCheck.HealthCheckConfig.Type).toBe("HTTP");
    expect(cli?.HealthCheck.HealthCheckConfig.ResourcePath).toBe("/health");

    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Edit health check" }).click();
    // The dialog opens on the current configuration.
    await expect(page.getByTestId("field-endpoint")).toHaveValue("example.com");
    await expect(page.getByTestId("field-path")).toHaveValue("/health");
    await expect(page.getByTestId("field-failureThreshold")).toHaveValue("3");
    await expect(page.getByTestId("field-disabled")).not.toBeChecked();
    await page.getByRole("dialog").getByLabel(/^Failure threshold/).fill("5");
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("Health check updated");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    const edited = await aws<{ HealthCheck: { HealthCheckConfig: { FailureThreshold: number; ResourcePath: string; Disabled?: boolean } } }>("route53", "get-health-check", "--health-check-id", id);
    expect(edited?.HealthCheck.HealthCheckConfig.FailureThreshold).toBe(5);
    expect(edited?.HealthCheck.HealthCheckConfig.ResourcePath).toBe("/health");
    expect(edited?.HealthCheck.HealthCheckConfig.Disabled ?? false).toBe(false);

    await page.goto("/route53/health-checks");
    const row = page.getByTestId("resource-table").getByRole("row", { name: new RegExp(name) });
    await expect(row).toBeVisible();
    await row.getByRole("radio").check();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill("delete");
    await page.getByTestId("confirm-delete").click();
    await expect(page.getByTestId("flash")).toContainText(`Deleted health check ${id}`);
    const left = await aws<{ HealthChecks: { Id: string }[] }>("route53", "list-health-checks");
    expect(left?.HealthChecks.some((h) => h.Id === id)).toBe(false);
    id = "";
  } finally {
    if (id) await aws("route53", "delete-health-check", "--health-check-id", id).catch(() => null);
  }
});

test("Route 53: Edit hosted zone and Manage tags open on the current values; an unchanged save changes nothing", async ({ page }) => {
  const domain = `${uniqueName("fix-route53")}.example.com`;
  try {
    const created = await aws<{ HostedZone: { Id: string } }>("route53", "create-hosted-zone", "--name", domain, "--caller-reference", uniqueName("fix-route53-ref"), "--hosted-zone-config", "Comment=fix zone description");
    const zoneId = (created?.HostedZone.Id ?? "").replace("/hostedzone/", "");
    await aws("route53", "change-tags-for-resource", "--resource-type", "hostedzone", "--resource-id", zoneId, "--add-tags", "Key=env,Value=dev");
    const state = async () => {
      const z = await aws<{ HostedZone: { Config?: { Comment?: string } } }>("route53", "get-hosted-zone", "--id", zoneId);
      const t = await aws<{ ResourceTagSet: { Tags?: { Key: string; Value: string }[] } }>("route53", "list-tags-for-resource", "--resource-type", "hostedzone", "--resource-id", zoneId);
      return { comment: z?.HostedZone.Config?.Comment, tags: t?.ResourceTagSet.Tags ?? [] };
    };

    await page.goto(`/route53/hosted-zones/${zoneId}`);
    await expect(page.getByTestId("kv-description")).toHaveText("fix zone description");
    await page.getByRole("button", { name: "Actions" }).click();
    // A public zone has no VPC associations.
    await expect(page.getByRole("menuitem", { name: "Associate VPC" })).toHaveCount(0);
    await page.getByRole("menuitem", { name: "Edit hosted zone" }).click();
    await expect(page.getByTestId("field-comment")).toHaveValue("fix zone description");
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("No changes");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();

    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Manage tags" }).click();
    await expect(page.getByLabel("Tags key 1")).toHaveValue("env");
    await expect(page.getByLabel("Tags value 1")).toHaveValue("dev");
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("No tag changes");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();

    const after = await state();
    expect(after.comment).toBe("fix zone description");
    expect(after.tags).toEqual([{ Key: "env", Value: "dev" }]);
  } finally {
    await removeZone(domain);
  }
});
