import { expect, test, type Page } from "@playwright/test";
import { aws, uniqueName } from "./aws-cli";

interface Reservations {
  Reservations?: { Instances?: { InstanceId?: string; State?: { Name?: string }; SecurityGroups?: { GroupId?: string }[] }[] }[];
}

async function instancesNamed(name: string) {
  const r = await aws<Reservations>("ec2", "describe-instances", "--filters", `Name=tag:Name,Values=${name}`);
  return (r?.Reservations ?? []).flatMap((x) => x.Instances ?? []);
}

async function runAction(page: Page, label: string) {
  await page.getByRole("button", { name: "Actions" }).click();
  await page.getByRole("menuitem", { name: label }).click();
  await page.getByTestId("action-submit").click();
}

test("EC2: launch an instance with the wizard, stop it, then terminate it", async ({ page }) => {
  test.setTimeout(120_000);
  const name = uniqueName("e2e-ec2");
  const sgName = uniqueName("e2e-ec2-sg");
  try {
    await page.goto("/ec2/instances");
    await expect(page.getByRole("heading", { name: /^Instances/ })).toBeVisible();
    await page.getByRole("link", { name: "Launch instances" }).first().click();
    await expect(page.getByTestId("launch-wizard")).toBeVisible();

    await page.getByLabel("Name", { exact: true }).fill(name);
    await page.getByRole("button", { name: "Amazon Linux" }).click();
    await expect(page.getByTestId("ami-details")).toContainText("ami-");
    await page.getByLabel("Filter instance types").fill("t3.micro");
    await page.getByLabel("Instance type", { exact: true }).selectOption("t3.micro");
    await page.getByLabel("Security group name").fill(sgName);
    await page.getByText("Allow HTTP traffic from the internet").click();
    await page.getByLabel("Root volume size (GiB)").fill("12");
    await page.getByTestId("launch-submit").click();

    await expect(page.getByTestId("launch-success")).toContainText("Successfully initiated launch of 1 instance");
    const launched = await instancesNamed(name);
    expect(launched).toHaveLength(1);
    const id = launched[0].InstanceId as string;
    const sgs = await aws<{ SecurityGroups?: { GroupId?: string; IpPermissions?: { FromPort?: number }[] }[] }>("ec2", "describe-security-groups", "--filters", `Name=group-name,Values=${sgName}`);
    expect(sgs?.SecurityGroups?.[0]?.IpPermissions?.map((p) => p.FromPort).sort()).toEqual([22, 80]);

    // In the list, then the detail page.
    await page.goto("/ec2/instances");
    await page.getByLabel("Find instances").fill(name);
    const row = page.getByTestId("resource-table").getByRole("row", { name: new RegExp(name) });
    await expect(row).toBeVisible();
    await row.getByRole("link", { name: id }).click();
    await expect(page.getByTestId("kv-Instance ID")).toHaveText(id);
    await expect(page.getByTestId("kv-Instance type")).toHaveText("t3.micro");
    await page.getByRole("tab", { name: "Storage" }).click();
    await expect(page.getByRole("cell", { name: "12" }).first()).toBeVisible();

    await runAction(page, "Stop instance");
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText(`Stopping ${id}`);
    await page.getByRole("button", { name: "Close", exact: true }).last().click();

    await runAction(page, "Get system log");
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("System log");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();

    await runAction(page, "Terminate (delete) instance");
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText(`Terminating ${id}`);
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    await expect.poll(async () => (await instancesNamed(name))[0]?.State?.Name).toMatch(/shutting-down|terminated/);
  } finally {
    for (const i of await instancesNamed(name)) {
      if (i.InstanceId && i.State?.Name !== "terminated") await aws("ec2", "terminate-instances", "--instance-ids", i.InstanceId);
    }
    const sgs = await aws<{ SecurityGroups?: { GroupId?: string }[] }>("ec2", "describe-security-groups", "--filters", `Name=group-name,Values=${sgName}`);
    for (const g of sgs?.SecurityGroups ?? []) {
      // The group can be deleted once the instance has terminated.
      await expect.poll(async () => (await aws("ec2", "delete-security-group", "--group-id", g.GroupId as string).then(() => "ok", (e: Error) => e.message)), { timeout: 30_000 }).toBe("ok");
    }
  }
});

