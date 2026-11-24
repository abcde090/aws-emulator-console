import { expect, test, type Page } from "@playwright/test";
import { aws, uniqueName } from "./aws-cli";

interface DistConfigOut {
  ETag: string;
  DistributionConfig: Record<string, unknown>;
}

/** Best-effort CLI cleanup: disable, wait for Deployed, delete. */
async function removeDistribution(id: string): Promise<void> {
  const cfg = await aws<DistConfigOut>("cloudfront", "get-distribution-config", "--id", id).catch(() => null);
  if (!cfg) return;
  if (cfg.DistributionConfig.Enabled) {
    await aws("cloudfront", "update-distribution", "--id", id, "--if-match", cfg.ETag, "--distribution-config", JSON.stringify({ ...cfg.DistributionConfig, Enabled: false }));
  }
  for (let i = 0; i < 60; i++) {
    const d = await aws<{ ETag: string; Distribution: { Status: string } }>("cloudfront", "get-distribution", "--id", id);
    if (d?.Distribution.Status === "Deployed") {
      await aws("cloudfront", "delete-distribution", "--id", id, "--if-match", d.ETag);
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function removeOacsNamed(name: string): Promise<void> {
  const list = await aws<{ OriginAccessControlList?: { Items?: { Id: string; Name: string }[] } }>("cloudfront", "list-origin-access-controls");
  for (const o of list?.OriginAccessControlList?.Items ?? []) {
    if (o.Name !== name) continue;
    const g = await aws<{ ETag: string }>("cloudfront", "get-origin-access-control", "--id", o.Id);
    if (g) await aws("cloudfront", "delete-origin-access-control", "--id", o.Id, "--if-match", g.ETag).catch(() => null);
  }
}

async function runAction(page: Page, label: string, fill?: () => Promise<void>): Promise<void> {
  await page.getByRole("button", { name: "Actions" }).click();
  await page.getByRole("menuitem", { name: label, exact: true }).click();
  if (fill) await fill();
  await page.getByTestId("action-submit").click();
}

const closeDialog = (page: Page) => page.getByRole("button", { name: "Close", exact: true }).last().click();

/** Resources made by the running test, removed in afterEach even when the test fails or times out. */
const made = { distId: "", bucket: "", oacName: "", cpName: "" };

test.afterEach(async () => {
  test.setTimeout(120_000);
  if (made.distId) await removeDistribution(made.distId).catch(() => null);
  if (made.bucket) {
    await removeOacsNamed(made.bucket).catch(() => null);
    await aws("s3api", "delete-bucket-policy", "--bucket", made.bucket).catch(() => null);
    await aws("s3api", "delete-bucket", "--bucket", made.bucket).catch(() => null);
  }
  if (made.oacName) await removeOacsNamed(made.oacName).catch(() => null);
  if (made.cpName) {
    const custom = await aws<{ CachePolicyList: { Items?: { CachePolicy: { Id: string; CachePolicyConfig: { Name: string } } }[] } }>("cloudfront", "list-cache-policies", "--type", "custom").catch(() => null);
    for (const p of custom?.CachePolicyList.Items ?? []) {
      if (p.CachePolicy.CachePolicyConfig.Name !== made.cpName) continue;
      const g = await aws<{ ETag: string }>("cloudfront", "get-cache-policy", "--id", p.CachePolicy.Id).catch(() => null);
      if (g) await aws("cloudfront", "delete-cache-policy", "--id", p.CachePolicy.Id, "--if-match", g.ETag).catch(() => null);
    }
  }
  Object.assign(made, { distId: "", bucket: "", oacName: "", cpName: "" });
});

test("CloudFront: create a distribution with an S3 origin and OAC, invalidate, disable, delete", async ({ page }) => {
  test.setTimeout(150_000);
  const bucket = uniqueName("e2e-cloudfront-bkt");
  const comment = uniqueName("e2e-cloudfront-dist");
  made.bucket = bucket;
  await aws("s3api", "create-bucket", "--bucket", bucket);
  let distId = "";
  {
    await page.goto("/cloudfront/distributions");
    await expect(page.getByRole("heading", { name: /^Distributions/ })).toBeVisible();
    await page.getByRole("link", { name: "Create distribution" }).first().click();
    await expect(page.getByTestId("create-form")).toBeVisible();
    await page.getByLabel("Origin domain").selectOption({ label: bucket });
    await page.getByLabel("Origin access control", { exact: true }).selectOption({ label: "Create new OAC (named after the bucket)" });
    await page.getByRole("radio", { name: "Redirect HTTP to HTTPS" }).check();
    await page.getByLabel("Default root object").fill("index.html");
    await page.getByLabel("Description").fill(comment);
    await page.getByRole("button", { name: "Create distribution" }).click();

    await expect(page).toHaveURL(/\/cloudfront\/distributions\/[A-Z0-9]+\?created=/);
    distId = new URL(page.url()).pathname.split("/").pop() ?? "";
    made.distId = distId;
    await expect(page.getByTestId("flash")).toContainText(`Created distribution ${distId}`);
    await expect(page.getByTestId("kv-State")).toHaveText(/Enabled/);

    const listed = await aws<{ DistributionList: { Items?: { Id: string; Comment: string }[] } }>("cloudfront", "list-distributions");
    expect(listed?.DistributionList.Items?.find((d) => d.Id === distId)?.Comment).toBe(comment);

    await page.getByRole("tab", { name: "Origins" }).click();
    await expect(page.getByText(`${bucket}.s3.us-east-1.amazonaws.com`).first()).toBeVisible();
    await page.getByRole("tab", { name: "Behaviors" }).click();
    await expect(page.getByText("Redirect HTTP to HTTPS")).toBeVisible();

    await runAction(page, "Create invalidation", () => page.getByLabel("Add object paths").fill("/*"));
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("Invalidation");
    await closeDialog(page);

    await runAction(page, "Update S3 bucket policy", () => page.getByRole("radio", { name: /Add the statement/ }).check());
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("Bucket policy updated");
    await closeDialog(page);
    const policy = await aws<{ Policy: string }>("s3api", "get-bucket-policy", "--bucket", bucket);
    expect(policy?.Policy).toContain(distId);

    // Deleting an enabled distribution is refused, as in the console.
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill("delete");
    await page.getByTestId("confirm-delete").click();
    await expect(page.getByRole("dialog")).toContainText("Disable the distribution first");
    await page.getByRole("button", { name: "Cancel" }).last().click();

    await runAction(page, "Disable");
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("Disabling");
    await closeDialog(page);

    // Wait for the emulator to finish deploying the change.
    await expect.poll(async () => (await aws<{ Distribution: { Status: string } }>("cloudfront", "get-distribution", "--id", distId))?.Distribution.Status, { timeout: 60_000 }).toBe("Deployed");

    await page.goto("/cloudfront/distributions");
    const row = page.getByTestId("resource-table").getByRole("row", { name: new RegExp(distId) });
    await expect(row).toContainText("Disabled");
    await row.getByRole("radio").check();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill("delete");
    await page.getByTestId("confirm-delete").click();
    await expect(page.getByTestId("flash")).toContainText(`Deleted distribution ${distId}`);
    const after = await aws<{ DistributionList: { Items?: { Id: string }[] } }>("cloudfront", "list-distributions");
    expect((after?.DistributionList.Items ?? []).some((d) => d.Id === distId)).toBe(false);
    made.distId = "";
  }
});

test("CloudFront: origin access control and cache policy create, edit, delete", async ({ page }) => {
  const oacName = uniqueName("e2e-cloudfront-oac");
  const cpName = uniqueName("e2e-cloudfront-cp");
  Object.assign(made, { oacName, cpName });
  {
    await page.goto("/cloudfront/origin-access/create");
    await page.getByLabel("Name", { exact: true }).fill(oacName);
    await page.getByLabel("Description").fill("e2e");
    await page.getByRole("button", { name: "Create control setting" }).click();
    await expect(page.getByTestId("flash")).toContainText("Created origin access control");
    await expect(page.getByTestId("kv-Name")).toHaveText(oacName);
    const oacs = await aws<{ OriginAccessControlList: { Items?: { Name: string }[] } }>("cloudfront", "list-origin-access-controls");
    expect(oacs?.OriginAccessControlList.Items?.some((o) => o.Name === oacName)).toBe(true);

    await runAction(page, "Edit", async () => {
      await expect(page.getByTestId("field-name")).toHaveValue(oacName);
      await expect(page.getByTestId("field-description")).toHaveValue("e2e");
      await page.getByRole("dialog").getByRole("radio", { name: "Do not sign requests" }).check();
    });
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("saved");
    await closeDialog(page);
    await expect(page.getByTestId("kv-Signing behavior")).toHaveText("Do not sign requests");

    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill("delete");
    await page.getByTestId("confirm-delete").click();
    await expect(page).toHaveURL(/\/cloudfront\/origin-access\?deleted=/);

    await page.goto("/cloudfront/cache-policies/create");
    await page.getByLabel("Name", { exact: true }).fill(cpName);
    await page.getByLabel("Default TTL").fill("60");
    await page.getByLabel(/^Query strings/).selectOption("all");
    await page.getByRole("button", { name: "Create cache policy" }).click();
    await expect(page.getByTestId("kv-Name")).toHaveText(cpName);
    const custom = await aws<{ CachePolicyList: { Items?: { CachePolicy: { CachePolicyConfig: { Name: string; DefaultTTL: number } } }[] } }>("cloudfront", "list-cache-policies", "--type", "custom");
    expect(custom?.CachePolicyList.Items?.find((p) => p.CachePolicy.CachePolicyConfig.Name === cpName)?.CachePolicy.CachePolicyConfig.DefaultTTL).toBe(60);
    await page.goto("/cloudfront/cache-policies");
    const row = page.getByTestId("resource-table").getByRole("row", { name: new RegExp(cpName) });
    await row.getByRole("radio").check();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill("delete");
    await page.getByTestId("confirm-delete").click();
    await expect(page.getByTestId("flash")).toContainText("Deleted cache policy");
  }
});

const MANAGED_CACHING_OPTIMIZED = "658327ea-f89d-4fab-a63d-7e88639e58f6";

interface OacOut {
  ETag: string;
  OriginAccessControl: { Id: string; OriginAccessControlConfig: { Name: string; Description: string; SigningBehavior: string } };
}

test("CloudFront: Edit dialogs open on the current values and saving unchanged changes nothing", async ({ page }) => {
  test.setTimeout(150_000);
  const comment = uniqueName("fix-cloudfront-dist");
  const oacName = uniqueName("fix-cloudfront-oac");
  const cpName = uniqueName("fix-cloudfront-cp");
  Object.assign(made, { oacName, cpName });

  // A distribution with non-default settings and a tag, made with the CLI.
  const created = await aws<{ Distribution: { Id: string; ARN: string } }>(
    "cloudfront", "create-distribution-with-tags", "--distribution-config-with-tags",
    JSON.stringify({
      DistributionConfig: {
        CallerReference: comment,
        Comment: comment,
        Enabled: true,
        DefaultRootObject: "home.html",
        PriceClass: "PriceClass_100",
        HttpVersion: "http2and3",
        IsIPV6Enabled: false,
        Origins: { Quantity: 1, Items: [{ Id: "web", DomainName: "example.com", CustomOriginConfig: { HTTPPort: 80, HTTPSPort: 443, OriginProtocolPolicy: "https-only" } }] },
        DefaultCacheBehavior: { TargetOriginId: "web", ViewerProtocolPolicy: "allow-all", CachePolicyId: MANAGED_CACHING_OPTIMIZED },
      },
      Tags: { Items: [{ Key: "env", Value: "fix" }] },
    })
  );
  const distId = created?.Distribution.Id ?? "";
  made.distId = distId;
  expect(distId).toBeTruthy();
  const config = async () => (await aws<DistConfigOut>("cloudfront", "get-distribution-config", "--id", distId))?.DistributionConfig ?? {};
  const before = await config();

  await page.goto(`/cloudfront/distributions/${distId}`);
  // Enabled distributions offer Disable, not Enable.
  await page.getByRole("button", { name: "Actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Disable", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Enable", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await runAction(page, "Edit settings", async () => {
    await expect(page.getByTestId("field-comment")).toHaveValue(comment);
    await expect(page.getByTestId("field-defaultRootObject")).toHaveValue("home.html");
    await expect(page.getByTestId("field-priceClass")).toHaveValue("PriceClass_100");
    await expect(page.getByTestId("field-httpVersion")).toHaveValue("http2and3");
    await expect(page.getByTestId("field-ipv6")).not.toBeChecked();
  });
  await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("Settings saved");
  await closeDialog(page);
  const after = await config();
  for (const k of ["Comment", "DefaultRootObject", "PriceClass", "HttpVersion", "IsIPV6Enabled"]) expect(after[k]).toEqual(before[k]);

  // Clearing the default root object removes it.
  await runAction(page, "Edit settings", () => page.getByTestId("field-defaultRootObject").fill(""));
  await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("Settings saved");
  await closeDialog(page);
  expect((await config()).DefaultRootObject ?? "").toBe("");

  // Manage tags opens with the existing tag; saving unchanged keeps it.
  await runAction(page, "Manage tags", async () => {
    await expect(page.getByTestId("field-tags").locator("input").first()).toHaveValue("env");
  });
  await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("No tag changes");
  await closeDialog(page);
  const tags = await aws<{ Tags: { Items: { Key: string; Value: string }[] } }>("cloudfront", "list-tags-for-resource", "--resource", created?.Distribution.ARN ?? "");
  expect(tags?.Tags.Items).toEqual([{ Key: "env", Value: "fix" }]);

  // OAC Edit opens on the current name, description and signing behavior.
  const oac = await aws<OacOut>("cloudfront", "create-origin-access-control", "--origin-access-control-config",
    JSON.stringify({ Name: oacName, Description: "fix oac", SigningProtocol: "sigv4", SigningBehavior: "no-override", OriginAccessControlOriginType: "s3" }));
  const oacId = oac?.OriginAccessControl.Id ?? "";
  await page.goto(`/cloudfront/origin-access/${oacId}`);
  await runAction(page, "Edit", async () => {
    await expect(page.getByTestId("field-name")).toHaveValue(oacName);
    await expect(page.getByTestId("field-description")).toHaveValue("fix oac");
    await expect(page.getByRole("dialog").getByRole("radio", { name: /do not override/ })).toBeChecked();
  });
  await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("saved");
  await closeDialog(page);
  const oacAfter = (await aws<OacOut>("cloudfront", "get-origin-access-control", "--id", oacId))?.OriginAccessControl.OriginAccessControlConfig;
  expect(oacAfter).toMatchObject({ Name: oacName, Description: "fix oac", SigningBehavior: "no-override" });

  // Cache policy Edit TTL settings opens on the policy's TTLs.
  const cp = await aws<{ CachePolicy: { Id: string } }>("cloudfront", "create-cache-policy", "--cache-policy-config", JSON.stringify({
    Name: cpName, MinTTL: 5, DefaultTTL: 50, MaxTTL: 500,
    ParametersInCacheKeyAndForwardedToOrigin: {
      EnableAcceptEncodingGzip: false,
      HeadersConfig: { HeaderBehavior: "none" }, CookiesConfig: { CookieBehavior: "none" }, QueryStringsConfig: { QueryStringBehavior: "none" },
    },
  }));
  const cpId = cp?.CachePolicy.Id ?? "";
  await page.goto(`/cloudfront/cache-policies/${cpId}`);
  await runAction(page, "Edit TTL settings", async () => {
    await expect(page.getByTestId("field-minTTL")).toHaveValue("5");
    await expect(page.getByTestId("field-defaultTTL")).toHaveValue("50");
    await expect(page.getByTestId("field-maxTTL")).toHaveValue("500");
  });
  await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("TTL settings saved");
  await closeDialog(page);
  const cpAfter = await aws<{ CachePolicy: { CachePolicyConfig: { MinTTL: number; DefaultTTL: number; MaxTTL: number } } }>("cloudfront", "get-cache-policy", "--id", cpId);
  expect(cpAfter?.CachePolicy.CachePolicyConfig).toMatchObject({ MinTTL: 5, DefaultTTL: 50, MaxTTL: 500 });
});
