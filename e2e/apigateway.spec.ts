import { expect, test, type Page } from "@playwright/test";
import { aws, uniqueName } from "./aws-cli";

// Each test walks through many screens on a shared dev server.
test.describe.configure({ timeout: 150_000 });

interface RestApis {
  items?: { id: string; name: string }[];
}
interface V2Apis {
  Items?: { ApiId: string; Name: string }[];
}

async function restApiId(name: string): Promise<string | null> {
  return (await aws<RestApis>("apigateway", "get-rest-apis"))?.items?.find((a) => a.name === name)?.id ?? null;
}
async function httpApiId(name: string): Promise<string | null> {
  return (await aws<V2Apis>("apigatewayv2", "get-apis"))?.Items?.find((a) => a.Name === name)?.ApiId ?? null;
}

async function createApi(page: Page, type: RegExp, name: string): Promise<void> {
  await page.goto("/apigateway/apis");
  await expect(page.getByRole("heading", { name: /^APIs/ })).toBeVisible();
  await page.getByRole("link", { name: "Create API" }).first().click();
  await expect(page.getByTestId("create-form")).toBeVisible();
  await page.getByRole("radio", { name: type }).check();
  await page.getByLabel("API name").fill(name);
  await page.getByRole("button", { name: "Create API" }).click();
  await expect(page.getByTestId("flash")).toContainText("Created API");
  await expect(page.getByTestId("kv-Name")).toHaveText(name);
}

async function deleteFromDetail(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Delete", exact: true }).first().click();
  await page.getByLabel("Confirm deletion").fill("delete");
  await page.getByTestId("confirm-delete").click();
  await expect(page).toHaveURL(/\/apigateway\/apis\?deleted=/);
}

test("API Gateway: REST API with a resource, a Mock method, a test call, a deploy and a stage", async ({ page }) => {
  const name = uniqueName("e2e-apigateway-rest");
  try {
    await createApi(page, /^REST API/, name);
    await expect(page.getByTestId("kv-Protocol")).toHaveText("REST");
    const id = await restApiId(name);
    expect(id).toBeTruthy();
    await expect(page).toHaveURL(new RegExp(`/apigateway/apis/${id}`));

    // Create /items.
    const res = page.getByTestId("rest-resources");
    await res.getByRole("button", { name: "Create resource" }).click();
    await page.getByLabel("Resource name").fill("items");
    await page.getByTestId("dialog-submit").click();
    await expect(res.getByTestId("flash")).toContainText("Created resource /items");
    const paths = await aws<{ items: { path: string }[] }>("apigateway", "get-resources", "--rest-api-id", id ?? "");
    expect(paths?.items.map((i) => i.path)).toContain("/items");

    // GET /items with a Mock integration.
    await res.getByRole("button", { name: "items", exact: true }).click();
    await res.getByRole("button", { name: "Create method" }).click();
    await page.getByLabel("Method type").selectOption("GET");
    await page.getByRole("radio", { name: /^Mock/ }).check();
    await page.getByTestId("dialog-submit").click();
    await expect(res.getByTestId("flash")).toContainText("Created GET method with a MOCK integration");

    // Open the method and test it.
    await res.getByTestId("method-/items-GET").click();
    await expect(res).toContainText("Integration request");
    await expect(res).toContainText("Mock");
    await res.getByRole("button", { name: "Test", exact: true }).click();
    await page.getByTestId("dialog-submit").click();
    await expect(page.getByTestId("test-result")).toContainText("200");
    await expect(page.getByTestId("test-result")).toContainText("Integration type: MOCK");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();

    // Deploy to a new stage.
    await res.getByRole("button", { name: "Deploy API" }).click();
    await page.getByLabel("Stage", { exact: true }).selectOption({ label: "*New stage*" });
    await page.getByLabel("Stage name").fill("dev");
    await page.getByTestId("dialog-submit").click();
    await expect(res.getByTestId("flash")).toContainText("Deployed to stage dev");
    const stages = await aws<{ item: { stageName: string }[] }>("apigateway", "get-stages", "--rest-api-id", id ?? "");
    expect(stages?.item.map((s) => s.stageName)).toContain("dev");

    // Stages tab shows the invoke URL; set a stage variable.
    await page.getByRole("tab", { name: "Stages" }).click();
    const st = page.getByTestId("rest-stages");
    await expect(st).toContainText(`${id}/dev`);
    await st.getByRole("button", { name: "Edit stage variables" }).click();
    await page.getByRole("textbox", { name: /^Stage variables/ }).fill("env=test");
    await page.getByTestId("dialog-submit").click();
    await expect(st.getByTestId("stage-variables")).toHaveText("env=test");

    // The list shows the API; then delete it.
    await page.goto("/apigateway/apis");
    await expect(page.getByTestId("resource-table").getByRole("row", { name: new RegExp(name) })).toBeVisible();
    await page.getByTestId("resource-table").getByRole("link", { name }).click();
    await expect(page).toHaveURL(new RegExp(`/apigateway/apis/${id}$`));
    await expect(page.getByTestId("kv-Name")).toHaveText(name);
    await deleteFromDetail(page);
    expect(await restApiId(name)).toBeNull();
  } finally {
    const left = await restApiId(name);
    if (left) await aws("apigateway", "delete-rest-api", "--rest-api-id", left);
  }
});