test("EC2: create a security group, add and remove an inbound rule, delete it", async ({ page }) => {
  const name = uniqueName("e2e-ec2-sg");
  try {
    await page.goto("/ec2/security-groups/create");
    await page.getByLabel("Security group name").fill(name);
    await page.getByLabel("Description", { exact: true }).fill("e2e test group");
    await page.getByText("Allow SSH traffic (TCP 22)").click();
    await page.getByRole("button", { name: "Create security group" }).click();
    await expect(page.getByTestId("flash")).toContainText("Created security group");
    await expect(page.getByTestId("kv-Security group name")).toHaveText(name);
    await expect(page.getByTestId("kv-Inbound rules count")).toHaveText("1");

    const listed = await aws<{ SecurityGroups?: { GroupId?: string }[] }>("ec2", "describe-security-groups", "--filters", `Name=group-name,Values=${name}`);
    const groupId = listed?.SecurityGroups?.[0]?.GroupId as string;
    expect(groupId).toMatch(/^sg-/);

    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Add inbound rule" }).click();
    await page.getByLabel("Type", { exact: true }).selectOption("custom-tcp");
    await page.getByLabel("Port range").fill("8080");
    await page.getByLabel("Source", { exact: true }).fill("10.0.0.0/16");
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("Added inbound rule");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    await expect(page.getByTestId("kv-Inbound rules count")).toHaveText("2");

    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Edit inbound rules" }).click();
    await page.getByTestId("action-submit").click();
    const results = page.getByTestId("result-table");
    await results.getByRole("row", { name: /8080/ }).getByRole("checkbox").check();
    await page.getByRole("button", { name: /^Delete \(1\)/ }).click();
    await expect(page.getByRole("dialog")).toContainText("Deleted 1 inbound rule");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();

    await page.goto("/ec2/security-groups");
    const row = page.getByTestId("resource-table").getByRole("row", { name: new RegExp(name) });
    await expect(row).toBeVisible();
    await row.getByRole("radio").check();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill("delete");
    await page.getByTestId("confirm-delete").click();
    await expect(page.getByTestId("flash")).toContainText(`Deleted security group ${groupId}`);
    const after = await aws<{ SecurityGroups?: unknown[] }>("ec2", "describe-security-groups", "--filters", `Name=group-name,Values=${name}`);
    expect(after?.SecurityGroups ?? []).toHaveLength(0);
  } finally {
    const left = await aws<{ SecurityGroups?: { GroupId?: string }[] }>("ec2", "describe-security-groups", "--filters", `Name=group-name,Values=${name}`);
    for (const g of left?.SecurityGroups ?? []) await aws("ec2", "delete-security-group", "--group-id", g.GroupId as string);
  }
});

test("EC2: create a key pair (private key download), see it, delete it", async ({ page }) => {
  const name = uniqueName("e2e-ec2-kp");
  try {
    await page.goto("/ec2/key-pairs");
    await page.getByRole("link", { name: "Create key pair" }).first().click();
    await page.getByLabel("Key pair name").fill(name);
    const download = page.waitForEvent("download");
    await page.getByTestId("key-pair-submit").click();
    expect((await download).suggestedFilename()).toBe(`${name}.pem`);
    await expect(page.getByTestId("flash")).toContainText(`Successfully created key pair ${name}`);
    const listed = await aws<{ KeyPairs?: { KeyName?: string }[] }>("ec2", "describe-key-pairs", "--key-names", name);
    expect(listed?.KeyPairs?.[0]?.KeyName).toBe(name);
    await page.getByTestId("key-pair-link").click();
    await expect(page.getByTestId("kv-Name")).toHaveText(name);
    await deleteFromDetail(page, name);
    await expect(page).toHaveURL(/\/ec2\/key-pairs\?deleted=/);
  } finally {
    await aws("ec2", "delete-key-pair", "--key-name", name);
  }
});

async function deleteFromDetail(page: Page, confirm: string) {
  // Retry the click until the dialog opens (the page may still be hydrating).
  await expect(async () => {
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByLabel("Confirm deletion")).toBeVisible({ timeout: 1000 });
  }).toPass();
  await page.getByLabel("Confirm deletion").fill(confirm);
  await page.getByTestId("confirm-delete").click();
}

