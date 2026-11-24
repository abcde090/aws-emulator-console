import { expect, test, type Page } from "@playwright/test";
import { aws, uniqueName } from "./aws-cli";

async function switchRegion(page: Page, code: string) {
  await page.getByTestId("region").click();
  await page.getByTestId(`region-option-${code}`).click();
  await expect(page.getByTestId("region")).toHaveAttribute("data-region", code);
}

test("Region selector: a queue made in us-west-2 shows only there; detail pages go to the list; CloudShell runs in the Region", async ({ page }) => {
  const name = uniqueName("e2e-region-q");
  const created = await aws<{ QueueUrl?: string }>("sqs", "create-queue", "--queue-name", name, "--region", "us-west-2");
  expect(created?.QueueUrl).toContain("us-west-2");
  try {
    const rowFor = () => page.getByTestId("resource-table").getByRole("row", { name: new RegExp(name) });

    // Default Region: us-east-1, where the queue does not exist.
    await page.goto("/sqs/queues");
    await expect(page.getByRole("heading", { name: /^Queues/ })).toBeVisible();
    await expect(page.getByTestId("region")).toHaveAttribute("data-region", "us-east-1");
    await expect(page.getByTestId("region")).toContainText("N. Virginia");
    await expect(page.getByTestId("resource-table")).toBeVisible();
    await expect(rowFor()).toHaveCount(0);

    // The menu lists Regions by name and code, as AWS does.
    await page.getByTestId("region").click();
    await expect(page.getByTestId("region-option-us-west-2")).toContainText("US West (Oregon)");
    await expect(page.getByTestId("region-option-us-west-2")).toContainText("us-west-2");
    await expect(page.getByTestId("region-option-af-south-1")).toHaveCount(0);
    await page.getByTestId("region-option-us-west-2").click();
    await expect(page.getByTestId("region")).toHaveAttribute("data-region", "us-west-2");
    await expect(page).toHaveURL(/\/sqs\/queues$/);
    await expect(rowFor()).toBeVisible();

    // Open it: the detail page reads the us-west-2 queue.
    await rowFor().getByRole("link", { name }).click();
    await expect(page).toHaveURL(new RegExp(`/sqs/queues/${name}`));
    await expect(page.getByTestId("kv-Name")).toHaveText(name);

    // CloudShell runs in the chosen Region: the queue's URL resolves only in us-west-2.
    await page.getByRole("button", { name: "CloudShell" }).click();
    await expect(page.getByTestId("cloudshell-region")).toHaveText("us-west-2");
    const input = page.getByLabel("CloudShell command");
    await expect(input).toBeEnabled();
    await input.fill(`aws sqs get-queue-url --queue-name ${name}`);
    await input.press("Enter");
    await expect(page.getByTestId("cloudshell-output").last()).toContainText(`sqs.us-west-2.amazonaws.com/000000000000/${name}`);
    await page.getByRole("button", { name: "Close CloudShell" }).click();

    // Switching Region on a detail page goes to the list in the new Region.
    await switchRegion(page, "us-east-1");
    await expect(page).toHaveURL(/\/sqs\/queues$/);
    await expect(page.getByTestId("resource-table")).toBeVisible();
    await expect(rowFor()).toHaveCount(0);

    // Global services show "Global" instead of a Region.
    await page.goto("/iam/users");
    await expect(page.getByTestId("region")).toHaveAttribute("data-region", "global");
    await expect(page.getByTestId("region")).toHaveText("Global");
  } finally {
    await aws("sqs", "delete-queue", "--queue-url", created?.QueueUrl ?? "", "--region", "us-west-2");
  }
  const after = await aws<{ QueueUrls?: string[] }>("sqs", "list-queues", "--queue-name-prefix", name, "--region", "us-west-2");
  expect(after?.QueueUrls ?? []).toHaveLength(0);
});

test("Region selector: DynamoDB tables and their items are read in the chosen Region", async ({ page }) => {
  const name = uniqueName("e2e-region-t");
  await aws("dynamodb", "create-table", "--region", "us-west-2", "--table-name", name, "--attribute-definitions", "AttributeName=pk,AttributeType=S", "--key-schema", "AttributeName=pk,KeyType=HASH", "--billing-mode", "PAY_PER_REQUEST");
  try {
    await aws("dynamodb", "wait", "table-exists", "--region", "us-west-2", "--table-name", name);
    await aws("dynamodb", "put-item", "--region", "us-west-2", "--table-name", name, "--item", JSON.stringify({ pk: { S: "west-item-1" } }));
    const rowFor = () => page.getByTestId("resource-table").getByRole("row", { name: new RegExp(name) });

    await page.goto("/dynamodb/tables");
    await expect(page.getByTestId("resource-table")).toBeVisible();
    await expect(rowFor()).toHaveCount(0);
    await switchRegion(page, "us-west-2");
    await expect(rowFor()).toBeVisible();

    // Hand-built screens (the item explorer's server actions) use the chosen Region too.
    await page.goto(`/dynamodb/explore-items?table=${name}`);
    await expect(page.getByTestId("items-table")).toContainText("west-item-1");
  } finally {
    await aws("dynamodb", "delete-table", "--region", "us-west-2", "--table-name", name);
  }
});
