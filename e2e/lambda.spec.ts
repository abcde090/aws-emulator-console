import { expect, test } from "@playwright/test";
import { aws, uniqueName } from "./aws-cli";

async function cleanupFunction(name: string) {
  const fn = await aws<{ Configuration?: { Role?: string } }>("lambda", "get-function", "--function-name", name).catch(() => null);
  if (fn) await aws("lambda", "delete-function", "--function-name", name).catch(() => null);
  await aws("logs", "delete-log-group", "--log-group-name", `/aws/lambda/${name}`).catch(() => null);
  // "Create a new role with basic Lambda permissions" makes <name>-role-<suffix>.
  const roles = await aws<{ Roles?: { RoleName?: string }[] }>("iam", "list-roles", "--path-prefix", "/service-role/");
  for (const r of roles?.Roles ?? []) {
    if (!r.RoleName?.startsWith(`${name}-role-`)) continue;
    await aws("iam", "detach-role-policy", "--role-name", r.RoleName, "--policy-arn", "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole").catch(() => null);
    await aws("iam", "delete-role", "--role-name", r.RoleName);
  }
}

test("Lambda: create a function, edit and deploy code, test it, set env vars, delete it", async ({ page }) => {
  test.setTimeout(120_000);
  const name = uniqueName("e2e-lambda");
  try {
    await page.goto("/lambda/functions");
    await expect(page.getByRole("heading", { name: /^Functions/ })).toBeVisible();
    await page.getByRole("link", { name: "Create function" }).first().click();
    await page.getByLabel("Function name").fill(name);
    await page.getByLabel("Runtime", { exact: true }).selectOption("nodejs22.x");
    await page.getByRole("button", { name: "Create function" }).click();

    await expect(page).toHaveURL(new RegExp(`/lambda/functions/${name}`));
    await expect(page.getByTestId("flash")).toContainText(`Successfully created the function ${name}`);
    await expect(page.getByTestId("kv-Runtime")).toHaveText("nodejs22.x");

    const fn = await aws<{ Configuration?: { Handler?: string; Role?: string } }>("lambda", "get-function", "--function-name", name);
    expect(fn?.Configuration?.Handler).toBe("index.handler");
    expect(fn?.Configuration?.Role).toContain(`${name}-role-`);

    // Code tab: edit and deploy.
    const editor = page.getByTestId("code-editor");
    await expect(editor).toHaveValue(/Hello from Lambda!/);
    await editor.fill("export const handler = async (event) => {\n  console.log('e2e event', JSON.stringify(event));\n  return { statusCode: 200, body: 'e2e says ' + event.who };\n};\n");
    await expect(page.getByTestId("undeployed")).toBeVisible();
    await page.getByTestId("deploy-code").click();
    await expect(page.getByTestId("code-tab").getByTestId("flash")).toContainText(`Successfully updated the function ${name}`);

    // Test tab: invoke with an event.
    await page.getByRole("tab", { name: "Test" }).click();
    await page.getByLabel("Event JSON").fill('{"who": "playwright"}');
    await page.getByTestId("test-invoke").click();
    await expect(page.getByTestId("test-result")).toContainText("Executing function: succeeded");
    await expect(page.getByTestId("test-response")).toContainText("e2e says playwright");
    await expect(page.getByTestId("test-log")).toContainText("REPORT RequestId");
    await expect(page.getByTestId("test-log")).toContainText("e2e event");

    // Configuration action: environment variables.
    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Edit environment variables" }).click();
    await page.getByRole("button", { name: "Add new tag" }).click();
    await page.getByLabel("Environment variables key 1").fill("STAGE");
    await page.getByLabel("Environment variables value 1").fill("e2e");
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("Saved 1 environment variable");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    const cfg = await aws<{ Environment?: { Variables?: Record<string, string> } }>("lambda", "get-function-configuration", "--function-name", name);
    expect(cfg?.Environment?.Variables?.STAGE).toBe("e2e");

    // Listed, then deleted from the list.
    await page.goto("/lambda/functions");
    const row = page.getByTestId("resource-table").getByRole("row", { name: new RegExp(name) });
    await expect(row).toBeVisible();
    await row.getByRole("radio").check();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill("delete");
    await page.getByTestId("confirm-delete").click();
    await expect(page.getByTestId("flash")).toContainText(`Deleted function ${name}`);
    const after = await aws<{ Functions?: { FunctionName?: string }[] }>("lambda", "list-functions");
    expect((after?.Functions ?? []).some((f) => f.FunctionName === name)).toBe(false);
  } finally {
    await cleanupFunction(name);
  }
});