test("EC2: target group and Application Load Balancer with a listener", async ({ page }) => {
  const tg = uniqueName("e2e-ec2-tg").slice(0, 32);
  const lb = uniqueName("e2e-ec2-lb").slice(0, 32);
  try {
    await page.goto("/ec2/target-groups/create");
    await page.getByLabel("Target group name").fill(tg);
    const vpcSelect = page.getByLabel(/^VPC/);
    const firstVpc = await vpcSelect.locator("option").first().getAttribute("value");
    await vpcSelect.selectOption({ index: firstVpc ? 0 : 1 });
    await page.getByRole("button", { name: "Create target group" }).click();
    await expect(page.getByTestId("kv-Target group name")).toHaveText(tg);

    await page.goto("/ec2/load-balancers/create");
    await page.getByLabel("Load balancer name").fill(lb);
    await page.getByLabel("VPC", { exact: true }).selectOption({ index: 0 });
    const subnets = page.getByLabel("Availability Zones and subnets");
    const options = await subnets.locator("option").allTextContents();
    await subnets.selectOption(options.filter((o) => o.includes("172.31.")).slice(0, 2).map((label) => ({ label })));
    await page.getByLabel("Default action: forward to target group").selectOption({ label: (await page.getByLabel("Default action: forward to target group").locator("option").allTextContents()).find((o) => o.startsWith(tg)) as string });
    await page.getByRole("button", { name: "Create load balancer" }).click();
    await expect(page.getByTestId("kv-Load balancer name")).toHaveText(lb);
    await page.getByRole("tab", { name: "Listeners and rules" }).click();
    await expect(page.getByText(`Forward to ${tg}`)).toBeVisible();

    const lbs = await aws<{ LoadBalancers?: { LoadBalancerArn?: string; Type?: string }[] }>("elbv2", "describe-load-balancers", "--names", lb);
    expect(lbs?.LoadBalancers?.[0]?.Type).toBe("application");
    const listeners = await aws<{ Listeners?: { Port?: number }[] }>("elbv2", "describe-listeners", "--load-balancer-arn", lbs?.LoadBalancers?.[0]?.LoadBalancerArn as string);
    expect(listeners?.Listeners?.[0]?.Port).toBe(80);

    await deleteFromDetail(page, "delete");
    await expect(page).toHaveURL(/\/ec2\/load-balancers\?deleted=/);
    await page.goto(`/ec2/target-groups/${tg}`);
    await deleteFromDetail(page, "delete");
    await expect(page).toHaveURL(/\/ec2\/target-groups\?deleted=/);
  } finally {
    const lbs = await aws<{ LoadBalancers?: { LoadBalancerArn?: string }[] }>("elbv2", "describe-load-balancers").catch(() => null);
    for (const l of lbs?.LoadBalancers ?? []) if (l.LoadBalancerArn?.includes(`/${lb}/`)) await aws("elbv2", "delete-load-balancer", "--load-balancer-arn", l.LoadBalancerArn);
    const tgs = await aws<{ TargetGroups?: { TargetGroupArn?: string; TargetGroupName?: string }[] }>("elbv2", "describe-target-groups").catch(() => null);
    for (const t of tgs?.TargetGroups ?? []) if (t.TargetGroupName === tg) await aws("elbv2", "delete-target-group", "--target-group-arn", t.TargetGroupArn as string);
  }
});

