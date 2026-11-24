import { expect, test } from "@playwright/test";
import { aws, uniqueName } from "./aws-cli";

interface Tagged {
  Tags?: { Key: string; Value: string }[];
}

async function vpcIdsNamed(name: string): Promise<string[]> {
  const r = await aws<{ Vpcs: ({ VpcId: string } & Tagged)[] }>("ec2", "describe-vpcs", "--filters", `Name=tag:Name,Values=${name}`);
  return (r?.Vpcs ?? []).map((v) => v.VpcId);
}

/** Removes a VPC and what "VPC and more" put in it, using the CLI (cleanup after a failed run). */
async function cleanupVpc(vpcId: string): Promise<void> {
  const f = ["--filters", `Name=vpc-id,Values=${vpcId}`];
  const safe = async (...args: string[]) => {
    try {
      await aws(...args);
    } catch {
      // best effort
    }
  };
  const eps = await aws<{ VpcEndpoints: { VpcEndpointId: string }[] }>("ec2", "describe-vpc-endpoints", ...f);
  for (const e of eps?.VpcEndpoints ?? []) await safe("ec2", "delete-vpc-endpoints", "--vpc-endpoint-ids", e.VpcEndpointId);
  const igws = await aws<{ InternetGateways: { InternetGatewayId: string }[] }>("ec2", "describe-internet-gateways", "--filters", `Name=attachment.vpc-id,Values=${vpcId}`);
  for (const g of igws?.InternetGateways ?? []) {
    await safe("ec2", "detach-internet-gateway", "--internet-gateway-id", g.InternetGatewayId, "--vpc-id", vpcId);
    await safe("ec2", "delete-internet-gateway", "--internet-gateway-id", g.InternetGatewayId);
  }
  const rts = await aws<{ RouteTables: { RouteTableId: string; Associations?: { Main?: boolean; RouteTableAssociationId?: string }[] }[] }>("ec2", "describe-route-tables", ...f);
  for (const t of rts?.RouteTables ?? []) {
    if (t.Associations?.some((a) => a.Main)) continue;
    for (const a of t.Associations ?? []) if (a.RouteTableAssociationId) await safe("ec2", "disassociate-route-table", "--association-id", a.RouteTableAssociationId);
    await safe("ec2", "delete-route-table", "--route-table-id", t.RouteTableId);
  }
  const subnets = await aws<{ Subnets: { SubnetId: string }[] }>("ec2", "describe-subnets", ...f);
  for (const s of subnets?.Subnets ?? []) await safe("ec2", "delete-subnet", "--subnet-id", s.SubnetId);
  const sgs = await aws<{ SecurityGroups: { GroupId: string; GroupName: string }[] }>("ec2", "describe-security-groups", ...f);
  for (const g of sgs?.SecurityGroups ?? []) if (g.GroupName !== "default") await safe("ec2", "delete-security-group", "--group-id", g.GroupId);
  await safe("ec2", "delete-vpc", "--vpc-id", vpcId);
}

