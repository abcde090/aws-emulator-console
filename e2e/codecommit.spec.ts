import { expect, test } from "@playwright/test";
import { aws, uniqueName } from "./aws-cli";

async function deleteRepo(name: string): Promise<void> {
  try {
    await aws("codecommit", "delete-repository", "--repository-name", name);
  } catch {
    // Already gone.
  }
}

test("CodeCommit: create a repository, commit a file, branch, browse commits, delete", async ({ page }) => {
  const name = uniqueName("e2e-codecommit");
  try {
    await page.goto("/codecommit/repositories");
    await expect(page.getByRole("heading", { name: /^Repositories/ })).toBeVisible();
    await page.getByRole("link", { name: "Create repository" }).first().click();
    await page.getByLabel("Repository name").fill(name);
    await page.getByLabel("Description - optional").fill("Created by the e2e test");
    await page.getByRole("button", { name: "Create repository" }).click();

    await expect(page).toHaveURL(new RegExp(`/codecommit/repositories/${name}`));
    await expect(page.getByTestId("flash")).toContainText(`Created repository ${name}`);
    const listed = await aws<{ repositories?: { repositoryName?: string }[] }>("codecommit", "list-repositories");
    expect(listed?.repositories?.some((r) => r.repositoryName === name)).toBe(true);

    // Empty repository: create the first file, which creates the main branch.
    await expect(page.getByText("This repository is empty")).toBeVisible();
    await page.getByRole("button", { name: "Create file" }).click();
    await page.getByLabel("File name").fill("README.md");
    await page.getByLabel("File content").fill("hello from e2e");
    await page.getByLabel("Author name").fill("E2E");
    await page.getByLabel("Email address").fill("e2e@example.com");
    await page.getByLabel("Commit message").fill("Add README");
    await page.getByTestId("commit-file").click();
    await expect(page.getByTestId("file-content")).toHaveText("hello from e2e");
    const file = await aws<{ fileContent: string }>("codecommit", "get-file", "--repository-name", name, "--file-path", "README.md");
    expect(Buffer.from(file?.fileContent ?? "", "base64").toString("utf8")).toBe("hello from e2e");

    // Commits tab lists the commit.
    await page.getByRole("tab", { name: "Commits" }).click();
    await expect(page.getByTestId("commits-table")).toContainText("Add README");

    // Create a branch with the Actions menu.
    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Create branch" }).click();
    await page.getByLabel("Branch name").fill("feature-e2e");
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("Created branch feature-e2e");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    const branches = await aws<{ branches: string[] }>("codecommit", "list-branches", "--repository-name", name);
    expect(branches?.branches).toContain("feature-e2e");
    await page.getByRole("tab", { name: "Branches" }).click();
    await expect(page.getByText("feature-e2e")).toBeVisible();

    // Delete from the list.
    await page.goto("/codecommit/repositories");
    const row = page.getByTestId("resource-table").getByRole("row", { name: new RegExp(name) });
    await expect(row).toBeVisible();
    await row.getByRole("radio").check();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill("delete");
    await page.getByTestId("confirm-delete").click();
    await expect(page.getByTestId("flash")).toContainText(`Deleted repository ${name}`);
    const after = await aws<{ repositories?: { repositoryName?: string }[] }>("codecommit", "list-repositories");
    expect(after?.repositories?.some((r) => r.repositoryName === name)).toBe(false);
  } finally {
    await deleteRepo(name);
  }
});

test("CodeCommit: open and merge a pull request", async ({ page }) => {
  const name = uniqueName("e2e-codecommit-pr");
  await aws("codecommit", "create-repository", "--repository-name", name);
  try {
    const first = await aws<{ commitId: string }>("codecommit", "put-file", "--repository-name", name, "--branch-name", "main", "--file-path", "a.txt", "--file-content", "YQo=", "--commit-message", "a");
    await aws("codecommit", "create-branch", "--repository-name", name, "--branch-name", "feature", "--commit-id", first?.commitId ?? "");
    await aws("codecommit", "put-file", "--repository-name", name, "--branch-name", "feature", "--file-path", "b.txt", "--file-content", "Ygo=", "--parent-commit-id", first?.commitId ?? "", "--commit-message", "b");

    await page.goto("/codecommit/pull-requests/create");
    await page.getByLabel("Destination").selectOption({ label: `${name} › main` });
    await page.getByLabel("Source").selectOption({ label: `${name} › feature` });
    await page.getByLabel("Title").fill("E2E pull request");
    await page.getByRole("button", { name: "Create pull request" }).click();
    await expect(page).toHaveURL(/\/codecommit\/pull-requests\/\d+/);
    const id = decodeURIComponent(new URL(page.url()).pathname.split("/").pop() ?? "");
    await page.getByRole("tab", { name: "Changes" }).click();
    await expect(page.getByText("b.txt")).toBeVisible();

    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Merge" }).click();
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("Merged with FAST_FORWARD_MERGE");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    await expect(page.getByTestId("kv-status")).toHaveText(/Merged/);
    const pr = await aws<{ pullRequest: { pullRequestTargets: { mergeMetadata: { isMerged: boolean } }[] } }>("codecommit", "get-pull-request", "--pull-request-id", id);
    expect(pr?.pullRequest.pullRequestTargets[0].mergeMetadata.isMerged).toBe(true);
  } finally {
    await deleteRepo(name);
  }
});

test("CodeCommit: Edit description and Manage tags show current values and saving unchanged changes nothing", async ({ page }) => {
  const name = uniqueName("fix-codecommit");
  const save = async () => {
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toBeVisible();
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
  };
  try {
    await aws("codecommit", "create-repository", "--repository-name", name, "--repository-description", "fix desc", "--tags", "team=ops,env=dev");
    await page.goto(`/codecommit/repositories/${name}`);
    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Edit description" }).click();
    await expect(page.getByTestId("field-description")).toHaveValue("fix desc");
    await save();

    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Manage tags" }).click();
    await expect(page.getByLabel("Tags key 1")).not.toHaveValue("");
    await expect(page.getByLabel("Tags key 2")).not.toHaveValue("");
    await save();

    const repo = await aws<{ repositoryMetadata: { repositoryDescription?: string; Arn: string } }>("codecommit", "get-repository", "--repository-name", name);
    expect(repo?.repositoryMetadata.repositoryDescription).toBe("fix desc");
    const tags = await aws<{ tags: Record<string, string> }>("codecommit", "list-tags-for-resource", "--resource-arn", repo?.repositoryMetadata.Arn ?? "");
    expect(tags?.tags).toEqual({ team: "ops", env: "dev" });
  } finally {
    await deleteRepo(name);
  }
});