test("EC2: launch template and Auto Scaling group with a scaling policy", async ({ page }) => {
  const lt = uniqueName("e2e-ec2-lt");
  const asg = uniqueName("e2e-ec2-asg");
  try {
    await page.goto("/ec2/launch-templates/create");
    await page.getByLabel("Launch template name").fill(lt);
    await page.getByLabel(/^AMI ID/).fill("ami-0000000000000003d");
    await page.getByLabel(/^Instance type/).selectOption("t3.micro");
    await page.getByRole("button", { name: "Create launch template" }).click();
    await expect(page.getByTestId("kv-Launch template name")).toHaveText(lt);

    await page.goto("/ec2/auto-scaling-groups/create");
    await page.getByLabel("Auto Scaling group name").fill(asg);
    await page.getByLabel("Launch template", { exact: true }).selectOption({ label: (await page.getByLabel("Launch template", { exact: true }).locator("option").allTextContents()).find((o) => o.startsWith(lt)) as string });
    const subnets = page.getByLabel("Availability Zones and subnets");
    await subnets.selectOption({ label: (await subnets.locator("option").allTextContents()).find((o) => o.includes("172.31.0.0/20")) as string });
    await page.getByLabel("Desired capacity", { exact: true }).fill("0");
    await page.getByLabel("Min desired capacity").fill("0");
    await page.getByLabel("Target tracking scaling policy: average CPU utilization target (%)").fill("50");
    await page.getByRole("button", { name: "Create Auto Scaling group" }).click();
    await expect(page.getByTestId("kv-Name")).toHaveText(asg);
    await page.getByRole("tab", { name: "Automatic scaling" }).click();
    await expect(page.getByText("ASGAverageCPUUtilization target 50")).toBeVisible();

    const groups = await aws<{ AutoScalingGroups?: { MaxSize?: number }[] }>("autoscaling", "describe-auto-scaling-groups", "--auto-scaling-group-names", asg);
    expect(groups?.AutoScalingGroups).toHaveLength(1);

    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Edit group size" }).click();
    await page.getByLabel("Desired capacity", { exact: true }).fill("0");
    await page.getByLabel("Min desired capacity").fill("0");
    await page.getByLabel("Max desired capacity").fill("2");
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("max 2");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    await expect.poll(async () => (await aws<{ AutoScalingGroups?: { MaxSize?: number }[] }>("autoscaling", "describe-auto-scaling-groups", "--auto-scaling-group-names", asg))?.AutoScalingGroups?.[0]?.MaxSize).toBe(2);

    await deleteFromDetail(page, "delete");
    await expect(page).toHaveURL(/\/ec2\/auto-scaling-groups\?deleted=/);
  } finally {
    await aws("autoscaling", "delete-auto-scaling-group", "--auto-scaling-group-name", asg, "--force-delete").catch(() => null);
    await aws("ec2", "delete-launch-template", "--launch-template-name", lt).catch(() => null);
  }
});

test("EC2: volume with a snapshot, Elastic IP and placement group", async ({ page }) => {
  const vol = uniqueName("e2e-ec2-vol");
  const pg = uniqueName("e2e-ec2-pg");
  const filters = ["--filters", `Name=tag:Name,Values=${vol}`];
  try {
    await page.goto("/ec2/volumes/create");
    await page.getByLabel("Size (GiB)").fill("4");
    await page.getByLabel("Availability Zone").selectOption("us-east-1a");
    await page.getByLabel(/^Name/).fill(vol);
    await page.getByRole("button", { name: "Create volume" }).click();
    await expect(page.getByTestId("kv-Name")).toHaveText(vol);
    const volumeId = (await aws<{ Volumes?: { VolumeId?: string }[] }>("ec2", "describe-volumes", ...filters))?.Volumes?.[0]?.VolumeId as string;
    expect(volumeId).toMatch(/^vol-/);

    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Create snapshot" }).click();
    await page.getByRole("dialog").getByLabel(/^Name/).fill(vol);
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("Created snapshot snap-");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    const snapId = (await aws<{ Snapshots?: { SnapshotId?: string }[] }>("ec2", "describe-snapshots", "--owner-ids", "self", ...filters))?.Snapshots?.[0]?.SnapshotId as string;
    await page.goto(`/ec2/snapshots/${snapId}`);
    await deleteFromDetail(page, "delete");
    await expect(page).toHaveURL(/\/ec2\/snapshots\?deleted=/);
    await page.goto(`/ec2/volumes/${volumeId}`);
    await deleteFromDetail(page, "delete");
    await expect(page).toHaveURL(/\/ec2\/volumes\?deleted=/);

    await page.goto("/ec2/elastic-ips/create");
    await page.getByLabel(/^Name/).fill(vol);
    await page.getByRole("button", { name: "Allocate Elastic IP address" }).click();
    await expect(page.getByTestId("kv-Allocated IPv4 address")).not.toHaveText("-");
    await deleteFromDetail(page, "delete");
    await expect(page).toHaveURL(/\/ec2\/elastic-ips\?deleted=/);

    await page.goto("/ec2/placement-groups/create");
    await page.getByLabel(/^Name/).fill(pg);
    await page.getByLabel("Placement strategy").selectOption("spread");
    await page.getByRole("button", { name: "Create placement group" }).click();
    await expect(page.getByTestId("kv-Strategy")).toHaveText("spread");
    await deleteFromDetail(page, "delete");
    await expect(page).toHaveURL(/\/ec2\/placement-groups\?deleted=/);
  } finally {
    for (const s of (await aws<{ Snapshots?: { SnapshotId?: string }[] }>("ec2", "describe-snapshots", "--owner-ids", "self", ...filters))?.Snapshots ?? []) await aws("ec2", "delete-snapshot", "--snapshot-id", s.SnapshotId as string);
    for (const v of (await aws<{ Volumes?: { VolumeId?: string }[] }>("ec2", "describe-volumes", ...filters))?.Volumes ?? []) await aws("ec2", "delete-volume", "--volume-id", v.VolumeId as string);
    for (const a of (await aws<{ Addresses?: { AllocationId?: string }[] }>("ec2", "describe-addresses", ...filters))?.Addresses ?? []) await aws("ec2", "release-address", "--allocation-id", a.AllocationId as string);
    await aws("ec2", "delete-placement-group", "--group-name", pg).catch(() => null);
  }
});

