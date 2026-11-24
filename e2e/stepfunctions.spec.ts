import { expect, test } from "@playwright/test";
import { aws, uniqueName } from "./aws-cli";

const ACCOUNT = "000000000000";

test("Step Functions: create a state machine, run it, read the event history, edit, delete", async ({ page }) => {
  const name = uniqueName("e2e-stepfunctions-sm");
  const role = uniqueName("e2e-stepfunctions-role");
  const exec = uniqueName("e2e-stepfunctions-ex");
  const arn = `arn:aws:states:us-east-1:${ACCOUNT}:stateMachine:${name}`;
  const trust = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "states.amazonaws.com" }, Action: "sts:AssumeRole" }] };
  await aws("iam", "create-role", "--role-name", role, "--assume-role-policy-document", JSON.stringify(trust));
  try {
    await page.goto("/stepfunctions/state-machines");
    await expect(page.getByRole("heading", { name: /^State machines/ })).toBeVisible();
    await page.getByRole("link", { name: "Create state machine" }).first().click();
    await page.getByLabel("State machine name").fill(name);
    await page.getByLabel("Execution role").selectOption({ label: role });
    await page.getByRole("button", { name: "Create state machine" }).click();

    await expect(page.getByTestId("flash")).toContainText(`Created state machine ${name}`);
    await expect(page.getByTestId("kv-Type")).toHaveText("Standard");
    const machines = await aws<{ stateMachines?: { name: string }[] }>("stepfunctions", "list-state-machines");
    expect(machines?.stateMachines?.some((m) => m.name === name)).toBe(true);

    // Start an execution with input.
    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Start execution" }).click();
    await page.getByRole("dialog").getByLabel("Name - optional").fill(exec);
    await page.getByRole("dialog").getByLabel("Input (JSON) - optional").fill('{"from":"e2e"}');
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("Execution started");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();

    // The Hello World definition waits 3 seconds; then the execution succeeds.
    await expect
      .poll(async () => (await aws<{ status: string }>("stepfunctions", "describe-execution", "--execution-arn", `arn:aws:states:us-east-1:${ACCOUNT}:execution:${name}:${exec}`))?.status, { timeout: 20_000 })
      .toBe("SUCCEEDED");
    await page.reload();
    await page.getByRole("tab", { name: "Executions" }).click();
    await page.getByTestId("sfn-executions").getByRole("link", { name: exec }).click();
    await expect(page.getByTestId("kv-Execution status")).toContainText("SUCCEEDED");
    // Stop and Redrive don't apply to a finished, successful execution.
    await page.getByRole("button", { name: "Actions" }).click();
    await expect(page.getByRole("menuitem", { name: "New execution with same input" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Stop execution" })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "Redrive" })).toHaveCount(0);
    await page.getByRole("button", { name: "Actions" }).click();
    // The Graph view comes first, like the console; the event history is its own tab.
    await expect(page.getByTestId("sfn-graph")).toBeVisible();
    await page.getByRole("tab", { name: /^Events/ }).click();
    await expect(page.getByText("WaitStateEntered").first()).toBeVisible();
    await expect(page.getByText("ExecutionSucceeded").first()).toBeVisible();
    await page.getByRole("tab", { name: "Execution input" }).click();
    await expect(page.getByText('"e2e"').first()).toBeVisible();

    // Validate and save a new definition in the editor.
    await page.goto(`/stepfunctions/state-machines/${encodeURIComponent(arn)}`);
    await page.getByRole("tab", { name: "Edit definition" }).click();
    const editor = page.getByLabel("State machine definition");
    await editor.fill('{"StartAt":"Missing","States":{"Only":{"Type":"Pass","End":true}}}');
    await page.getByTestId("sfn-validate").click();
    await expect(page.getByTestId("error-banner")).toContainText("not valid");
    await editor.fill('{"StartAt":"Only","States":{"Only":{"Type":"Pass","End":true}}}');
    await page.getByTestId("sfn-save").click();
    await expect(page.getByTestId("flash").last()).toContainText("Definition saved");
    const described = await aws<{ definition: string }>("stepfunctions", "describe-state-machine", "--state-machine-arn", arn);
    expect(described?.definition).toContain('"Only"');

    // Delete from the list.
    await page.goto("/stepfunctions/state-machines");
    const row = page.getByTestId("resource-table").getByRole("row", { name: new RegExp(name) });
    await row.getByRole("radio").check();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill("delete");
    await page.getByTestId("confirm-delete").click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // DeleteStateMachine is asynchronous: the machine is listed (DELETING) for a moment.
    await expect
      .poll(async () => (await aws<{ stateMachines?: { name: string }[] }>("stepfunctions", "list-state-machines"))?.stateMachines?.some((m) => m.name === name), { timeout: 20_000 })
      .toBe(false);
    await page.reload();
    await expect(page.getByTestId("resource-table").getByRole("row", { name: new RegExp(name) })).toHaveCount(0);
  } finally {
    await aws("stepfunctions", "delete-state-machine", "--state-machine-arn", arn).catch(() => null);
    await aws("iam", "delete-role", "--role-name", role).catch(() => null);
  }
});

test("Step Functions: create and delete an activity", async ({ page }) => {
  const name = uniqueName("e2e-stepfunctions-act");
  const arn = `arn:aws:states:us-east-1:${ACCOUNT}:activity:${name}`;
  try {
    await page.goto("/stepfunctions/activities/create");
    await page.getByLabel("Activity name").fill(name);
    await page.getByRole("button", { name: "Create activity" }).click();
    await expect(page.getByTestId("kv-Name")).toHaveText(name);
    const list = await aws<{ activities?: { name: string }[] }>("stepfunctions", "list-activities");
    expect(list?.activities?.some((a) => a.name === name)).toBe(true);
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill("delete");
    await page.getByTestId("confirm-delete").click();
    await expect(page).toHaveURL(/\/stepfunctions\/activities\?deleted=/);
  } finally {
    await aws("stepfunctions", "delete-activity", "--activity-arn", arn).catch(() => null);
  }
});

test("Step Functions: Edit configuration and Manage tags open with current values; saving unchanged changes nothing", async ({ page }) => {
  const name = uniqueName("fix-stepfunctions-sm");
  const role = uniqueName("fix-stepfunctions-role");
  const trust = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "states.amazonaws.com" }, Action: "sts:AssumeRole" }] };
  const roleArn = (await aws<{ Role: { Arn: string } }>("iam", "create-role", "--role-name", role, "--assume-role-policy-document", JSON.stringify(trust)))?.Role.Arn ?? "";
  const arn = `arn:aws:states:us-east-1:${ACCOUNT}:stateMachine:${name}`;
  const dialog = page.getByRole("dialog");
  const openAction = async (label: string) => {
    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: label }).click();
  };
  const saveExpecting = async (text: RegExp) => {
    await page.getByTestId("action-submit").click();
    await expect(dialog.getByTestId("flash")).toContainText(text);
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
  };
  try {
    await aws("stepfunctions", "create-state-machine", "--name", name, "--role-arn", roleArn, "--definition", '{"StartAt":"Only","States":{"Only":{"Type":"Pass","End":true}}}',
      "--tracing-configuration", "enabled=true", "--tags", "key=env,value=prod");
    const before = await aws<Record<string, unknown>>("stepfunctions", "describe-state-machine", "--state-machine-arn", arn);

    await page.goto(`/stepfunctions/state-machines/${encodeURIComponent(arn)}`);
    await openAction("Edit configuration");
    await expect(dialog.getByTestId("field-roleArn")).toHaveValue(roleArn);
    await expect(dialog.getByTestId("field-logLevel")).toHaveValue("OFF");
    await expect(dialog.getByTestId("field-tracing")).toBeChecked();
    await saveExpecting(/No changes/);

    await openAction("Manage tags");
    await expect(dialog.getByLabel("Tags key 1")).toHaveValue("env");
    await expect(dialog.getByLabel("Tags value 1")).toHaveValue("prod");
    await saveExpecting(/No tag changes/);

    expect(await aws<Record<string, unknown>>("stepfunctions", "describe-state-machine", "--state-machine-arn", arn)).toEqual(before);
    const tags = await aws<{ tags: { key: string; value: string }[] }>("stepfunctions", "list-tags-for-resource", "--resource-arn", arn);
    expect(tags?.tags).toEqual([{ key: "env", value: "prod" }]);

    // A real edit changes only that setting.
    await openAction("Edit configuration");
    await dialog.getByTestId("field-tracing").uncheck();
    await saveExpecting(/Updated tracingConfiguration/);
    const after = await aws<{ roleArn: string; tracingConfiguration?: { enabled: boolean } }>("stepfunctions", "describe-state-machine", "--state-machine-arn", arn);
    expect(after?.tracingConfiguration?.enabled ?? false).toBe(false);
    expect(after?.roleArn).toBe(roleArn);
  } finally {
    await aws("stepfunctions", "delete-state-machine", "--state-machine-arn", arn).catch(() => null);
    await aws("iam", "delete-role", "--role-name", role).catch(() => null);
  }
});

