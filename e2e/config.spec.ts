import { expect, test } from "@playwright/test";
import { aws, uniqueName } from "./aws-cli";

const names = async () => ((await aws<{ StoredQueryMetadata: { QueryName: string }[] }>("configservice", "list-stored-queries"))?.StoredQueryMetadata ?? []).map((q) => q.QueryName);

test("Config: save an advanced query, run it, delete it", async ({ page }) => {
  const name = uniqueName("e2e-config-q");
  try {
    await page.goto("/config/advanced-queries");
    await expect(page.getByRole("heading", { name: /^Advanced queries/ })).toBeVisible();
    await page.getByRole("link", { name: "Save query" }).first().click();
    await page.getByLabel("Query name").fill(name);
    await page.getByLabel("Query", { exact: true }).fill("SELECT resourceId, resourceType WHERE resourceType = 'AWS::S3::Bucket'");
    await page.getByRole("button", { name: "Save query" }).click();
    await expect(page.getByTestId("kv-Query name")).toHaveText(name);
    expect(await names()).toContain(name);

    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Run", exact: true }).click();
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText(/result/);
    await page.getByRole("button", { name: "Close", exact: true }).last().click();

    await page.goto("/config/advanced-queries");
    const row = page.getByTestId("resource-table").getByRole("row", { name: new RegExp(name) });
    await expect(row).toBeVisible();
    await row.getByRole("radio").check();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill("delete");
    await page.getByTestId("confirm-delete").click();
    await expect(page.getByTestId("resource-table").getByRole("row", { name: new RegExp(name) })).toHaveCount(0);
    expect(await names()).not.toContain(name);
  } finally {
    if ((await names()).includes(name)) await aws("configservice", "delete-stored-query", "--query-name", name);
  }
});

test("Config: rules page and resource inventory render", async ({ page }) => {
  await page.goto("/config/rules");
  await expect(page.getByRole("heading", { name: /^Rules/ })).toBeVisible();
  await page.goto("/config/rules/create");
  await expect(page.getByLabel("AWS managed rule")).toBeVisible();
  await page.goto("/config/resources");
  await expect(page.getByRole("heading", { name: /^Resources/ })).toBeVisible();
});

