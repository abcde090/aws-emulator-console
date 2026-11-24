import { expect, test } from "@playwright/test";
import { aws, uniqueName } from "./aws-cli";

interface Summary { Name: string; Id: string; LockToken?: string }

async function findAcl(name: string): Promise<Summary | undefined> {
  const r = await aws<{ WebACLs?: Summary[] }>("wafv2", "list-web-acls", "--scope", "REGIONAL");
  return r?.WebACLs?.find((w) => w.Name === name);
}

test("WAF: create a web ACL with a geo rule, add a rate-based rule, delete it", async ({ page }) => {
  const name = uniqueName("e2e-waf-acl");
  try {
    await page.goto("/waf/web-acls");
    await expect(page.getByRole("heading", { name: /^Web ACLs/ })).toBeVisible();
    await page.getByRole("link", { name: "Create web ACL" }).first().click();
    await expect(page.getByTestId("create-form")).toBeVisible();
    await page.getByLabel("Name", { exact: true }).fill(name);
    await page.getByLabel(/^Block countries/).fill("KP, RU");
    await page.getByRole("radiogroup", { name: /Default web ACL action/ }).getByRole("radio", { name: "Block" }).check();
    await page.getByRole("button", { name: "Create web ACL" }).click();

    await expect(page.getByTestId("kv-Name")).toHaveText(name);
    await expect(page.getByTestId("kv-Default action")).toHaveText("Block");
    await expect(page.getByTestId("kv-Web ACL rule capacity units used")).toContainText("WCUs");
    await expect(page.getByText("Country in KP, RU")).toBeVisible();

    const acl = await findAcl(name);
    expect(acl).toBeTruthy();

    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Add rate-based rule" }).click();
    await page.getByRole("dialog").getByLabel("Name", { exact: true }).fill("RateLimit");
    await page.getByLabel("Rate limit").fill("500");
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("Added rule RateLimit");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();

    // Edit default action shows the ACL's current action (Block), and saving it unchanged keeps it.
    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Edit default action" }).click();
    await expect(page.getByRole("dialog").getByTestId("field-defaultAction").getByRole("radio", { name: "Block" })).toBeChecked();
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("already Block");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();

    const got = await aws<{ WebACL: { Rules: { Name: string; Statement: { RateBasedStatement?: { Limit: number } } }[] } }>("wafv2", "get-web-acl", "--scope", "REGIONAL", "--name", name, "--id", acl?.Id ?? "");
    expect(got?.WebACL.Rules.find((r) => r.Name === "RateLimit")?.Statement.RateBasedStatement?.Limit).toBe(500);

    await page.goto("/waf/web-acls");
    const row = page.getByTestId("resource-table").getByRole("row", { name: new RegExp(name) });
    await expect(row).toBeVisible();
    await row.getByRole("link", { name }).click();
    await expect(page.getByTestId("kv-Name")).toHaveText(name);
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill("delete");
    await page.getByTestId("confirm-delete").click();
    await expect(page).toHaveURL(/\/waf\/web-acls\?deleted=/);
    await expect(page.getByTestId("resource-table").getByRole("row", { name: new RegExp(name) })).toHaveCount(0);
    expect(await findAcl(name)).toBeUndefined();
  } finally {
    const left = await findAcl(name);
    if (left) {
      const g = await aws<{ LockToken: string }>("wafv2", "get-web-acl", "--scope", "REGIONAL", "--name", left.Name, "--id", left.Id);
      await aws("wafv2", "delete-web-acl", "--scope", "REGIONAL", "--name", left.Name, "--id", left.Id, "--lock-token", g?.LockToken ?? "");
    }
  }
});

