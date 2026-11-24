import { expect, test } from "@playwright/test";
import { aws, uniqueName } from "./aws-cli";

test("S3: create a bucket, upload, browse folders, download, delete objects and the bucket", async ({ page, request }) => {
  const bucket = uniqueName("e2e-bucket");

  await page.goto("/s3/buckets");
  await expect(page.getByRole("heading", { name: /^Buckets/ })).toBeVisible();
  await page.getByRole("link", { name: "Create bucket" }).first().click();
  await page.getByLabel("Bucket name").fill(bucket);
  await page.getByText("Enable Bucket Versioning").click();
  await page.getByRole("button", { name: "Create bucket" }).click();

  await expect(page).toHaveURL(new RegExp(`/s3/buckets/${bucket}`));
  await expect(page.getByTestId("flash").first()).toContainText(`Created bucket ${bucket}`);
  await expect(page.getByTestId("object-browser")).toBeVisible();

  const buckets = await aws<{ Buckets?: { Name: string }[] }>("s3api", "list-buckets");
  expect(buckets?.Buckets?.some((b) => b.Name === bucket)).toBe(true);
  const versioning = await aws<{ Status?: string }>("s3api", "get-bucket-versioning", "--bucket", bucket);
  expect(versioning?.Status).toBe("Enabled");

  // Upload a file and create a folder.
  await page.getByTestId("upload-input").setInputFiles({ name: "hello.txt", mimeType: "text/plain", buffer: Buffer.from("hello s3") });
  await expect(page.getByTestId("objects-table")).toContainText("hello.txt");
  await page.getByRole("button", { name: "Create folder" }).click();
  await page.getByLabel("Folder name").fill("docs");
  await page.getByRole("dialog").getByRole("button", { name: "Create folder" }).click();
  await expect(page.getByTestId("objects-table")).toContainText("docs/");

  const objects = await aws<{ Contents?: { Key: string }[] }>("s3api", "list-objects-v2", "--bucket", bucket);
  expect(objects?.Contents?.map((o) => o.Key).sort()).toEqual(["docs/", "hello.txt"]);

  // Into the folder, upload there, and back out.
  await page.getByRole("button", { name: /docs\// }).click();
  await expect(page).toHaveURL(/prefix=docs%2F/);
  await page.getByTestId("upload-input").setInputFiles({ name: "inner.txt", mimeType: "text/plain", buffer: Buffer.from("inside") });
  await expect(page.getByTestId("objects-table")).toContainText("inner.txt");
  await page.getByRole("navigation", { name: "Folder path" }).getByRole("button", { name: bucket }).click();
  await expect(page.getByTestId("objects-table")).toContainText("hello.txt");

  // Download through the permission-checked route.
  const download = await request.get(`/api/s3/object?bucket=${bucket}&key=hello.txt`);
  expect(download.status()).toBe(200);
  expect(await download.text()).toBe("hello s3");

  // Properties and permissions tabs show the emulator's answers.
  await page.getByRole("tab", { name: "Properties" }).click();
  await expect(page.getByTestId("kv-Bucket Versioning").last()).toHaveText("Enabled");
  await page.getByRole("tab", { name: "Block public access" }).click();
  await expect(page.getByTestId("kv-Block all public access")).toHaveText("On");

  // Delete the folder (with its object) and the file.
  await page.getByRole("tab", { name: "Objects" }).click();
  await page.getByRole("checkbox", { name: "Select docs/" }).check();
  await page.getByRole("checkbox", { name: "Select hello.txt" }).check();
  await page.getByTestId("object-browser").getByRole("button", { name: "Delete", exact: true }).click();
  // Versioned bucket: the console explains delete markers and asks for "delete".
  await expect(page.getByTestId("delete-explanation")).toContainText("delete markers");
  await page.getByLabel("Confirm object deletion").fill("delete");
  await page.getByTestId("confirm-delete-objects").click();
  await expect(page.getByTestId("object-browser").getByTestId("flash")).toContainText("Created 3 delete markers");
  await expect(page.getByTestId("objects-table")).not.toContainText("hello.txt");

  // Versioning keeps old versions; Empty removes them so the bucket can be deleted.
  await page.getByRole("button", { name: "Actions" }).click();
  await page.getByRole("menuitem", { name: "Empty" }).click();
  await page.getByTestId("action-submit").click();
  await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("Deleted");
  await page.getByRole("button", { name: "Close", exact: true }).last().click();

  await page.getByRole("button", { name: "Delete", exact: true }).first().click();
  await page.getByLabel("Confirm deletion").fill(bucket);
  await page.getByTestId("confirm-delete").click();
  await expect(page).toHaveURL(/\/s3\/buckets\?deleted=/);
  await expect(page.getByTestId("resource-table").getByRole("row", { name: new RegExp(bucket) })).toHaveCount(0);

  const after = await aws<{ Buckets?: { Name: string }[] }>("s3api", "list-buckets");
  expect(after?.Buckets?.some((b) => b.Name === bucket)).toBe(false);
});

test("S3: Edit dialogs show the bucket's current settings and saving unchanged changes nothing", async ({ page }) => {
  const bucket = uniqueName("fix-s3-edit");
  await aws("s3api", "create-bucket", "--bucket", bucket);
  try {
    await aws("s3api", "put-bucket-tagging", "--bucket", bucket, "--tagging", "TagSet=[{Key=env,Value=prod},{Key=team,Value=data}]");
    await aws("s3api", "put-bucket-versioning", "--bucket", bucket, "--versioning-configuration", "Status=Suspended");
    await aws("s3api", "put-public-access-block", "--bucket", bucket, "--public-access-block-configuration", "BlockPublicAcls=false,IgnorePublicAcls=true,BlockPublicPolicy=false,RestrictPublicBuckets=false");

    await page.goto(`/s3/buckets/${bucket}`);
    const openAction = async (name: string) => {
      await page.getByRole("button", { name: "Actions" }).click();
      await page.getByRole("menuitem", { name }).click();
    };
    const closeDialog = () => page.getByRole("button", { name: "Close", exact: true }).last().click();

    // Edit tags: prefilled, save unchanged keeps both tags.
    await openAction("Edit tags");
    await expect(page.getByLabel("Tags key 1")).toHaveValue("env");
    await expect(page.getByLabel("Tags value 1")).toHaveValue("prod");
    await expect(page.getByLabel("Tags key 2")).toHaveValue("team");
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("No tag changes");
    await closeDialog();
    const tags = await aws<{ TagSet: { Key: string; Value: string }[] }>("s3api", "get-bucket-tagging", "--bucket", bucket);
    expect(tags?.TagSet.map((t) => `${t.Key}=${t.Value}`).sort()).toEqual(["env=prod", "team=data"]);

    // Edit Bucket Versioning shows Suspended.
    await openAction("Edit Bucket Versioning");
    await expect(page.getByTestId("field-status").getByRole("radio", { name: "Suspend" })).toBeChecked();
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("already Suspended");
    await closeDialog();
    expect((await aws<{ Status?: string }>("s3api", "get-bucket-versioning", "--bucket", bucket))?.Status).toBe("Suspended");

    // Edit Block Public Access shows the real flags.
    await openAction("Edit Block Public Access");
    await expect(page.getByTestId("field-BlockPublicAcls")).not.toBeChecked();
    await expect(page.getByTestId("field-IgnorePublicAcls")).toBeChecked();
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("saved");
    await closeDialog();
    const bpa = await aws<{ PublicAccessBlockConfiguration: Record<string, boolean> }>("s3api", "get-public-access-block", "--bucket", bucket);
    expect(bpa?.PublicAccessBlockConfiguration).toEqual({ BlockPublicAcls: false, IgnorePublicAcls: true, BlockPublicPolicy: false, RestrictPublicBuckets: false });
  } finally {
    await aws("s3api", "delete-bucket", "--bucket", bucket);
  }
});

test("S3: Show versions, version deletes and the object page", async ({ page }) => {
  const bucket = uniqueName("fix-s3-ver");
  await aws("s3api", "create-bucket", "--bucket", bucket);
  await aws("s3api", "put-bucket-versioning", "--bucket", bucket, "--versioning-configuration", "Status=Enabled");
  try {
    await page.goto(`/s3/buckets/${bucket}`);
    await page.getByTestId("upload-input").setInputFiles({ name: "ver.txt", mimeType: "text/plain", buffer: Buffer.from("v1") });
    await expect(page.getByTestId("objects-table")).toContainText("ver.txt");
    await page.getByTestId("upload-input").setInputFiles({ name: "ver.txt", mimeType: "text/plain", buffer: Buffer.from("v2") });
    await expect(page.getByTestId("object-browser").getByTestId("flash")).toContainText("Uploaded 1 file");

    // The object page: properties, tags, versions, storage class.
    await page.getByRole("link", { name: "ver.txt" }).click();
    await expect(page).toHaveURL(/\/object\?key=ver\.txt/);
    await expect(page.getByTestId("kv-S3 URI")).toHaveText(`s3://${bucket}/ver.txt`);
    await aws("s3api", "put-object-tagging", "--bucket", bucket, "--key", "ver.txt", "--tagging", "TagSet=[{Key=k,Value=v}]");
    await page.reload();
    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Edit tags" }).click();
    await expect(page.getByLabel("Tags key 1")).toHaveValue("k");
    await page.getByTestId("action-submit").click();
    await expect(page.getByTestId("flash")).toContainText("No tag changes");
    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Edit storage class" }).click();
    await expect(page.getByTestId("field-storageClass").getByRole("radio", { name: "STANDARD", exact: true })).toBeChecked();
    await page.getByTestId("field-storageClass").getByRole("radio", { name: "STANDARD_IA" }).check();
    await page.getByTestId("action-submit").click();
    await expect(page.getByTestId("flash")).toContainText("Storage class changed to STANDARD_IA");
    const head = await aws<{ StorageClass?: string }>("s3api", "head-object", "--bucket", bucket, "--key", "ver.txt");
    expect(head?.StorageClass).toBe("STANDARD_IA");
    await page.getByRole("tab", { name: "Versions" }).click();
    await expect(page.getByTestId("versions-table").locator("tbody tr")).toHaveCount(3);

    // Back in the browser: delete adds a marker, Show versions lists everything.
    await page.goto(`/s3/buckets/${bucket}`);
    await page.getByRole("checkbox", { name: "Select ver.txt" }).check();
    await page.getByTestId("object-browser").getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm object deletion").fill("delete");
    await page.getByTestId("confirm-delete-objects").click();
    await expect(page.getByTestId("object-browser").getByTestId("flash")).toContainText("Created 1 delete marker");
    await page.getByTestId("show-versions").check();
    await expect(page.getByTestId("version-row")).toHaveCount(4);
    await expect(page.getByTestId("objects-table")).toContainText("Delete marker");

    // Permanently delete every version.
    const listed = await aws<{ Versions?: { VersionId: string }[]; DeleteMarkers?: { VersionId: string }[] }>("s3api", "list-object-versions", "--bucket", bucket);
    for (const v of [...(listed?.Versions ?? []), ...(listed?.DeleteMarkers ?? [])]) {
      await page.getByRole("checkbox", { name: `Select ver.txt version ${v.VersionId}` }).check();
    }
    await page.getByTestId("object-browser").getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm object deletion").fill("permanently delete");
    await page.getByTestId("confirm-delete-objects").click();
    await expect(page.getByTestId("object-browser").getByTestId("flash")).toContainText("Permanently deleted 4 versions");
    const after = await aws<{ Versions?: unknown[]; DeleteMarkers?: unknown[] }>("s3api", "list-object-versions", "--bucket", bucket);
    expect([...(after?.Versions ?? []), ...(after?.DeleteMarkers ?? [])]).toHaveLength(0);
  } finally {
    const left = await aws<{ Versions?: { Key: string; VersionId: string }[]; DeleteMarkers?: { Key: string; VersionId: string }[] }>("s3api", "list-object-versions", "--bucket", bucket);
    for (const v of [...(left?.Versions ?? []), ...(left?.DeleteMarkers ?? [])]) {
      await aws("s3api", "delete-object", "--bucket", bucket, "--key", v.Key, "--version-id", v.VersionId);
    }
    await aws("s3api", "delete-bucket", "--bucket", bucket);
  }
});

test("S3: Management tab creates, edits and deletes lifecycle, replication and inventory rules", async ({ page }) => {
  const source = uniqueName("e2e-mgmt-src");
  const dest = uniqueName("e2e-mgmt-dst");
  const roleName = uniqueName("e2e-s3-repl");
  await aws("s3api", "create-bucket", "--bucket", source);
  await aws("s3api", "create-bucket", "--bucket", dest);
  const role = await aws<{ Role: { Arn: string } }>("iam", "create-role", "--role-name", roleName, "--assume-role-policy-document", JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "s3.amazonaws.com" }, Action: "sts:AssumeRole" }] }));
  try {
    await aws("s3api", "put-bucket-versioning", "--bucket", source, "--versioning-configuration", "Status=Enabled");
    await page.goto(`/s3/buckets/${source}`);
    await page.getByRole("tab", { name: "Management" }).click();
    const tab = page.getByTestId("management-tab");
    await expect(tab.getByText("No lifecycle rules", { exact: true })).toBeVisible();
    const dialog = page.getByRole("dialog");

    // Create a lifecycle rule: prefix filter, a transition, an expiration and a multipart cleanup.
    await page.getByTestId("lifecycle-create").click();
    await page.getByTestId("field-ruleId").fill("archive-logs");
    await page.getByTestId("field-prefix").fill("logs/");
    await page.getByTestId("field-transitionCurrent").check();
    await page.getByTestId("field-t1Class").selectOption("GLACIER");
    await page.getByTestId("field-t1Days").fill("30");
    await page.getByTestId("field-expireCurrent").check();
    await page.getByTestId("field-expireDays").fill("365");
    await page.getByTestId("field-abortMultipart").check();
    await page.getByTestId("field-abortDays").fill("7");
    await page.getByTestId("rule-save").click();
    await expect(tab.getByTestId("flash")).toContainText('Created lifecycle rule "archive-logs"');
    await expect(page.getByTestId("lifecycle-table")).toContainText("Transition to Glacier Flexible Retrieval (formerly Glacier) after 30 days");
    type Lifecycle = { Rules: { ID: string; Filter: unknown; Transitions?: unknown; Expiration?: { Days?: number }; AbortIncompleteMultipartUpload?: unknown }[] };
    const lc = await aws<Lifecycle>("s3api", "get-bucket-lifecycle-configuration", "--bucket", source);
    expect(lc?.Rules).toHaveLength(1);
    expect(lc?.Rules[0]).toMatchObject({ ID: "archive-logs", Filter: { Prefix: "logs/" }, Transitions: [{ Days: 30, StorageClass: "GLACIER" }], Expiration: { Days: 365 }, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 } });

    // Edit unchanged: nothing is written.
    await page.getByRole("radio", { name: "Select archive-logs" }).check();
    await page.getByTestId("lifecycle-edit").click();
    await expect(page.getByTestId("field-ruleId")).toHaveValue("archive-logs");
    await expect(page.getByTestId("field-expireDays")).toHaveValue("365");
    await page.getByTestId("rule-save").click();
    await expect(tab.getByTestId("flash")).toContainText("No changes to save.");
    expect(await aws<Lifecycle>("s3api", "get-bucket-lifecycle-configuration", "--bucket", source)).toEqual(lc);

    // Edit with a change.
    await page.getByRole("radio", { name: "Select archive-logs" }).check();
    await page.getByTestId("lifecycle-edit").click();
    await page.getByTestId("field-expireDays").fill("400");
    await page.getByTestId("rule-save").click();
    await expect(tab.getByTestId("flash")).toContainText('Saved lifecycle rule "archive-logs"');
    expect((await aws<Lifecycle>("s3api", "get-bucket-lifecycle-configuration", "--bucket", source))?.Rules[0].Expiration?.Days).toBe(400);

    // Replication: AWS requires versioning on the destination too.
    await page.getByTestId("replication-create").click();
    await page.getByTestId("field-ruleId").fill("to-dest");
    await page.getByRole("radio", { name: "Apply to all objects in the bucket" }).check();
    await page.getByTestId("field-destBucket").selectOption(dest);
    await page.getByTestId("field-role").selectOption(role?.Role.Arn ?? "");
    await page.getByTestId("field-changeStorageClass").check();
    await page.getByTestId("field-storageClass").selectOption("STANDARD_IA");
    await page.getByTestId("field-deleteMarkerReplication").check();
    await page.getByTestId("rule-save").click();
    await expect(dialog.getByTestId("error-banner")).toContainText("versioning to be enabled for the destination bucket");
    await aws("s3api", "put-bucket-versioning", "--bucket", dest, "--versioning-configuration", "Status=Enabled");
    await page.getByTestId("rule-save").click();
    await expect(tab.getByTestId("flash")).toContainText('Created replication rule "to-dest"');
    await expect(page.getByTestId("replication-table")).toContainText(dest);
    type Replication = { ReplicationConfiguration: { Role: string; Rules: { ID: string; Priority: number; Destination: { Bucket: string; StorageClass?: string }; DeleteMarkerReplication: { Status: string } }[] } };
    const rep = await aws<Replication>("s3api", "get-bucket-replication", "--bucket", source);
    expect(rep?.ReplicationConfiguration.Role).toBe(role?.Role.Arn);
    expect(rep?.ReplicationConfiguration.Rules[0]).toMatchObject({ ID: "to-dest", Priority: 0, Destination: { Bucket: `arn:aws:s3:::${dest}`, StorageClass: "STANDARD_IA" }, DeleteMarkerReplication: { Status: "Enabled" } });

    await page.getByRole("radio", { name: "Select to-dest" }).check();
    await page.getByTestId("replication-edit").click();
    await expect(page.getByTestId("field-destBucket")).toHaveValue(dest);
    await page.getByTestId("rule-save").click();
    await expect(tab.getByTestId("flash")).toContainText("No changes to save.");

    // Inventory: create, then delete.
    await page.getByTestId("inventory-create").click();
    await page.getByTestId("field-inventoryId").fill("weekly-inv");
    await page.getByTestId("field-destBucket").selectOption(dest);
    await page.getByRole("radio", { name: "Weekly" }).check();
    await page.getByTestId("rule-save").click();
    await expect(tab.getByTestId("flash")).toContainText('Created inventory configuration "weekly-inv"');
    const inv = await aws<{ InventoryConfiguration: { Schedule: { Frequency: string } } }>("s3api", "get-bucket-inventory-configuration", "--bucket", source, "--id", "weekly-inv");
    expect(inv?.InventoryConfiguration.Schedule.Frequency).toBe("Weekly");
    await page.getByRole("radio", { name: "Select weekly-inv" }).check();
    await page.getByTestId("inventory-delete").click();
    await page.getByTestId("field-confirm").fill("weekly-inv");
    await page.getByTestId("rule-delete-confirm").click();
    await expect(tab.getByTestId("flash")).toContainText('Deleted inventory configuration "weekly-inv"');

    // Delete the replication and lifecycle rules: the last rule removes the configuration.
    await page.getByRole("radio", { name: "Select to-dest" }).check();
    await page.getByTestId("replication-delete").click();
    await page.getByTestId("field-confirm").fill("to-dest");
    await page.getByTestId("rule-delete-confirm").click();
    await expect(tab.getByTestId("flash")).toContainText('Deleted replication rule "to-dest"');
    await page.getByRole("radio", { name: "Select archive-logs" }).check();
    await page.getByTestId("lifecycle-delete").click();
    await page.getByTestId("field-confirm").fill("archive-logs");
    await page.getByTestId("rule-delete-confirm").click();
    await expect(tab.getByTestId("flash")).toContainText('Deleted lifecycle rule "archive-logs"');
    await expect(tab.getByText("No lifecycle rules", { exact: true })).toBeVisible();
    await expect(aws("s3api", "get-bucket-lifecycle-configuration", "--bucket", source)).rejects.toThrow(/NoSuchLifecycleConfiguration/);
    await expect(aws("s3api", "get-bucket-replication", "--bucket", source)).rejects.toThrow(/ReplicationConfigurationNotFound/);
  } finally {
    await aws("s3api", "delete-bucket-lifecycle", "--bucket", source).catch(() => null);
    await aws("s3api", "delete-bucket-replication", "--bucket", source).catch(() => null);
    await aws("s3api", "delete-bucket-inventory-configuration", "--bucket", source, "--id", "weekly-inv").catch(() => null);
    await aws("s3api", "delete-bucket", "--bucket", source);
    await aws("s3api", "delete-bucket", "--bucket", dest);
    await aws("iam", "delete-role", "--role-name", roleName);
  }
});