test("VPC: create with VPC and more, edit settings, delete with its resources", async ({ page }) => {
  test.setTimeout(180_000);
  const prefix = uniqueName("e2e-vpc");
  try {
    await page.goto("/vpc/vpcs");
    await expect(page.getByRole("heading", { name: /^Your VPCs/ })).toBeVisible();
    await page.getByRole("link", { name: "Create VPC" }).first().click();
    await expect(page.getByTestId("create-form")).toBeVisible();
    await page.getByRole("radio", { name: "VPC and more" }).check();
    await page.getByLabel(/^Name tag/).fill(prefix);
    await page.getByLabel("IPv4 CIDR", { exact: true }).fill("10.123.0.0/16");
    await expect(page.getByRole("radiogroup", { name: "Number of Availability Zones (AZs)" })).toBeVisible();
    await page.getByRole("button", { name: "Create VPC" }).click();

    await expect(page).toHaveURL(/\/vpc\/vpcs\/vpc-/, { timeout: 30_000 });
    await expect(page.getByTestId("flash")).toContainText("Created VPC");
    await expect(page.getByTestId("kv-IPv4 CIDR")).toHaveText("10.123.0.0/16");
    await expect(page.getByTestId("kv-DNS hostnames")).toHaveText("Enabled");

    const [vpcId] = await vpcIdsNamed(`${prefix}-vpc`);
    expect(vpcId).toBeTruthy();
    const subnets = await aws<{ Subnets: Tagged[] }>("ec2", "describe-subnets", "--filters", `Name=vpc-id,Values=${vpcId}`);
    expect(subnets?.Subnets).toHaveLength(4);
    const names = (subnets?.Subnets ?? []).map((s) => s.Tags?.find((t) => t.Key === "Name")?.Value ?? "");
    expect(names.some((n) => n.startsWith(`${prefix}-subnet-public1-`))).toBe(true);
    const eps = await aws<{ VpcEndpoints: { ServiceName: string }[] }>("ec2", "describe-vpc-endpoints", "--filters", `Name=vpc-id,Values=${vpcId}`);
    expect(eps?.VpcEndpoints.map((e) => e.ServiceName)).toContain("com.amazonaws.us-east-1.s3");

    // Resource map shows the public route to the internet gateway.
    await page.getByRole("tab", { name: "Resource map" }).click();
    await expect(page.getByText(/0\.0\.0\.0\/0 → igw-/).first()).toBeVisible();

    // Action: turn DNS hostnames off.
    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Edit VPC settings" }).click();
    await expect(page.getByTestId("field-dnsHostnames")).toBeChecked();
    await page.getByTestId("field-dnsHostnames").uncheck();
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("DNS hostnames disabled");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    await expect(page.getByTestId("kv-DNS hostnames")).toHaveText("Disabled");
    const attr = await aws<{ EnableDnsHostnames: { Value: boolean } }>("ec2", "describe-vpc-attribute", "--vpc-id", vpcId, "--attribute", "enableDnsHostnames");
    expect(attr?.EnableDnsHostnames.Value).toBe(false);

    // Listed, then deleted from the list together with its subnets, gateway and route tables.
    await page.goto("/vpc/vpcs");
    const row = page.getByTestId("resource-table").getByRole("row", { name: new RegExp(vpcId) });
    await expect(row).toBeVisible();
    await row.getByRole("radio").check();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill("delete");
    await page.getByTestId("confirm-delete").click();
    await expect(page.getByTestId("flash")).toContainText(`Deleted VPC ${vpcId}`, { timeout: 30_000 });
    expect(await vpcIdsNamed(`${prefix}-vpc`)).toHaveLength(0);
    const left = await aws<{ Subnets: unknown[] }>("ec2", "describe-subnets", "--filters", `Name=vpc-id,Values=${vpcId}`);
    expect(left?.Subnets ?? []).toHaveLength(0);
  } finally {
    for (const id of await vpcIdsNamed(`${prefix}-vpc`)) await cleanupVpc(id);
  }
});

test("VPC: security group with an inbound rule", async ({ page }) => {
  const name = uniqueName("e2e-vpc-sg");
  const vpc = await aws<{ Vpc: { VpcId: string } }>("ec2", "create-vpc", "--cidr-block", "10.124.0.0/16", "--tag-specifications", `ResourceType=vpc,Tags=[{Key=Name,Value=${name}}]`);
  const vpcId = vpc?.Vpc.VpcId ?? "";
  try {
    await page.goto("/vpc/security-groups/create");
    await page.getByLabel("Security group name").fill(name);
    await page.getByLabel("Description", { exact: true }).fill("e2e test group");
    await page.getByLabel("VPC", { exact: true }).selectOption({ value: vpcId });
    await page.getByRole("button", { name: "Create security group" }).click();
    await expect(page).toHaveURL(/\/vpc\/security-groups\/sg-/);
    await expect(page.getByTestId("kv-Security group name")).toHaveText(name);
    const groupId = decodeURIComponent(new URL(page.url()).pathname.split("/").pop() ?? "");

    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Add inbound rule" }).click();
    await page.getByLabel("Type", { exact: true }).selectOption("https");
    await page.getByLabel("Source CIDR").fill("10.0.0.0/8");
    await page.getByTestId("action-submit").click();
    await expect(page.getByRole("dialog").getByTestId("flash")).toContainText("Added inbound rule");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    await page.getByRole("tab", { name: "Inbound rules" }).click();
    await expect(page.getByText("HTTPS (443)")).toBeVisible();
    const rules = await aws<{ SecurityGroupRules: { IsEgress: boolean; FromPort: number; CidrIpv4?: string }[] }>("ec2", "describe-security-group-rules", "--filters", `Name=group-id,Values=${groupId}`);
    expect(rules?.SecurityGroupRules.some((r) => !r.IsEgress && r.FromPort === 443 && r.CidrIpv4 === "10.0.0.0/8")).toBe(true);

    await page.goto("/vpc/security-groups");
    const row = page.getByTestId("resource-table").getByRole("row", { name: new RegExp(groupId) });
    await row.getByRole("radio").check();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByLabel("Confirm deletion").fill("delete");
    await page.getByTestId("confirm-delete").click();
    await expect(page.getByTestId("flash")).toContainText(`Deleted security group ${groupId}`);
    const after = await aws<{ SecurityGroups: unknown[] }>("ec2", "describe-security-groups", "--filters", `Name=group-name,Values=${name}`);
    expect(after?.SecurityGroups ?? []).toHaveLength(0);
  } finally {
    await cleanupVpc(vpcId);
  }
});