test("Lambda: SQS trigger through an event source mapping", async ({ page }) => {
  const name = uniqueName("e2e-lambda-esm");
  const queue = uniqueName("e2e-lambda-q");
  const role = uniqueName("e2e-lambda-role");
  try {
    const roleArn = (await aws<{ Role: { Arn: string } }>("iam", "create-role", "--role-name", role, "--assume-role-policy-document", JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] })))?.Role.Arn as string;
    await aws("iam", "attach-role-policy", "--role-name", role, "--policy-arn", "arn:aws:iam::aws:policy/service-role/AWSLambdaSQSQueueExecutionRole");
    await aws("sqs", "create-queue", "--queue-name", queue);

    await page.goto("/lambda/functions/create");
    await page.getByLabel("Function name").fill(name);
    await page.getByLabel("Runtime", { exact: true }).selectOption("python3.13");
    await page.getByRole("radio", { name: "Use an existing role" }).check();
    await page.getByRole("combobox", { name: "Existing role" }).selectOption(roleArn);
    await page.getByRole("button", { name: "Create function" }).click();
    await expect(page.getByTestId("kv-Handler")).toHaveText("lambda_function.lambda_handler");

    await page.goto("/lambda/event-source-mappings/create");
    await page.getByLabel("Lambda function").selectOption(name);
    await page.getByLabel("Event source").selectOption({ label: `SQS: ${queue}` });
    await page.getByLabel("Batch size").fill("5");
    await page.getByRole("button", { name: "Create event source mapping" }).click();
    await expect(page.getByTestId("kv-Event source")).toContainText(queue);
    const maps = await aws<{ EventSourceMappings?: { UUID?: string; BatchSize?: number }[] }>("lambda", "list-event-source-mappings", "--function-name", name);
    expect(maps?.EventSourceMappings?.[0]?.BatchSize).toBe(5);
    // A new mapping is "Creating" for a moment and refuses updates (ResourceInUseException), as in AWS.
    const uuid = maps?.EventSourceMappings?.[0]?.UUID as string;
    await expect.poll(async () => (await aws<{ State?: string }>("lambda", "get-event-source-mapping", "--uuid", uuid))?.State, { timeout: 30_000 }).toBe("Enabled");

    // Edit batch settings opens with the current batch size; saving unchanged changes nothing.
    await page.reload();
    await page.getByRole("button", { name: "Actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Enable", exact: true })).toHaveCount(0);
    await page.getByRole("menuitem", { name: "Edit batch settings" }).click();
    await expect(page.getByTestId("field-batchSize")).toHaveValue("5");
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("No changes");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    expect((await aws<{ BatchSize?: number }>("lambda", "get-event-source-mapping", "--uuid", uuid))?.BatchSize).toBe(5);

    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Disable" }).click();
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("Trigger state");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    // Lambda refuses to delete a mapping while it is still Disabling, as in AWS.
    await expect.poll(async () => (await aws<{ State?: string }>("lambda", "get-event-source-mapping", "--uuid", uuid))?.State, { timeout: 30_000 }).toBe("Disabled");
    await page.reload();
    await expect(page.getByTestId("kv-State")).toHaveText("Disabled");

    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill("delete");
    await page.getByTestId("confirm-delete").click();
    await expect(page).toHaveURL(/\/lambda\/event-source-mappings\?deleted=/);
  } finally {
    for (const m of (await aws<{ EventSourceMappings?: { UUID?: string }[] }>("lambda", "list-event-source-mappings", "--function-name", name).catch(() => null))?.EventSourceMappings ?? []) {
      await aws("lambda", "delete-event-source-mapping", "--uuid", m.UUID as string).catch(() => null);
    }
    await cleanupFunction(name);
    const url = (await aws<{ QueueUrl?: string }>("sqs", "get-queue-url", "--queue-name", queue).catch(() => null))?.QueueUrl;
    if (url) await aws("sqs", "delete-queue", "--queue-url", url);
    await aws("iam", "detach-role-policy", "--role-name", role, "--policy-arn", "arn:aws:iam::aws:policy/service-role/AWSLambdaSQSQueueExecutionRole").catch(() => null);
    await aws("iam", "delete-role", "--role-name", role).catch(() => null);
  }
});

