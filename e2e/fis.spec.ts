import { expect, test } from "@playwright/test";
import { aws, uniqueName } from "./aws-cli";

test("FIS: create a template, start and stop an experiment, delete the template", async ({ page }) => {
  const name = uniqueName("e2e-fis");
  const role = `${name}-role`;
  let id = "";
  // FIS assumes this role to run the experiment, so it must trust fis.amazonaws.com.
  const trust = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "fis.amazonaws.com" }, Action: "sts:AssumeRole" }] };
  await aws("iam", "create-role", "--role-name", role, "--assume-role-policy-document", JSON.stringify(trust));
  try {
    await page.goto("/fis/experiment-templates");
    await expect(page.getByRole("heading", { name: /^Experiment templates/ })).toBeVisible();
    await page.getByRole("link", { name: "Create experiment template" }).first().click();
    await expect(page.getByTestId("create-form")).toBeVisible();
    await page.waitForLoadState("networkidle");
    await page.getByLabel(/^Name/).fill(name);
    await page.getByLabel("Description", { exact: true }).fill("e2e wait experiment");
    await page.getByLabel("Action type").selectOption("aws:fis:wait");
    await page.getByLabel(/^Action parameters/).fill('{"duration": "PT10M"}');
    await page.getByRole("radio", { name: /^No target/ }).check();
    await page.getByLabel("IAM role").selectOption({ label: role });
    await page.getByRole("button", { name: "Create experiment template" }).click();

    await expect(page.getByTestId("kv-Name")).toHaveText(name);
    id = (await page.getByTestId("kv-Experiment template ID").textContent()) ?? "";
    const cli = await aws<{ experimentTemplate: { description: string; actions: Record<string, { actionId: string; parameters: Record<string, string> }> } }>("fis", "get-experiment-template", "--id", id);
    expect(cli?.experimentTemplate.description).toBe("e2e wait experiment");
    expect(cli?.experimentTemplate.actions.action1).toMatchObject({ actionId: "aws:fis:wait", parameters: { duration: "PT10M" } });

    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Start experiment" }).click();
    await page.getByLabel(/^Experiment name/).fill(`${name}-run`);
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog")).toContainText("Started experiment");
    const started = (await page.getByRole("dialog").textContent()) ?? "";
    const expId = /Started experiment (\S+):/.exec(started)?.[1] ?? "";
    expect(expId).not.toBe("");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();

    await page.goto(`/fis/experiments/${expId}`);
    await expect(page.getByTestId("kv-Name")).toHaveText(`${name}-run`);
    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Stop experiment" }).click();
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog")).toContainText(`Experiment ${expId} is`);
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    await expect(page.getByTestId("kv-State")).toHaveText(/stopp/);

    await page.goto("/fis/experiment-templates");
    const row = page.getByTestId("resource-table").getByRole("row", { name: new RegExp(name) });
    await expect(row).toBeVisible();
    await row.getByRole("radio").check();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill("delete");
    await page.getByTestId("confirm-delete").click();
    await expect(page.getByTestId("flash")).toContainText(`Deleted experiment template ${id}`);
    const after = await aws<{ experimentTemplates: { id: string }[] }>("fis", "list-experiment-templates");
    expect(after?.experimentTemplates.some((t) => t.id === id)).toBe(false);
    id = "";
  } finally {
    if (id) await aws("fis", "delete-experiment-template", "--id", id).catch(() => null);
    await aws("iam", "delete-role", "--role-name", role).catch(() => null);
  }
});

test("FIS: Update description and options shows current values and saving unchanged changes nothing", async ({ page }) => {
  const name = uniqueName("fix-fis");
  const role = `${name}-role`;
  let id = "";
  const trust = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "fis.amazonaws.com" }, Action: "sts:AssumeRole" }] };
  try {
    const roleArn = (await aws<{ Role: { Arn: string } }>("iam", "create-role", "--role-name", role, "--assume-role-policy-document", JSON.stringify(trust)))?.Role.Arn ?? "";
    const t = await aws<{ experimentTemplate: { id: string } }>(
      "fis", "create-experiment-template", "--description", "fix fis desc", "--role-arn", roleArn,
      "--actions", JSON.stringify({ wait: { actionId: "aws:fis:wait", parameters: { duration: "PT1M" } } }),
      "--targets", "{}", "--stop-conditions", JSON.stringify([{ source: "none" }]),
      "--experiment-options", JSON.stringify({ emptyTargetResolutionMode: "skip" })
    );
    id = t?.experimentTemplate.id ?? "";
    await page.goto(`/fis/experiment-templates/${id}`);
    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Update description and options" }).click();
    await expect(page.getByTestId("field-description")).toHaveValue("fix fis desc");
    await expect(page.getByTestId("field-emptyMode")).toHaveValue("skip");
    await expect(page.getByTestId("field-role")).toHaveValue(roleArn);
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog")).toContainText("No changes");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    const after = await aws<{ experimentTemplate: { description: string; roleArn: string; experimentOptions?: { emptyTargetResolutionMode?: string } } }>("fis", "get-experiment-template", "--id", id);
    expect(after?.experimentTemplate).toMatchObject({ description: "fix fis desc", roleArn, experimentOptions: { emptyTargetResolutionMode: "skip" } });
  } finally {
    if (id) await aws("fis", "delete-experiment-template", "--id", id).catch(() => null);
    await aws("iam", "delete-role", "--role-name", role).catch(() => null);
  }
});