// ---- Edit dialogs show current values; saving them unchanged changes nothing ----

async function openEdit(page: Page, label: string) {
  await page.getByRole("button", { name: "Actions" }).click();
  await page.getByRole("menuitem", { name: label }).click();
  await expect(page.getByTestId("action-submit")).toBeEnabled();
}

async function saveAndClose(page: Page, text: string | RegExp) {
  await page.getByTestId("action-submit").click();
  await expect(page.getByRole("dialog").getByTestId("flash")).toContainText(text);
  await page.getByRole("button", { name: "Close", exact: true }).last().click();
}

test("EC2: instance edit dialogs are prefilled and an unchanged save keeps the settings", async ({ page }) => {
  test.setTimeout(120_000);
  const name = uniqueName("fix-ec2-i");
  let id = "";
  try {
    const images = await aws<{ Images?: { ImageId?: string; Architecture?: string }[] }>("ec2", "describe-images", "--owners", "amazon", "--filters", "Name=architecture,Values=x86_64");
    const ami = images?.Images?.[0]?.ImageId as string;
    const run = await aws<{ Instances?: { InstanceId?: string }[] }>(
      "ec2", "run-instances", "--image-id", ami, "--instance-type", "t3.micro", "--count", "1", "--disable-api-termination",
      "--metadata-options", "HttpTokens=optional,HttpPutResponseHopLimit=3",
      "--tag-specifications", `ResourceType=instance,Tags=[{Key=Name,Value=${name}},{Key=env,Value=prod}]`
    );
    id = run?.Instances?.[0]?.InstanceId as string;
    await page.goto(`/ec2/instances/${id}`);
    await expect(page.getByTestId("kv-Instance ID")).toHaveText(id);

    // Manage tags: Name and env are shown; saving unchanged keeps both.
    await openEdit(page, "Manage tags");
    const dialog = page.getByRole("dialog");
    await expect(dialog.locator(`input[value="${name}"]`)).toHaveCount(1);
    await expect(dialog.locator('input[value="prod"]')).toHaveCount(1);
    await saveAndClose(page, "No tag changes");
    const tags = await aws<{ Tags?: { Key?: string; Value?: string }[] }>("ec2", "describe-tags", "--filters", `Name=resource-id,Values=${id}`);
    expect(Object.fromEntries((tags?.Tags ?? []).map((t) => [t.Key, t.Value]))).toEqual({ Name: name, env: "prod" });

    // Termination protection: checked (it is on); saving unchanged keeps it on.
    await openEdit(page, "Change termination protection");
    await expect(page.getByTestId("field-enabled")).toBeChecked();
    await saveAndClose(page, "Termination protection enabled");
    const prot = await aws<{ DisableApiTermination?: { Value?: boolean } }>("ec2", "describe-instance-attribute", "--instance-id", id, "--attribute", "disableApiTermination");
    expect(prot?.DisableApiTermination?.Value).toBe(true);

    // Metadata options: IMDSv2 optional and hop limit 3 shown and kept.
    await openEdit(page, "Modify instance metadata options");
    await expect(page.getByTestId("field-hopLimit")).toHaveValue("3");
    await saveAndClose(page, "Instance metadata options saved");
    const md = (await aws<Reservations & { Reservations?: { Instances?: { MetadataOptions?: { HttpTokens?: string; HttpPutResponseHopLimit?: number } }[] }[] }>("ec2", "describe-instances", "--instance-ids", id))?.Reservations?.[0]?.Instances?.[0] as { MetadataOptions?: { HttpTokens?: string; HttpPutResponseHopLimit?: number } };
    expect(md.MetadataOptions?.HttpTokens).toBe("optional");
    expect(md.MetadataOptions?.HttpPutResponseHopLimit).toBe(3);

    // Detailed monitoring is off, so the box is unchecked. Start is not offered on a running instance.
    await openEdit(page, "Manage detailed monitoring");
    await expect(page.getByTestId("field-enabled")).not.toBeChecked();
    await page.getByRole("button", { name: "Cancel" }).last().click();
    await page.getByRole("button", { name: "Actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Start instance" })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "Change instance type" })).toHaveCount(0);
    await page.keyboard.press("Escape");
  } finally {
    if (id) {
      await aws("ec2", "modify-instance-attribute", "--instance-id", id, "--no-disable-api-termination");
      await aws("ec2", "terminate-instances", "--instance-ids", id);
    }
  }
});