test("Lambda: publish a layer from an uploaded .zip, then delete it", async ({ page }) => {
  const name = uniqueName("e2e-lambda-layer");
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  zip.file("nodejs/node_modules/e2e-util/index.js", "module.exports = () => 'from layer';\n");
  const buffer = Buffer.from(await zip.generateAsync({ type: "uint8array" }));
  try {
    await page.goto("/lambda/layers");
    await page.getByRole("link", { name: "Create layer" }).first().click();
    await page.getByLabel("Name", { exact: true }).fill(name);
    await page.getByLabel("Description").fill("e2e layer");
    await page.getByLabel("Upload a .zip file").setInputFiles({ name: "layer.zip", mimeType: "application/zip", buffer });
    await page.getByLabel("Compatible runtimes").selectOption(["nodejs22.x"]);
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/lambda/layers/${name}`));
    await expect(page.getByTestId("kv-Latest version")).toHaveText("1");
    const versions = await aws<{ LayerVersions?: { Version?: number; CompatibleRuntimes?: string[] }[] }>("lambda", "list-layer-versions", "--layer-name", name);
    expect(versions?.LayerVersions?.[0]?.CompatibleRuntimes).toEqual(["nodejs22.x"]);
    await expect(async () => {
      await page.getByRole("button", { name: "Delete", exact: true }).click();
      await expect(page.getByLabel("Confirm deletion")).toBeVisible({ timeout: 1000 });
    }).toPass();
    await page.getByLabel("Confirm deletion").fill("delete");
    await page.getByTestId("confirm-delete").click();
    await expect(page).toHaveURL(/\/lambda\/layers\?deleted=/);
    const after = await aws<{ LayerVersions?: unknown[] }>("lambda", "list-layer-versions", "--layer-name", name);
    expect(after?.LayerVersions ?? []).toHaveLength(0);
  } finally {
    const left = await aws<{ LayerVersions?: { Version?: number }[] }>("lambda", "list-layer-versions", "--layer-name", name).catch(() => null);
    for (const v of left?.LayerVersions ?? []) await aws("lambda", "delete-layer-version", "--layer-name", name, "--version-number", String(v.Version));
  }
});

test("Lambda: Edit dialogs open with the current settings and saving unchanged changes nothing", async ({ page }) => {
  test.setTimeout(150_000);
  const name = uniqueName("fix-lambda-edit");
  type Cfg = { MemorySize?: number; Timeout?: number; Description?: string; Runtime?: string; Handler?: string; EphemeralStorage?: { Size?: number }; Environment?: { Variables?: Record<string, string> } };
  const cfg = () => aws<Cfg>("lambda", "get-function-configuration", "--function-name", name);
  const openAction = async (label: string) => {
    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: label, exact: true }).click();
  };
  const saveAndClose = async (expected: RegExp | string) => {
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText(expected);
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
  };
  try {
    await page.goto("/lambda/functions/create");
    await page.getByLabel("Function name").fill(name);
    await page.getByLabel("Runtime", { exact: true }).selectOption("python3.13");
    await page.getByRole("button", { name: "Create function" }).click();
    await expect(page.getByTestId("kv-Handler")).toHaveText("lambda_function.lambda_handler");

    // Non-default settings, set outside the console.
    // Lambda refuses a configuration update while the previous one is in progress, as in AWS.
    const idle = () => expect.poll(async () => (await aws<{ LastUpdateStatus?: string }>("lambda", "get-function-configuration", "--function-name", name))?.LastUpdateStatus ?? "Successful", { timeout: 30_000 }).toBe("Successful");
    await idle();
    await aws("lambda", "update-function-configuration", "--function-name", name, "--memory-size", "256", "--timeout", "30", "--description", "orig desc", "--environment", JSON.stringify({ Variables: { DB: "prod" } }));
    await idle();
    const arn = await cfg();
    const fnArn = (await aws<{ FunctionArn?: string }>("lambda", "get-function-configuration", "--function-name", name))?.FunctionArn as string;
    await aws("lambda", "tag-resource", "--resource", fnArn, "--tags", JSON.stringify({ owner: "dan", team: "core" }));
    expect((await aws<{ Tags?: Record<string, string> }>("lambda", "list-tags", "--resource", fnArn))?.Tags).toEqual({ owner: "dan", team: "core" });
    await aws("lambda", "put-function-concurrency", "--function-name", name, "--reserved-concurrent-executions", "5");
    await aws("lambda", "put-function-event-invoke-config", "--function-name", name, "--maximum-event-age-in-seconds", "3600", "--maximum-retry-attempts", "1");
    expect(arn?.MemorySize).toBe(256);
    await page.reload();

    // General configuration: prefilled; change only the description.
    await openAction("Edit general configuration");
    await expect(page.getByTestId("field-memory")).toHaveValue("256");
    await expect(page.getByTestId("field-timeout")).toHaveValue("30");
    await expect(page.getByTestId("field-description")).toHaveValue("orig desc");
    await page.getByTestId("field-description").fill("new desc");
    await saveAndClose("general configuration");
    await idle();
    const afterGeneral = await cfg();
    expect(afterGeneral?.Description).toBe("new desc");
    expect(afterGeneral?.MemorySize).toBe(256);
    expect(afterGeneral?.Timeout).toBe(30);

    // Runtime settings and environment variables: prefilled, saved unchanged.
    await openAction("Edit runtime settings");
    await expect(page.getByTestId("field-runtime")).toHaveValue("python3.13");
    await expect(page.getByTestId("field-handler")).toHaveValue("lambda_function.lambda_handler");
    await saveAndClose("No changes");
    await openAction("Edit environment variables");
    await expect(page.getByLabel("Environment variables key 1")).toHaveValue("DB");
    await expect(page.getByLabel("Environment variables value 1")).toHaveValue("prod");
    await saveAndClose("No changes");
    expect((await cfg())?.Environment?.Variables).toEqual({ DB: "prod" });

    // Concurrency and async invocation.
    await openAction("Edit concurrency");
    await expect(page.getByTestId("field-reserved")).toHaveValue("5");
    await saveAndClose("No changes");
    expect((await aws<{ ReservedConcurrentExecutions?: number }>("lambda", "get-function-concurrency", "--function-name", name))?.ReservedConcurrentExecutions).toBe(5);
    await openAction("Edit asynchronous invocation");
    await expect(page.getByTestId("field-maxAge")).toHaveValue("3600");
    await expect(page.getByTestId("field-retries")).toHaveValue("1");
    await saveAndClose("No changes");
    const invoke = await aws<{ MaximumEventAgeInSeconds?: number; MaximumRetryAttempts?: number }>("lambda", "get-function-event-invoke-config", "--function-name", name);
    expect(invoke?.MaximumEventAgeInSeconds).toBe(3600);
    expect(invoke?.MaximumRetryAttempts).toBe(1);

    // Manage tags: existing tags shown; saving unchanged keeps them.
    await openAction("Manage tags");
    await expect(page.getByLabel("Tags key 2")).toBeVisible();
    const shown = await Promise.all([1, 2].map(async (i) => `${await page.getByLabel(`Tags key ${i}`).inputValue()}=${await page.getByLabel(`Tags value ${i}`).inputValue()}`));
    expect(shown.sort()).toEqual(["owner=dan", "team=core"]);
    await saveAndClose("No tag changes");
    expect((await aws<{ Tags?: Record<string, string> }>("lambda", "list-tags", "--resource", fnArn))?.Tags).toEqual({ owner: "dan", team: "core" });

    const final = await cfg();
    expect(final?.MemorySize).toBe(256);
    expect(final?.Timeout).toBe(30);
    expect(final?.Runtime).toBe("python3.13");
  } finally {
    await aws("lambda", "delete-function-event-invoke-config", "--function-name", name).catch(() => null);
    await cleanupFunction(name);
  }
});

test("Lambda: a user allowed only GetFunction still sees the function page", async ({ page }) => {
  test.setTimeout(120_000);
  const name = uniqueName("fix-lambda-limited");
  const user = uniqueName("fix-lambda-user");
  const policy = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["lambda:ListFunctions", "lambda:GetFunction"], Resource: "*" }] });
  try {
    await page.goto("/lambda/functions/create");
    await page.getByLabel("Function name").fill(name);
    await page.getByRole("button", { name: "Create function" }).click();
    await expect(page.getByTestId("kv-Handler")).toHaveText("index.handler");
    await aws("iam", "create-user", "--user-name", user);
    await aws("iam", "put-user-policy", "--user-name", user, "--policy-name", "lambda-read", "--policy-document", policy);

    await page.goto("/");
    await page.getByTestId("identity-button").click();
    await page.getByRole("menu", { name: "Identity" }).getByRole("button", { name: new RegExp(`user ${user}`) }).click();
    await expect(page.getByTestId("identity-banner")).toContainText(`IAM user ${user}`);

    await page.goto(`/lambda/functions/${name}`);
    await expect(page.getByTestId("kv-Handler")).toHaveText("index.handler");
    await page.getByRole("tab", { name: "Versions" }).click();
    await expect(page.getByText(/Unavailable: .*lambda:ListVersionsByFunction/)).toBeVisible();

    await page.getByRole("button", { name: "Switch back to admin" }).click();
    await expect(page.getByTestId("identity-banner")).toHaveCount(0);
  } finally {
    await aws("iam", "delete-user-policy", "--user-name", user, "--policy-name", "lambda-read").catch(() => null);
    await aws("iam", "delete-user", "--user-name", user).catch(() => null);
    await cleanupFunction(name);
  }
});