test("Step Functions: the execution Graph view colours each state by its outcome and shows its input, output and error", async ({ page }) => {
  const name = uniqueName("e2e-sfn-graph");
  const role = uniqueName("e2e-sfn-graph-role");
  const trust = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "states.amazonaws.com" }, Action: "sts:AssumeRole" }] };
  const roleArn = (await aws<{ Role: { Arn: string } }>("iam", "create-role", "--role-name", role, "--assume-role-policy-document", JSON.stringify(trust)))?.Role.Arn ?? "";
  const definition = {
    StartAt: "Init",
    States: {
      Init: { Type: "Pass", Result: { items: [1, 2] }, Next: "Check" },
      Check: { Type: "Choice", Choices: [{ Variable: "$.items[0]", NumericEquals: 1, Next: "Fan" }], Default: "Never" },
      Fan: { Type: "Parallel", ResultPath: "$.par", Branches: [{ StartAt: "Left", States: { Left: { Type: "Pass", End: true } } }, { StartAt: "Right", States: { Right: { Type: "Pass", End: true } } }], Next: "Each" },
      Each: { Type: "Map", ItemsPath: "$.items", ResultPath: "$.mapped", ItemProcessor: { ProcessorConfig: { Mode: "INLINE" }, StartAt: "Item", States: { Item: { Type: "Pass", End: true } } }, Next: "Call" },
      Call: { Type: "Task", Resource: "arn:aws:states:::lambda:invoke", Parameters: { FunctionName: `${name}-missing` }, Catch: [{ ErrorEquals: ["States.ALL"], ResultPath: "$.err", Next: "Boom" }], Next: "Never" },
      Boom: { Type: "Fail", Error: "GraphProbe", Cause: "expected failure" },
      Never: { Type: "Succeed" },
    },
  };
  let smArn = "";
  try {
    smArn = (await aws<{ stateMachineArn: string }>("stepfunctions", "create-state-machine", "--name", name, "--role-arn", roleArn, "--definition", JSON.stringify(definition)))?.stateMachineArn ?? "";
    const execArn = (await aws<{ executionArn: string }>("stepfunctions", "start-execution", "--state-machine-arn", smArn, "--input", "{}"))?.executionArn ?? "";
    await expect.poll(async () => (await aws<{ status: string }>("stepfunctions", "describe-execution", "--execution-arn", execArn))?.status, { timeout: 30_000 }).toBe("FAILED");

    await page.goto(`/stepfunctions/executions/${encodeURIComponent(execArn)}`);
    const graph = page.getByTestId("sfn-graph");
    await expect(graph).toBeVisible();
    const outcome = (state: string) => graph.getByTestId(`graph-state-${state}`);
    await expect(outcome("Init")).toHaveAttribute("data-outcome", "succeeded");
    await expect(outcome("Fan")).toHaveAttribute("data-outcome", "succeeded");
    await expect(outcome("Left")).toHaveAttribute("data-outcome", "succeeded");
    await expect(outcome("Item")).toHaveAttribute("data-outcome", "succeeded");
    await expect(outcome("Call")).toHaveAttribute("data-outcome", "caught");
    await expect(outcome("Boom")).toHaveAttribute("data-outcome", "failed");
    await expect(outcome("Never")).toHaveAttribute("data-outcome", "notRun");

    await outcome("Init").click();
    await expect(page.getByTestId("step-status")).toHaveText("Succeeded");
    await expect(page.getByTestId("step-output")).toContainText("items");
    await outcome("Boom").click();
    await expect(page.getByTestId("step-status")).toHaveText("Failed");
    await expect(page.getByTestId("step-error")).toContainText("GraphProbe");
    await expect(page.getByTestId("step-error")).toContainText("expected failure");
    await outcome("Call").click();
    await expect(page.getByTestId("step-status")).toHaveText("Caught error");
    await outcome("Never").click();
    await expect(page.getByTestId("step-details")).toContainText("didn't run");

    // The graph agrees with the CLI's event history.
    const history = await aws<{ events: { type: string; stateEnteredEventDetails?: { name: string } }[] }>("stepfunctions", "get-execution-history", "--execution-arn", execArn);
    const enteredStates = new Set(history?.events.filter((e) => e.stateEnteredEventDetails).map((e) => e.stateEnteredEventDetails?.name));
    expect(enteredStates.has("Never")).toBe(false);
    expect(enteredStates.has("Boom")).toBe(true);
  } finally {
    if (smArn) await aws("stepfunctions", "delete-state-machine", "--state-machine-arn", smArn).catch(() => null);
    await aws("iam", "delete-role", "--role-name", role).catch(() => null);
  }
});