test("EC2: target group health check, load balancer attributes and Auto Scaling size are prefilled", async ({ page }) => {
  test.setTimeout(120_000);
  const tgName = uniqueName("fix-ec2-tg").slice(0, 32);
  const lbName = uniqueName("fix-ec2-lb").slice(0, 32);
  const ltName = uniqueName("fix-ec2-lt");
  const asgName = uniqueName("fix-ec2-asg");
  let tgArn = "";
  let lbArn = "";
  try {
    const vpc = (await aws<{ Vpcs?: { VpcId?: string }[] }>("ec2", "describe-vpcs", "--filters", "Name=is-default,Values=true"))?.Vpcs?.[0]?.VpcId as string;
    const subnets = (await aws<{ Subnets?: { SubnetId?: string; AvailabilityZone?: string }[] }>("ec2", "describe-subnets", "--filters", `Name=vpc-id,Values=${vpc}`))?.Subnets ?? [];
    const twoAz = [...new Map(subnets.map((s) => [s.AvailabilityZone, s.SubnetId as string])).values()].slice(0, 2);

    // Target group with non-default health check settings.
    tgArn = (await aws<{ TargetGroups?: { TargetGroupArn?: string }[] }>(
      "elbv2", "create-target-group", "--name", tgName, "--protocol", "HTTP", "--port", "80", "--vpc-id", vpc,
      "--health-check-path", "/hc", "--health-check-interval-seconds", "17", "--healthy-threshold-count", "4", "--matcher", "HttpCode=200-299", "--tags", "Key=team,Value=web"
    ))?.TargetGroups?.[0]?.TargetGroupArn as string;
    await page.goto(`/ec2/target-groups/${tgName}`);
    await openEdit(page, "Edit health check settings");
    await expect(page.getByTestId("field-path")).toHaveValue("/hc");
    await expect(page.getByTestId("field-interval")).toHaveValue("17");
    await expect(page.getByTestId("field-healthy")).toHaveValue("4");
    await expect(page.getByTestId("field-codes")).toHaveValue("200-299");
    await saveAndClose(page, "Health check settings saved");
    const tg = (await aws<{ TargetGroups?: { HealthCheckPath?: string; HealthCheckIntervalSeconds?: number; HealthyThresholdCount?: number; Matcher?: { HttpCode?: string } }[] }>("elbv2", "describe-target-groups", "--names", tgName))?.TargetGroups?.[0];
    expect([tg?.HealthCheckPath, tg?.HealthCheckIntervalSeconds, tg?.HealthyThresholdCount, tg?.Matcher?.HttpCode]).toEqual(["/hc", 17, 4, "200-299"]);
    await openEdit(page, "Manage tags");
    await expect(page.getByRole("dialog").locator('input[value="web"]')).toHaveCount(1);
    await saveAndClose(page, "No tag changes");

    // Load balancer with deletion protection on and idle timeout 120.
    lbArn = (await aws<{ LoadBalancers?: { LoadBalancerArn?: string }[] }>("elbv2", "create-load-balancer", "--name", lbName, "--type", "application", "--subnets", ...twoAz))?.LoadBalancers?.[0]?.LoadBalancerArn as string;
    await aws("elbv2", "modify-load-balancer-attributes", "--load-balancer-arn", lbArn, "--attributes", "Key=deletion_protection.enabled,Value=true", "Key=idle_timeout.timeout_seconds,Value=120");
    await page.goto(`/ec2/load-balancers/${lbName}`);
    await openEdit(page, "Edit load balancer attributes");
    await expect(page.getByTestId("field-deletionProtection")).toBeChecked();
    await expect(page.getByTestId("field-idleTimeout")).toHaveValue("120");
    await page.getByTestId("field-idleTimeout").fill("90");
    await saveAndClose(page, "idle_timeout.timeout_seconds=90");
    const attrs = (await aws<{ Attributes?: { Key?: string; Value?: string }[] }>("elbv2", "describe-load-balancer-attributes", "--load-balancer-arn", lbArn))?.Attributes ?? [];
    const attr = Object.fromEntries(attrs.map((a) => [a.Key, a.Value]));
    expect(attr["deletion_protection.enabled"]).toBe("true");
    expect(attr["idle_timeout.timeout_seconds"]).toBe("90");

    // Auto Scaling group: Edit group size shows desired 0, min 0, max 2.
    const images = await aws<{ Images?: { ImageId?: string }[] }>("ec2", "describe-images", "--owners", "amazon", "--filters", "Name=architecture,Values=x86_64");
    await aws("ec2", "create-launch-template", "--launch-template-name", ltName, "--launch-template-data", JSON.stringify({ ImageId: images?.Images?.[0]?.ImageId, InstanceType: "t3.micro" }));
    await aws("autoscaling", "create-auto-scaling-group", "--auto-scaling-group-name", asgName, "--launch-template", `LaunchTemplateName=${ltName}`, "--min-size", "0", "--max-size", "2", "--desired-capacity", "0", "--vpc-zone-identifier", twoAz[0]);
    await page.goto(`/ec2/auto-scaling-groups/${encodeURIComponent(asgName)}`);
    await openEdit(page, "Edit group size");
    await expect(page.getByTestId("field-desired")).toHaveValue("0");
    await expect(page.getByTestId("field-min")).toHaveValue("0");
    await expect(page.getByTestId("field-max")).toHaveValue("2");
    await saveAndClose(page, "Group size set");
    const g = (await aws<{ AutoScalingGroups?: { MinSize?: number; MaxSize?: number; DesiredCapacity?: number }[] }>("autoscaling", "describe-auto-scaling-groups", "--auto-scaling-group-names", asgName))?.AutoScalingGroups?.[0];
    expect([g?.DesiredCapacity, g?.MinSize, g?.MaxSize]).toEqual([0, 0, 2]);

    // Launch template: Modify template starts from the default version.
    const lt = (await aws<{ LaunchTemplates?: { LaunchTemplateId?: string }[] }>("ec2", "describe-launch-templates", "--launch-template-names", ltName))?.LaunchTemplates?.[0]?.LaunchTemplateId as string;
    await page.goto(`/ec2/launch-templates/${lt}`);
    await openEdit(page, "Modify template (Create new version)");
    await expect(page.getByTestId("field-sourceVersion")).toHaveValue("1");
    await expect(page.getByTestId("field-instanceType")).toHaveValue("t3.micro");
    await page.getByRole("button", { name: "Cancel" }).last().click();
  } finally {
    await aws("autoscaling", "delete-auto-scaling-group", "--auto-scaling-group-name", asgName, "--force-delete").catch(() => null);
    await aws("ec2", "delete-launch-template", "--launch-template-name", ltName).catch(() => null);
    if (lbArn) {
      await aws("elbv2", "modify-load-balancer-attributes", "--load-balancer-arn", lbArn, "--attributes", "Key=deletion_protection.enabled,Value=false").catch(() => null);
      await aws("elbv2", "delete-load-balancer", "--load-balancer-arn", lbArn).catch(() => null);
    }
    if (tgArn) await aws("elbv2", "delete-target-group", "--target-group-arn", tgArn).catch(() => null);
  }
});
