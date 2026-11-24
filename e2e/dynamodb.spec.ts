import { expect, test } from "@playwright/test";
import { aws, uniqueName } from "./aws-cli";

interface DescribeTable {
  Table: { KeySchema: { AttributeName: string; KeyType: string }[]; GlobalSecondaryIndexes?: { IndexName: string }[] };
}

async function dropTable(name: string): Promise<void> {
  const tables = await aws<{ TableNames: string[] }>("dynamodb", "list-tables");
  if (!tables?.TableNames.includes(name)) return;
  await aws("dynamodb", "update-table", "--table-name", name, "--no-deletion-protection-enabled").catch(() => null);
  await aws("dynamodb", "delete-table", "--table-name", name).catch(() => null);
}

test("DynamoDB: create a table, edit PITR, create/query/edit/delete items, delete the table", async ({ page }) => {
  test.setTimeout(180_000);
  const name = uniqueName("e2e-dynamodb");
  try {
    await page.goto("/dynamodb/tables");
    await expect(page.getByRole("heading", { name: /^Tables/ })).toBeVisible();
    await page.getByRole("link", { name: "Create table" }).first().click();
    await expect(page.getByTestId("create-form")).toBeVisible();
    await page.getByLabel("Table name", { exact: true }).fill(name);
    await page.getByLabel("Partition key", { exact: true }).fill("pk");
    await page.getByLabel("Sort key - optional", { exact: true }).fill("sk");
    await page.getByText("Create a global secondary index").click();
    await page.getByLabel("Index name", { exact: true }).fill("color-index");
    await page.getByLabel("Index partition key", { exact: true }).fill("color");
    await page.getByRole("button", { name: "Create table" }).click();

    await expect(page).toHaveURL(new RegExp(`/dynamodb/tables/${name}`));
    await expect(page.getByTestId("flash")).toContainText(`Created table ${name}`);
    await expect(page.getByTestId("kv-partitionKey")).toHaveText("pk (String)");

    const described = await aws<DescribeTable>("dynamodb", "describe-table", "--table-name", name);
    expect(described?.Table.KeySchema.map((k) => k.AttributeName)).toEqual(["pk", "sk"]);
    expect(described?.Table.GlobalSecondaryIndexes?.map((g) => g.IndexName)).toEqual(["color-index"]);
    await aws("dynamodb", "wait", "table-exists", "--table-name", name);

    // The list shows it.
    await page.goto("/dynamodb/tables");
    await expect(page.getByTestId("resource-table").getByRole("row", { name: new RegExp(name) })).toBeVisible();

    // An action: turn on point-in-time recovery.
    await page.goto(`/dynamodb/tables/${name}`);
    // Click again until the page has hydrated and the tab switches.
    const indexesTab = page.getByRole("tab", { name: "Indexes" });
    await expect(async () => {
      await indexesTab.click();
      await expect(indexesTab).toHaveAttribute("aria-selected", "true", { timeout: 1000 });
    }).toPass();
    await expect(page.getByText("color-index")).toBeVisible();
    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Edit point-in-time recovery" }).click();
    // The dialog opens with PITR off (the table's current state); turn it on.
    await expect(page.getByTestId("field-enabled")).not.toBeChecked();
    await page.getByTestId("field-enabled").check();
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("ENABLED");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    const pitr = await aws<{ ContinuousBackupsDescription: { PointInTimeRecoveryDescription: { PointInTimeRecoveryStatus: string } } }>("dynamodb", "describe-continuous-backups", "--table-name", name);
    expect(pitr?.ContinuousBackupsDescription.PointInTimeRecoveryDescription.PointInTimeRecoveryStatus).toBe("ENABLED");

    // Explore items: create an item in the form view.
    await page.goto(`/dynamodb/explore-items?table=${name}`);
    await expect(page.getByTestId("items-table")).toBeVisible();
    await page.getByRole("button", { name: "Create item" }).click();
    await page.getByLabel("Attribute value 1").fill("user#1");
    await page.getByLabel("Attribute value 2").fill("profile");
    await page.getByRole("button", { name: "Add new attribute" }).click();
    await page.getByLabel("Attribute name 3").fill("color");
    await page.getByLabel("Attribute value 3").fill("blue");
    await page.getByTestId("save-item").click();
    await expect(page.getByTestId("flash")).toContainText("saved successfully");
    await expect(page.getByTestId("items-table")).toContainText("blue");
    const got = await aws<{ Item?: Record<string, { S: string }> }>("dynamodb", "get-item", "--table-name", name, "--key", JSON.stringify({ pk: { S: "user#1" }, sk: { S: "profile" } }));
    expect(got?.Item?.color.S).toBe("blue");

    // Query the GSI.
    await page.getByRole("radio", { name: "Query" }).check();
    await page.getByLabel("Table or index").selectOption("color-index");
    await page.getByLabel("Partition key value").fill("blue");
    await page.getByTestId("run-query").click();
    await expect(page.getByTestId("items-table")).toContainText("user#1");

    // Edit the item in the JSON view.
    await page.getByTestId("items-table").getByRole("button", { name: "user#1" }).click();
    await page.getByRole("tab", { name: "JSON view" }).click();
    await page.getByLabel("Item JSON").fill(JSON.stringify({ pk: "user#1", sk: "profile", color: "blue", size: 3 }));
    await page.getByTestId("save-item").click();
    await expect(page.getByTestId("flash")).toContainText("updated successfully");
    const edited = await aws<{ Item?: Record<string, { N?: string }> }>("dynamodb", "get-item", "--table-name", name, "--key", JSON.stringify({ pk: { S: "user#1" }, sk: { S: "profile" } }));
    expect(edited?.Item?.size.N).toBe("3");

    // Delete the item.
    await page.getByRole("checkbox", { name: /Select item user#1/ }).check();
    await page.getByRole("button", { name: "Delete items" }).click();
    await page.getByTestId("confirm-delete-items").click();
    await expect(page.getByTestId("flash")).toContainText("Deleted 1 item");
    const count = await aws<{ Count: number }>("dynamodb", "scan", "--table-name", name, "--select", "COUNT");
    expect(count?.Count).toBe(0);

    // Delete the table.
    await page.goto(`/dynamodb/tables/${name}`);
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill("delete");
    await page.getByTestId("confirm-delete").click();
    await expect(page).toHaveURL(/\/dynamodb\/tables\?deleted=/);
    await expect.poll(async () => (await aws<{ TableNames: string[] }>("dynamodb", "list-tables"))?.TableNames.includes(name)).toBe(false);
  } finally {
    await dropTable(name);
  }
});

interface TableState {
  Table: {
    BillingModeSummary?: { BillingMode?: string };
    ProvisionedThroughput?: { ReadCapacityUnits?: number; WriteCapacityUnits?: number };
    DeletionProtectionEnabled?: boolean;
    StreamSpecification?: { StreamEnabled?: boolean };
    TableClassSummary?: { TableClass?: string };
    TableArn: string;
  };
}

async function tableSettings(name: string) {
  const t = (await aws<TableState>("dynamodb", "describe-table", "--table-name", name))?.Table;
  const pitr = await aws<{ ContinuousBackupsDescription: { PointInTimeRecoveryDescription?: { PointInTimeRecoveryStatus?: string } } }>("dynamodb", "describe-continuous-backups", "--table-name", name);
  const ttl = await aws<{ TimeToLiveDescription?: { TimeToLiveStatus?: string } }>("dynamodb", "describe-time-to-live", "--table-name", name);
  const tags = await aws<{ Tags?: { Key: string; Value: string }[] }>("dynamodb", "list-tags-of-resource", "--resource-arn", t?.TableArn ?? "");
  return {
    billing: t?.BillingModeSummary?.BillingMode ?? "PROVISIONED",
    rcu: t?.ProvisionedThroughput?.ReadCapacityUnits,
    wcu: t?.ProvisionedThroughput?.WriteCapacityUnits,
    deletionProtection: t?.DeletionProtectionEnabled ?? false,
    stream: t?.StreamSpecification?.StreamEnabled ?? false,
    tableClass: t?.TableClassSummary?.TableClass ?? "STANDARD",
    pitr: pitr?.ContinuousBackupsDescription.PointInTimeRecoveryDescription?.PointInTimeRecoveryStatus ?? "DISABLED",
    ttl: ttl?.TimeToLiveDescription?.TimeToLiveStatus ?? "DISABLED",
    tags: (tags?.Tags ?? []).map((x) => `${x.Key}=${x.Value}`).sort(),
  };
}

test("DynamoDB: Edit dialogs open with the table's current settings and saving unchanged changes nothing", async ({ page }) => {
  test.setTimeout(180_000);
  const name = uniqueName("fix-dynamodb-edit");
  try {
    await aws(
      "dynamodb", "create-table", "--table-name", name,
      "--attribute-definitions", "AttributeName=pk,AttributeType=S", "--key-schema", "AttributeName=pk,KeyType=HASH",
      "--billing-mode", "PROVISIONED", "--provisioned-throughput", "ReadCapacityUnits=3,WriteCapacityUnits=4",
      "--deletion-protection-enabled", "--tags", "Key=env,Value=prod", "Key=team,Value=data",
    );
    await aws("dynamodb", "wait", "table-exists", "--table-name", name);
    const before = await tableSettings(name);
    expect(before).toMatchObject({ billing: "PROVISIONED", rcu: 3, wcu: 4, deletionProtection: true, pitr: "DISABLED", stream: false });

    await page.goto(`/dynamodb/tables/${name}`);
    await page.waitForLoadState("networkidle");
    const dialog = page.getByRole("dialog");
    const open = async (label: string) => {
      await page.getByRole("button", { name: "Actions" }).click();
      await page.getByRole("menuitem", { name: label, exact: true }).click();
      await expect(page.getByTestId("action-submit")).toBeEnabled();
    };
    const saveUnchanged = async () => {
      await page.getByTestId("action-submit").click();
      await expect(dialog.getByTestId("flash")).toContainText("No changes to save.");
      await page.getByRole("button", { name: "Close", exact: true }).last().click();
    };

    await open("Edit read/write capacity");
    await expect(dialog.getByRole("radio", { name: "Provisioned" })).toBeChecked();
    await expect(dialog.getByTestId("field-rcu")).toHaveValue("3");
    await expect(dialog.getByTestId("field-wcu")).toHaveValue("4");
    await saveUnchanged();

    await open("Edit point-in-time recovery");
    await expect(dialog.getByTestId("field-enabled")).not.toBeChecked();
    await saveUnchanged();

    await open("Edit DynamoDB stream");
    await expect(dialog.getByTestId("field-enabled")).not.toBeChecked();
    await saveUnchanged();

    await open("Edit Time to Live (TTL)");
    await expect(dialog.getByTestId("field-enabled")).not.toBeChecked();
    await saveUnchanged();

    await open("Edit CloudWatch Contributor Insights");
    await expect(dialog.getByTestId("field-enabled")).not.toBeChecked();
    await saveUnchanged();

    await open("Edit deletion protection");
    await expect(dialog.getByTestId("field-enabled")).toBeChecked();
    await saveUnchanged();

    await open("Edit table class");
    await expect(dialog.getByRole("radio", { name: "DynamoDB Standard", exact: true })).toBeChecked();
    await saveUnchanged();

    await open("Edit encryption");
    await expect(dialog.getByRole("radio", { name: "Owned by Amazon DynamoDB" })).toBeChecked();
    await saveUnchanged();

    await open("Manage tags");
    // Tag order is up to the API: compare as a set.
    const shownTags = async () => {
      const out: string[] = [];
      for (const i of [1, 2]) out.push(`${await dialog.getByLabel(`Tags key ${i}`).inputValue()}=${await dialog.getByLabel(`Tags value ${i}`).inputValue()}`);
      return out.sort();
    };
    await expect(dialog.getByLabel("Tags key 2")).toBeVisible();
    expect(await shownTags()).toEqual(["env=prod", "team=data"]);
    await page.getByTestId("action-submit").click();
    await expect(dialog.getByTestId("flash")).toContainText("No tag changes.");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();

    expect(await tableSettings(name)).toEqual(before);

    // A real edit: change one tag's value; the other tag stays.
    await open("Manage tags");
    await expect(dialog.getByLabel("Tags key 2")).toBeVisible();
    const teamIndex = (await dialog.getByLabel("Tags key 1").inputValue()) === "team" ? 1 : 2;
    await dialog.getByLabel(`Tags value ${teamIndex}`).fill("platform");
    await page.getByTestId("action-submit").click();
    await expect(dialog.getByTestId("flash")).toContainText("Added or changed 1 tag, removed 0.");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    // DynamoDB tag changes are eventually consistent (on AWS too): wait for them to show.
    await expect.poll(async () => (await tableSettings(name)).tags, { timeout: 30_000 }).toEqual(["env=prod", "team=platform"]);
  } finally {
    await dropTable(name);
  }
});

test("DynamoDB: Contributor Insights graphs show the most accessed keys from the table's managed rules", async ({ page }) => {
  const name = uniqueName("e2e-ddb-insights");
  try {
    await aws(
      "dynamodb", "create-table", "--table-name", name,
      "--attribute-definitions", "AttributeName=pk,AttributeType=S", "AttributeName=sk,AttributeType=S",
      "--key-schema", "AttributeName=pk,KeyType=HASH", "AttributeName=sk,KeyType=RANGE", "--billing-mode", "PAY_PER_REQUEST",
    );
    await aws("dynamodb", "wait", "table-exists", "--table-name", name);

    // Off: the tab says so and offers no graphs.
    await page.goto(`/dynamodb/tables/${name}`);
    await page.getByRole("tab", { name: "Contributor Insights" }).click();
    await expect(page.getByTestId("contributor-insights")).toContainText("Contributor Insights is DISABLED");

    // Turn it on through the console's action, then read and write some items.
    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Edit CloudWatch Contributor Insights" }).click();
    await page.getByTestId("field-enabled").check();
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("Contributor Insights is");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    const described = await aws<{ ContributorInsightsStatus: string; ContributorInsightsRuleList: string[] }>("dynamodb", "describe-contributor-insights", "--table-name", name);
    expect(["ENABLING", "ENABLED"]).toContain(described?.ContributorInsightsStatus);
    for (let i = 0; i < 3; i++) await aws("dynamodb", "put-item", "--table-name", name, "--item", JSON.stringify({ pk: { S: "hot-key" }, sk: { S: `s${i}` } }));
    await aws("dynamodb", "put-item", "--table-name", name, "--item", JSON.stringify({ pk: { S: "cold-key" }, sk: { S: "x" } }));
    await expect.poll(async () => (await aws<{ ContributorInsightsStatus: string }>("dynamodb", "describe-contributor-insights", "--table-name", name))?.ContributorInsightsStatus, { timeout: 30_000 }).toBe("ENABLED");

    const rules = (await aws<{ ContributorInsightsRuleList: string[] }>("dynamodb", "describe-contributor-insights", "--table-name", name))?.ContributorInsightsRuleList ?? [];
    const pkc = rules.find((r) => r.includes("-PKC-")) ?? "";
    expect(pkc).not.toBe("");
    const end = new Date();
    const report = await aws<{ Contributors: { Keys: string[]; ApproximateAggregateValue: number }[] }>(
      "cloudwatch", "get-insight-rule-report", "--rule-name", pkc, "--start-time", new Date(end.getTime() - 3600_000).toISOString(), "--end-time", end.toISOString(), "--period", "60",
    );
    expect(report?.Contributors[0]?.Keys).toEqual(["hot-key"]);

    await page.reload();
    await page.getByRole("tab", { name: "Contributor Insights" }).click();
    const panel = page.getByTestId("contributor-insights");
    const graphs = panel.getByTestId("insights-graph");
    await expect(graphs).toHaveCount(rules.length);
    const accessed = graphs.filter({ hasText: "Most accessed items (partition key)" });
    await expect(accessed.getByTestId("metric-chart")).toBeVisible();
    await expect(accessed.locator("tbody tr").first()).toContainText("hot-key");
    await expect(accessed).toContainText("cold-key");
  } finally {
    await aws("dynamodb", "update-contributor-insights", "--table-name", name, "--contributor-insights-action", "DISABLE").catch(() => null);
    await dropTable(name);
  }
});