test("API Gateway: HTTP API with an integration, a route and a stage", async ({ page }) => {
  const name = uniqueName("e2e-apigateway-http");
  try {
    await createApi(page, /^HTTP API/, name);
    await expect(page.getByTestId("kv-Protocol")).toHaveText("HTTP");
    const id = await httpApiId(name);
    expect(id).toBeTruthy();

    await page.getByRole("tab", { name: "Integrations" }).click();
    const ints = page.getByTestId("v2-integrations");
    await ints.getByRole("button", { name: "Create integration" }).click();
    await page.getByRole("radio", { name: "HTTP URI" }).check();
    await page.getByLabel("URL").fill("https://example.com");
    await page.getByTestId("dialog-submit").click();
    await expect(ints.getByTestId("flash")).toContainText("Created integration");
    await expect(ints.getByTestId("integrations-table")).toContainText("https://example.com");

    await page.getByRole("tab", { name: "Routes" }).click();
    const routes = page.getByTestId("v2-routes");
    await routes.getByRole("button", { name: "Create route" }).click();
    await page.getByLabel("Method").selectOption("GET");
    await page.getByLabel("Path").fill("/items");
    await page.getByLabel("Integration").selectOption({ index: 1 });
    await page.getByTestId("dialog-submit").click();
    await expect(routes.getByTestId("routes-table")).toContainText("GET /items");
    const cliRoutes = await aws<{ Items: { RouteKey: string; Target?: string }[] }>("apigatewayv2", "get-routes", "--api-id", id ?? "");
    expect(cliRoutes?.Items.find((r) => r.RouteKey === "GET /items")?.Target).toMatch(/^integrations\//);

    await page.getByRole("tab", { name: "Stages" }).click();
    const stages = page.getByTestId("v2-stages");
    await stages.getByRole("button", { name: "Create stage" }).click();
    await page.getByLabel("Stage name").fill("$default");
    await page.getByTestId("dialog-submit").click();
    await expect(stages.getByTestId("stages-table")).toContainText(`${id}/`);

    await deleteFromDetail(page);
    expect(await httpApiId(name)).toBeNull();
  } finally {
    const left = await httpApiId(name);
    if (left) await aws("apigatewayv2", "delete-api", "--api-id", left);
  }
});

test("API Gateway: API key in a usage plan", async ({ page }) => {
  const keyName = uniqueName("e2e-apigateway-key");
  const planName = uniqueName("e2e-apigateway-plan");
  const keyId = async () => (await aws<{ items?: { id: string; name: string }[] }>("apigateway", "get-api-keys"))?.items?.find((k) => k.name === keyName)?.id ?? null;
  const planId = async () => (await aws<{ items?: { id: string; name: string }[] }>("apigateway", "get-usage-plans"))?.items?.find((p) => p.name === planName)?.id ?? null;
  try {
    await page.goto("/apigateway/api-keys/create");
    await page.getByLabel("Name", { exact: true }).fill(keyName);
    await page.getByRole("button", { name: "Create API key" }).click();
    await expect(page.getByTestId("kv-Status")).toHaveText("Active");
    expect(await keyId()).toBeTruthy();

    await page.goto("/apigateway/usage-plans/create");
    await page.getByLabel("Name", { exact: true }).fill(planName);
    await page.getByLabel("Rate").fill("5");
    await page.getByRole("button", { name: "Create usage plan" }).click();
    await expect(page.getByTestId("kv-Name")).toHaveText(planName);

    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Add API key" }).click();
    await page.getByLabel("API key", { exact: true }).selectOption({ label: `${keyName} (${await keyId()})` });
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("Added API key");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    await page.getByRole("tab", { name: "Associated API keys" }).click();
    await expect(page.getByText(keyName)).toBeVisible();
    const planKeys = await aws<{ items: { name: string }[] }>("apigateway", "get-usage-plan-keys", "--usage-plan-id", (await planId()) ?? "");
    expect(planKeys?.items.map((k) => k.name)).toContain(keyName);

    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill("delete");
    await page.getByTestId("confirm-delete").click();
    await expect(page).toHaveURL(/\/apigateway\/usage-plans\?deleted=/);

    await page.goto("/apigateway/api-keys");
    const row = page.getByTestId("resource-table").getByRole("row", { name: new RegExp(keyName) });
    await row.getByRole("radio").check();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill("delete");
    await page.getByTestId("confirm-delete").click();
    await expect(page.getByTestId("flash")).toContainText("Deleted API key");
    expect(await keyId()).toBeNull();
  } finally {
    const p = await planId();
    const k = await keyId();
    if (p && k) await aws("apigateway", "delete-usage-plan-key", "--usage-plan-id", p, "--key-id", k).catch(() => null);
    if (p) await aws("apigateway", "delete-usage-plan", "--usage-plan-id", p);
    if (k) await aws("apigateway", "delete-api-key", "--api-key", k);
  }
});

async function openAction(page: Page, label: string): Promise<void> {
  await page.getByRole("button", { name: "Actions" }).click();
  await page.getByRole("menuitem", { name: label, exact: true }).click();
}

async function saveAndClose(page: Page, flash: string | RegExp): Promise<void> {
  await page.getByTestId("action-submit").click();
  await expect(page.getByRole("dialog").getByTestId("flash")).toContainText(flash);
  await page.getByRole("button", { name: "Close", exact: true }).last().click();
}

test("API Gateway: Edit dialogs open on the current values and saving unchanged changes nothing", async ({ page }) => {
  const name = uniqueName("fix-apigateway-rest");
  const keyName = uniqueName("fix-apigateway-key");
  const planName = uniqueName("fix-apigateway-plan");
  let apiId = "";
  let keyId = "";
  let planId = "";
  let certId = "";
  try {
    apiId = (await aws<{ id: string }>("apigateway", "create-rest-api", "--name", name, "--description", "fix rest api"))?.id ?? "";
    keyId = (await aws<{ id: string }>("apigateway", "create-api-key", "--name", keyName, "--description", "fix key", "--no-enabled"))?.id ?? "";
    planId = (await aws<{ id: string }>("apigateway", "create-usage-plan", "--name", planName, "--throttle", "rateLimit=7,burstLimit=9", "--quota", "limit=500,period=WEEK"))?.id ?? "";
    certId = (await aws<{ clientCertificateId: string }>("apigateway", "generate-client-certificate", "--description", "fix cert"))?.clientCertificateId ?? "";

    // Edit API details: name and description prefilled; saving keeps the description.
    await page.goto(`/apigateway/apis/${apiId}`);
    await expect(page.getByTestId("kv-Name")).toHaveText(name);
    await openAction(page, "Edit API details");
    await expect(page.getByTestId("field-name")).toHaveValue(name);
    await expect(page.getByTestId("field-description")).toHaveValue("fix rest api");
    await saveAndClose(page, `Saved API ${name}`);
    const api = await aws<{ name: string; description?: string }>("apigateway", "get-rest-api", "--rest-api-id", apiId);
    expect(api).toMatchObject({ name, description: "fix rest api" });

    // API key Edit: a disabled key stays disabled.
    await page.goto(`/apigateway/api-keys/${keyId}`);
    await expect(page.getByTestId("kv-Status")).toHaveText("Inactive");
    await openAction(page, "Edit");
    await expect(page.getByTestId("field-name")).toHaveValue(keyName);
    await expect(page.getByTestId("field-description")).toHaveValue("fix key");
    await expect(page.getByTestId("field-enabled")).not.toBeChecked();
    await saveAndClose(page, `Saved API key ${keyName}`);
    const key = await aws<{ name: string; description?: string; enabled: boolean }>("apigateway", "get-api-key", "--api-key", keyId);
    expect(key).toMatchObject({ name: keyName, description: "fix key", enabled: false });

    // Usage plan Edit throttling and quota: the plan's own limits, not the field defaults.
    await page.goto(`/apigateway/usage-plans/${planId}`);
    await openAction(page, "Edit throttling and quota");
    await expect(page.getByTestId("field-rate")).toHaveValue("7");
    await expect(page.getByTestId("field-burst")).toHaveValue("9");
    await expect(page.getByTestId("field-limit")).toHaveValue("500");
    await expect(page.getByTestId("field-period")).toHaveValue("WEEK");
    await saveAndClose(page, /No changes to save|Saved throttling and quota/);
    const plan = await aws<{ throttle: { rateLimit: number; burstLimit: number }; quota: { limit: number; period: string } }>("apigateway", "get-usage-plan", "--usage-plan-id", planId);
    expect(plan?.throttle).toMatchObject({ rateLimit: 7, burstLimit: 9 });
    expect(plan?.quota).toMatchObject({ limit: 500, period: "WEEK" });

    // Client certificate Edit description.
    await page.goto(`/apigateway/client-certificates/${certId}`);
    await openAction(page, "Edit description");
    await expect(page.getByTestId("field-description")).toHaveValue("fix cert");
    await saveAndClose(page, "Saved the description");
    expect((await aws<{ description?: string }>("apigateway", "get-client-certificate", "--client-certificate-id", certId))?.description).toBe("fix cert");
  } finally {
    if (apiId) await aws("apigateway", "delete-rest-api", "--rest-api-id", apiId).catch(() => null);
    if (keyId) await aws("apigateway", "delete-api-key", "--api-key", keyId).catch(() => null);
    if (planId) await aws("apigateway", "delete-usage-plan", "--usage-plan-id", planId).catch(() => null);
    if (certId) await aws("apigateway", "delete-client-certificate", "--client-certificate-id", certId).catch(() => null);
  }
});