test("VPC: edit dialogs open on the current values and an unchanged save changes nothing", async ({ page }) => {
  test.setTimeout(120_000);
  const name = uniqueName("fix-vpc");
  const vpc = await aws<{ Vpc: { VpcId: string } }>("ec2", "create-vpc", "--cidr-block", "10.125.0.0/16", "--tag-specifications", `ResourceType=vpc,Tags=[{Key=Name,Value=${name}}]`);
  const vpcId = vpc?.Vpc.VpcId ?? "";
  try {
    // Non-default values: DNS hostnames on; a private subnet with two tags.
    await aws("ec2", "modify-vpc-attribute", "--vpc-id", vpcId, "--enable-dns-hostnames", '{"Value":true}');
    const subnet = await aws<{ Subnet: { SubnetId: string } }>("ec2", "create-subnet", "--vpc-id", vpcId, "--cidr-block", "10.125.1.0/24", "--tag-specifications", `ResourceType=subnet,Tags=[{Key=Name,Value=${name}-sub},{Key=env,Value=dev}]`);
    const subnetId = subnet?.Subnet.SubnetId ?? "";
    const describeSubnet = async () => (await aws<{ Subnets: { MapPublicIpOnLaunch: boolean; Tags?: { Key: string; Value: string }[] }[] }>("ec2", "describe-subnets", "--subnet-ids", subnetId))?.Subnets[0];
    const explicitAssociations = async () =>
      ((await aws<{ RouteTables: { Associations?: { SubnetId?: string }[] }[] }>("ec2", "describe-route-tables", "--filters", `Name=association.subnet-id,Values=${subnetId}`))?.RouteTables ?? []).length;

    const openAction = async (label: string) => {
      await page.getByRole("button", { name: "Actions" }).click();
      await page.getByRole("menuitem", { name: label, exact: true }).click();
      await expect(page.getByTestId("action-submit")).toBeEnabled();
    };
    const submitAndClose = async (text: RegExp | string) => {
      await page.getByTestId("action-submit").click();
      await expect(page.getByRole("dialog").getByTestId("flash")).toContainText(text);
      await page.getByRole("button", { name: "Close", exact: true }).last().click();
    };

    // Subnet: auto-assign public IPv4 is off, so the dialog shows it off and saving keeps it off.
    await page.goto(`/vpc/subnets/${subnetId}`);
    await expect(page.getByTestId("kv-Auto-assign public IPv4 address")).toHaveText("No");
    await openAction("Edit subnet settings");
    await expect(page.getByTestId("field-publicIp")).not.toBeChecked();
    await submitAndClose("No change");
    expect((await describeSubnet())?.MapPublicIpOnLaunch).toBe(false);

    // Route table association: the main table is preselected; saving doesn't create an explicit association.
    await openAction("Edit route table association");
    const mainRtb = ((await aws<{ RouteTables: { RouteTableId: string }[] }>("ec2", "describe-route-tables", "--filters", `Name=vpc-id,Values=${vpcId}`, "Name=association.main,Values=true"))?.RouteTables ?? [])[0]?.RouteTableId;
    await expect(page.getByTestId("field-routeTableId")).toHaveValue(mainRtb ?? "");
    await submitAndClose("No change");
    expect(await explicitAssociations()).toBe(0);

    // Manage tags: the existing tags are listed; saving unchanged keeps them.
    await openAction("Manage tags");
    await expect(page.getByLabel("Tags key 2")).toHaveValue("env");
    await expect(page.getByLabel("Tags value 2")).toHaveValue("dev");
    await submitAndClose("No tag changes");
    const tags = (await describeSubnet())?.Tags ?? [];
    expect(tags.find((t) => t.Key === "env")?.Value).toBe("dev");
    expect(tags.find((t) => t.Key === "Name")?.Value).toBe(`${name}-sub`);

    // VPC settings: DNS hostnames on, DNS resolution on, default DHCP set as it is.
    await page.goto(`/vpc/vpcs/${vpcId}`);
    await openAction("Edit VPC settings");
    await expect(page.getByTestId("field-dnsHostnames")).toBeChecked();
    await expect(page.getByTestId("field-dnsSupport")).toBeChecked();
    const dhcpBefore = (await aws<{ Vpcs: { DhcpOptionsId?: string }[] }>("ec2", "describe-vpcs", "--vpc-ids", vpcId))?.Vpcs[0]?.DhcpOptionsId || "default";
    await expect(page.getByTestId("field-dhcp")).toHaveValue(dhcpBefore);
    await expect(page.getByTestId("field-dhcp").locator("option", { hasText: "Keep current" })).toHaveCount(0);
    await submitAndClose("No changes");
    const hostnames = await aws<{ EnableDnsHostnames: { Value: boolean } }>("ec2", "describe-vpc-attribute", "--vpc-id", vpcId, "--attribute", "enableDnsHostnames");
    expect(hostnames?.EnableDnsHostnames.Value).toBe(true);
    expect((await aws<{ Vpcs: { DhcpOptionsId?: string }[] }>("ec2", "describe-vpcs", "--vpc-ids", vpcId))?.Vpcs[0]?.DhcpOptionsId || "default").toBe(dhcpBefore);
  } finally {
    await cleanupVpc(vpcId);
  }
});