test("WAF: a Global (CloudFront) IP set is listed, opens, and Edit IP addresses shows its addresses", async ({ page }) => {
  const name = uniqueName("fix-waf-ipset");
  const scopeArgs = ["--scope", "CLOUDFRONT", "--region", "us-east-1"];
  const find = async () => (await aws<{ IPSets?: Summary[] }>("wafv2", "list-ip-sets", ...scopeArgs))?.IPSets?.find((x) => x.Name === name);
  try {
    const created = await aws<{ Summary: Summary }>("wafv2", "create-ip-set", ...scopeArgs, "--name", name, "--ip-address-version", "IPV4", "--addresses", "192.0.2.0/24", "198.51.100.7/32");
    const id = created?.Summary.Id ?? "";
    expect(id).not.toBe("");

    await page.goto("/waf/ip-sets");
    const row = page.getByTestId("resource-table").getByRole("row", { name: new RegExp(name) });
    await expect(row).toContainText("Global (CloudFront)");
    await row.getByRole("link", { name }).click();
    await expect(page.getByTestId("kv-Scope")).toHaveText("Global (CloudFront)");
    await expect(page.getByRole("cell", { name: "198.51.100.7/32" })).toBeVisible();

    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Edit IP addresses" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByTestId("field-addresses")).toHaveValue(/192\.0\.2\.0\/24/);
    await expect(dialog.getByTestId("field-addresses")).toHaveValue(/198\.51\.100\.7\/32/);
    await dialog.getByTestId("action-submit").click();
    await expect(dialog.getByTestId("flash")).toContainText("now has 2 addresses");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    const got = await aws<{ IPSet: { Addresses: string[] } }>("wafv2", "get-ip-set", ...scopeArgs, "--name", name, "--id", id);
    expect([...(got?.IPSet.Addresses ?? [])].sort()).toEqual(["192.0.2.0/24", "198.51.100.7/32"]);
  } finally {
    const left = await find();
    if (left) {
      const g = await aws<{ LockToken: string }>("wafv2", "get-ip-set", ...scopeArgs, "--name", left.Name, "--id", left.Id);
      await aws("wafv2", "delete-ip-set", ...scopeArgs, "--name", left.Name, "--id", left.Id, "--lock-token", g?.LockToken ?? "");
    }
  }
});

test("WAF: a Global (CloudFront) web ACL opens with its scope and offers no regional association", async ({ page }) => {
  const name = uniqueName("fix-waf-cf");
  const scopeArgs = ["--scope", "CLOUDFRONT", "--region", "us-east-1"];
  const find = async () => (await aws<{ WebACLs?: Summary[] }>("wafv2", "list-web-acls", ...scopeArgs))?.WebACLs?.find((x) => x.Name === name);
  try {
    const created = await aws<{ Summary: Summary }>("wafv2", "create-web-acl", ...scopeArgs, "--name", name, "--default-action", "Block={}", "--visibility-config", `SampledRequestsEnabled=true,CloudWatchMetricsEnabled=true,MetricName=${name}`);
    const id = created?.Summary.Id ?? "";
    await page.goto("/waf/web-acls");
    const row = page.getByTestId("resource-table").getByRole("row", { name: new RegExp(name) });
    await expect(row).toContainText("Global (CloudFront)");
    await expect(row).toContainText("Block");
    await row.getByRole("link", { name }).click();
    await expect(page).toHaveURL(new RegExp(`/waf/web-acls/global%3A${id}`));
    await expect(page.getByTestId("kv-Scope")).toHaveText("Global (CloudFront)");
    await page.getByRole("button", { name: "Actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Edit default action" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Associate AWS resource" })).toHaveCount(0);
    await page.getByRole("menuitem", { name: "Edit default action" }).click();
    await expect(page.getByRole("dialog").getByTestId("field-defaultAction").getByRole("radio", { name: "Block" })).toBeChecked();
  } finally {
    const left = await find();
    if (left) {
      const g = await aws<{ LockToken: string }>("wafv2", "get-web-acl", ...scopeArgs, "--name", left.Name, "--id", left.Id);
      await aws("wafv2", "delete-web-acl", ...scopeArgs, "--name", left.Name, "--id", left.Id, "--lock-token", g?.LockToken ?? "");
    }
  }
});
