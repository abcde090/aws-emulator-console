import { expect, test, type Page } from "@playwright/test";
import { aws, uniqueName } from "./aws-cli";

// Long enough for the finally blocks to clean up even when a step times out.
test.setTimeout(120_000);

interface Stacks {
  Stacks?: { StackStatus?: string; Parameters?: { ParameterKey?: string; ParameterValue?: string }[]; Tags?: { Key: string; Value: string }[] }[];
}

const TEMPLATE = JSON.stringify({
  Description: "e2e stack",
  Parameters: { Env: { Type: "String", AllowedValues: ["dev", "prod"], Default: "dev", Description: "Stage" } },
  Resources: { Topic: { Type: "AWS::SNS::Topic", Properties: { TopicName: { "Fn::Join": ["-", [{ Ref: "AWS::StackName" }, { Ref: "Env" }]] } } } },
  Outputs: { TopicArn: { Value: { Ref: "Topic" }, Description: "The topic" } },
});

/** Opens an Actions menu item; retries the click in case the page is still hydrating. */
async function openAction(page: Page, label: string): Promise<void> {
  await expect(async () => {
    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: label }).click({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
}

async function stackStatus(name: string): Promise<string | undefined> {
  try {
    return (await aws<Stacks>("cloudformation", "describe-stacks", "--stack-name", name))?.Stacks?.[0]?.StackStatus;
  } catch {
    return undefined;
  }
}

test("CloudFormation: create a stack with the wizard, update it with a change set, detect drift, delete it", async ({ page }) => {
  const name = uniqueName("e2e-cloudformation");
  try {
    await page.goto("/cloudformation/stacks");
    await expect(page.getByRole("heading", { name: /^Stacks/ })).toBeVisible();
    await page.getByRole("link", { name: "Create stack" }).first().click();

    // Step 1: template.
    await expect(page.getByTestId("stack-wizard")).toBeVisible();
    await page.getByLabel("Template body").fill(TEMPLATE);
    await page.getByRole("button", { name: "Next", exact: true }).click();
    // Step 2: name and the parameter form generated from the template.
    await page.getByLabel("Stack name").fill(name);
    await page.getByLabel("Env").selectOption("prod");
    await page.getByRole("button", { name: "Next", exact: true }).click();
    // Step 3: options.
    await page.getByRole("button", { name: "Add new tag" }).click();
    await page.getByLabel("Tags key 1").fill("team");
    await page.getByLabel("Tags value 1").fill("e2e");
    await page.getByRole("button", { name: "Next", exact: true }).click();
    // Step 4: review.
    await expect(page.getByTestId("wizard-review")).toContainText("prod");
    await page.getByRole("button", { name: "Submit" }).click();

    await expect(page).toHaveURL(new RegExp(`/cloudformation/stacks/${name}`));
    await expect(page.getByTestId("flash")).toContainText(`Created stack ${name}`);
    await expect.poll(() => stackStatus(name), { timeout: 20_000 }).toBe("CREATE_COMPLETE");
    const created = await aws<Stacks>("cloudformation", "describe-stacks", "--stack-name", name);
    expect(created?.Stacks?.[0]?.Parameters?.find((p) => p.ParameterKey === "Env")?.ParameterValue).toBe("prod");
    expect(created?.Stacks?.[0]?.Tags).toContainEqual({ Key: "team", Value: "e2e" });

    await page.reload();
    await expect(page.getByTestId("kv-Status")).toHaveText(/CREATE_COMPLETE/);
    await page.getByRole("tab", { name: "Outputs" }).click();
    await expect(page.getByText("The topic")).toBeVisible();

    // The list shows it.
    await page.goto("/cloudformation/stacks");
    await expect(page.getByTestId("resource-table").getByRole("row", { name: new RegExp(name) })).toBeVisible();

    // Change set: switch Env back to dev; the topic name changes, so it is replaced.
    await page.goto(`/cloudformation/stacks/${name}`);
    await page.getByRole("tab", { name: "Change sets" }).click();
    await page.getByRole("link", { name: "Create change set" }).click();
    await expect(page.getByTestId("stack-wizard")).toBeVisible();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await page.getByLabel("Change set name").fill("e2e-cs");
    await expect(page.getByLabel("Env")).toHaveValue("prod");
    await page.getByLabel("Env").selectOption("dev");
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await page.getByRole("button", { name: "Create change set" }).click();
    await expect(page).toHaveURL(/\/changesets\/e2e-cs/);
    await expect(page.getByTestId("flash")).toContainText("Created change set e2e-cs");
    const changes = page.getByTestId("changes-table");
    await expect(changes).toContainText("Topic");
    await expect(changes).toContainText("Modify");
    await expect(changes).toContainText("True");

    // The emulator creates change sets asynchronously (CREATE_PENDING first): reload until it can run.
    await expect(async () => {
      await page.reload();
      await expect(page.getByRole("button", { name: "Execute change set" })).toBeEnabled({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    await page.getByRole("button", { name: "Execute change set" }).click();
    await page.getByTestId("confirm-change-set").click();
    await expect(page.getByTestId("flash")).toContainText("Executing change set e2e-cs");
    await expect
      .poll(async () => (await aws<Stacks>("cloudformation", "describe-stacks", "--stack-name", name))?.Stacks?.[0]?.Parameters?.find((p) => p.ParameterKey === "Env")?.ParameterValue, { timeout: 20_000 })
      .toBe("dev");

    // Drift detection from Stack actions.
    await page.goto(`/cloudformation/stacks/${name}`);
    await openAction(page, "Detect drift");
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog")).toContainText("stack drift status IN_SYNC");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();

    // Delete through the UI.
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill("delete");
    await page.getByTestId("confirm-delete").click();
    await expect(page).toHaveURL(/\/cloudformation\/stacks\?deleted=/);
    await expect.poll(async () => (await stackStatus(name)) ?? "gone", { timeout: 20_000 }).toMatch(/^(DELETE_COMPLETE|gone)$/);
  } finally {
    const status = await stackStatus(name);
    if (status && status !== "DELETE_COMPLETE") {
      await aws("cloudformation", "update-termination-protection", "--stack-name", name, "--no-enable-termination-protection").catch(() => null);
      await aws("cloudformation", "delete-stack", "--stack-name", name);
    }
  }
});

test("CloudFormation: create a StackSet, add a stack instance, delete it", async ({ page }) => {
  const name = uniqueName("e2e-cloudformation-ss");
  try {
    await page.goto("/cloudformation/stacksets");
    await expect(page.getByRole("heading", { name: /^StackSets/ })).toBeVisible();
    await page.getByRole("link", { name: "Create StackSet" }).first().click();
    await expect(page.getByTestId("create-form")).toBeVisible();
    // Retried as a unit: a fill that lands before hydration is reset by React.
    await expect(async () => {
      await page.getByLabel("Template body").fill(JSON.stringify({ Resources: { Topic: { Type: "AWS::SNS::Topic" } } }));
      await page.getByLabel("StackSet name").fill(name);
      await page.getByRole("button", { name: "Create StackSet" }).click();
      await expect(page).toHaveURL(new RegExp(`/cloudformation/stacksets/${name}`), { timeout: 5_000 });
    }).toPass({ timeout: 30_000 });
    const listed = await aws<{ Summaries?: { StackSetName?: string }[] }>("cloudformation", "list-stack-sets", "--status", "ACTIVE");
    expect(listed?.Summaries?.some((s) => s.StackSetName === name)).toBe(true);

    await openAction(page, "Add stacks to StackSet");
    await page.getByLabel("Account numbers").fill("000000000000");
    await page.getByLabel("Specify regions").selectOption(["us-west-2"]);
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog")).toContainText("to add stack instances");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    await expect
      .poll(async () => (await aws<{ Summaries?: unknown[] }>("cloudformation", "list-stack-instances", "--stack-set-name", name))?.Summaries?.length ?? 0, { timeout: 20_000 })
      .toBe(1);

    await openAction(page, "Delete stacks from StackSet");
    await page.getByLabel("Account numbers").fill("000000000000");
    await page.getByLabel("Specify regions").selectOption(["us-west-2"]);
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog")).toContainText("to delete stack instances");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    await expect
      .poll(async () => (await aws<{ Summaries?: unknown[] }>("cloudformation", "list-stack-instances", "--stack-set-name", name))?.Summaries?.length ?? 0, { timeout: 20_000 })
      .toBe(0);

    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill(name);
    await page.getByTestId("confirm-delete").click();
    await expect(page).toHaveURL(/\/cloudformation\/stacksets\?deleted=/);
  } finally {
    const insts = await aws<{ Summaries?: { Account?: string; Region?: string }[] }>("cloudformation", "list-stack-instances", "--stack-set-name", name).catch(() => null);
    const regions = (insts?.Summaries ?? []).map((s) => s.Region ?? "").filter(Boolean);
    if (regions.length) await aws("cloudformation", "delete-stack-instances", "--stack-set-name", name, "--accounts", "000000000000", "--regions", ...regions, "--no-retain-stacks").catch(() => null);
    const set = await aws<{ StackSet?: { Status?: string } }>("cloudformation", "describe-stack-set", "--stack-set-name", name).catch(() => null);
    if (set?.StackSet?.Status === "ACTIVE") await aws("cloudformation", "delete-stack-set", "--stack-set-name", name).catch(() => null);
  }
});

test("CloudFormation: Edit termination protection shows the current setting; Update stack makes a direct update", async ({ page }) => {
  const name = uniqueName("fix-cloudformation");
  try {
    await aws("cloudformation", "create-stack", "--stack-name", name, "--template-body", TEMPLATE, "--parameters", "ParameterKey=Env,ParameterValue=dev");
    await expect.poll(() => stackStatus(name), { timeout: 30_000 }).toBe("CREATE_COMPLETE");
    await page.goto(`/cloudformation/stacks/${name}`);

    // Deactivated in AWS, so the dialog opens on Deactivated; saving keeps it off.
    await openAction(page, "Edit termination protection");
    await expect(page.getByRole("radio", { name: "Deactivated" })).toBeChecked();
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toBeVisible();
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    type D = { Stacks: { EnableTerminationProtection?: boolean }[] };
    expect((await aws<D>("cloudformation", "describe-stacks", "--stack-name", name))?.Stacks[0].EnableTerminationProtection ?? false).toBe(false);

    // Only the actions that apply to a CREATE_COMPLETE stack are offered.
    await page.getByRole("button", { name: "Actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Cancel update stack" })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "Continue update rollback" })).toHaveCount(0);
    await page.keyboard.press("Escape");

    // Update stack > Make a direct update: keep the current template, change the parameter.
    await expect(async () => {
      await page.getByTestId("update-stack-menu").click();
      await page.getByRole("menuitem", { name: "Make a direct update" }).click({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    await expect(page).toHaveURL(new RegExp(`/cloudformation/stacks/${name}/update`));
    await expect(page.getByTestId("stack-wizard")).toBeVisible();
    await expect(page.getByRole("radio", { name: "Use current template" })).toBeChecked();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.getByLabel("Env")).toHaveValue("dev");
    await page.getByLabel("Env").selectOption("prod");
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.getByTestId("wizard-review")).toContainText("prod");
    await page.getByRole("button", { name: "Update stack" }).click();
    await expect(page).toHaveURL(new RegExp(`/cloudformation/stacks/${name}\\?updated=1`));
    await expect(page.getByTestId("flash")).toContainText("Update started");
    await expect.poll(() => stackStatus(name), { timeout: 30_000 }).toBe("UPDATE_COMPLETE");
    const after = await aws<Stacks>("cloudformation", "describe-stacks", "--stack-name", name);
    expect(after?.Stacks?.[0]?.Parameters?.find((p) => p.ParameterKey === "Env")?.ParameterValue).toBe("prod");
  } finally {
    await aws("cloudformation", "delete-stack", "--stack-name", name).catch(() => null);
  }
});