test("Config: Edit dialogs show current values and saving unchanged changes nothing", async ({ page }) => {
  const query = uniqueName("fix-config-q");
  const rule = uniqueName("fix-config-rule");
  const expression = "SELECT resourceId WHERE resourceType = 'AWS::S3::Bucket'";
  const recorder = uniqueName("fix-config-rec");
  const bucket = `${recorder}-b`;
  let ownRecorder = false;
  const ruleNames = async () => ((await aws<{ ConfigRules: { ConfigRuleName: string }[] }>("configservice", "describe-config-rules"))?.ConfigRules ?? []).map((r) => r.ConfigRuleName);
  try {
    await aws("configservice", "put-stored-query", "--stored-query", JSON.stringify({ QueryName: query, Description: "keep me", Expression: expression }));
    await page.goto(`/config/advanced-queries/${query}`);
    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Edit query" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByTestId("field-description")).toHaveValue("keep me");
    await expect(dialog.getByTestId("field-expression")).toHaveValue(expression);
    await page.getByTestId("action-submit").click();
    await expect(dialog.getByTestId("flash")).toContainText("No changes to save");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    // A real change keeps the expression.
    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Edit query" }).click();
    await dialog.getByTestId("field-description").fill("changed");
    await page.getByTestId("action-submit").click();
    await expect(dialog.getByTestId("flash")).toContainText("Query saved");
    const q = (await aws<{ StoredQuery: { Description: string; Expression: string } }>("configservice", "get-stored-query", "--query-name", query))?.StoredQuery;
    expect(q).toMatchObject({ Description: "changed", Expression: expression });

    // Rules need a configuration recorder (one per Region). Create our own only if there is none, and remove it after.
    const recs = (await aws<{ ConfigurationRecorders: { name: string }[] }>("configservice", "describe-configuration-recorders"))?.ConfigurationRecorders ?? [];
    if (recs.length === 0) {
      await aws("configservice", "put-configuration-recorder", "--configuration-recorder", JSON.stringify({
        name: recorder, roleARN: "arn:aws:iam::000000000000:role/aws-service-role/config.amazonaws.com/AWSServiceRoleForConfig",
        recordingGroup: { allSupported: true, includeGlobalResourceTypes: false }, recordingMode: { recordingFrequency: "DAILY" },
      }));
      ownRecorder = true;
      await aws("s3api", "create-bucket", "--bucket", bucket);
      await aws("s3api", "put-bucket-policy", "--bucket", bucket, "--policy", JSON.stringify({
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Principal: { Service: "config.amazonaws.com" }, Action: ["s3:GetBucketAcl", "s3:ListBucket", "s3:PutObject"], Resource: [`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/*`] }],
      }));
      await aws("configservice", "put-delivery-channel", "--delivery-channel", JSON.stringify({ name: "default", s3BucketName: bucket, s3KeyPrefix: "keep", configSnapshotDeliveryProperties: { deliveryFrequency: "Six_Hours" } }));

      // Settings: Edit recording frequency and Edit delivery channel show the current values; saving unchanged keeps them.
      await page.goto(`/config/settings/${recorder}`);
      await page.getByRole("button", { name: "Actions" }).click();
      await expect(page.getByRole("menuitem", { name: "Stop recording" })).toHaveCount(0);
      await page.getByRole("menuitem", { name: "Edit recording frequency" }).click();
      await expect(dialog.getByTestId("field-frequency").locator('input[value="DAILY"]')).toBeChecked();
      await page.getByTestId("action-submit").click();
      await expect(dialog.getByTestId("flash")).toContainText("No changes to save");
      await page.getByRole("button", { name: "Close", exact: true }).last().click();
      await page.getByRole("button", { name: "Actions" }).click();
      await page.getByRole("menuitem", { name: "Edit delivery channel" }).click();
      await expect(dialog.getByTestId("field-bucket")).toHaveValue(bucket);
      await expect(dialog.getByTestId("field-prefix")).toHaveValue("keep");
      await expect(dialog.getByTestId("field-snapshot")).toHaveValue("Six_Hours");
      await page.getByTestId("action-submit").click();
      await expect(dialog.getByTestId("flash")).toContainText("Delivery channel saved");
      await page.getByRole("button", { name: "Close", exact: true }).last().click();
      const ch = (await aws<{ DeliveryChannels: { s3BucketName: string; s3KeyPrefix: string; configSnapshotDeliveryProperties: { deliveryFrequency: string } }[] }>("configservice", "describe-delivery-channels"))?.DeliveryChannels[0];
      expect(ch).toMatchObject({ s3BucketName: bucket, s3KeyPrefix: "keep", configSnapshotDeliveryProperties: { deliveryFrequency: "Six_Hours" } });
      const rec = (await aws<{ ConfigurationRecorders: { recordingMode: { recordingFrequency: string } }[] }>("configservice", "describe-configuration-recorders"))?.ConfigurationRecorders[0];
      expect(rec?.recordingMode.recordingFrequency).toBe("DAILY");
    }

    // Rule: periodic frequency and parameters are shown and kept.
    await aws("configservice", "put-config-rule", "--config-rule", JSON.stringify({
      ConfigRuleName: rule, Description: "keep me", Source: { Owner: "AWS", SourceIdentifier: "IAM_PASSWORD_POLICY" },
      InputParameters: JSON.stringify({ MinimumPasswordLength: "16" }), MaximumExecutionFrequency: "Six_Hours",
    }));
    await page.goto(`/config/rules/${rule}`);
    await page.getByRole("button", { name: "Actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Delete remediation" })).toHaveCount(0);
    await page.getByRole("menuitem", { name: "Edit rule" }).click();
    await expect(dialog.getByTestId("field-description")).toHaveValue("keep me");
    await expect(dialog.getByTestId("field-frequency")).toHaveValue("Six_Hours");
    await expect(dialog.getByTestId("field-parameters")).toHaveValue(/MinimumPasswordLength/);
    await page.getByTestId("action-submit").click();
    await expect(dialog.getByTestId("flash")).toContainText("Rule updated");
    const r = (await aws<{ ConfigRules: { Description: string; MaximumExecutionFrequency: string; InputParameters: string; Source: { SourceIdentifier: string } }[] }>("configservice", "describe-config-rules", "--config-rule-names", rule))?.ConfigRules[0];
    expect(r).toMatchObject({ Description: "keep me", MaximumExecutionFrequency: "Six_Hours", Source: { SourceIdentifier: "IAM_PASSWORD_POLICY" } });
    expect(JSON.parse(r?.InputParameters ?? "{}")).toEqual({ MinimumPasswordLength: "16" });
  } finally {
    if ((await names()).includes(query)) await aws("configservice", "delete-stored-query", "--query-name", query);
    if ((await ruleNames()).includes(rule)) await aws("configservice", "delete-config-rule", "--config-rule-name", rule);
    if (ownRecorder) {
      await aws("configservice", "delete-delivery-channel", "--delivery-channel-name", "default").catch(() => null);
      await aws("configservice", "delete-configuration-recorder", "--configuration-recorder-name", recorder);
      await aws("s3", "rb", `s3://${bucket}`, "--force").catch(() => null);
    }
  }
});
