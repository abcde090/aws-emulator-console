import { test } from "node:test";
import assert from "node:assert/strict";
import {
  amiFamily, buildIpPermission, decodeUserData, defaultLoginUser, encodeUserData, nameTag, nextLaunchWizardName,
  parsePortRange, parseRuleSource, portRangeLabel, ruleRow, ruleTypeLabel, statusCheckSummary, tagRows, withName,
} from "../src/services/ec2/helpers.ts";
import { checkLaunchSpec, parseLaunchSpec } from "../src/services/ec2/launch-spec.ts";

test("Name tag and tag rows", () => {
  assert.equal(nameTag([{ Key: "env", Value: "x" }, { Key: "Name", Value: "web" }]), "web");
  assert.equal(nameTag(undefined), null);
  assert.deepEqual(tagRows([{ Key: "b", Value: "2" }, { Key: "a" }]), [{ Key: "a", Value: "" }, { Key: "b", Value: "2" }]);
  assert.deepEqual(withName(" web ", [{ Key: "Name", Value: "old" }, { Key: "x", Value: "1" }]), [{ Key: "Name", Value: "web" }, { Key: "x", Value: "1" }]);
  assert.deepEqual(withName("", []), []);
});

test("rule type labels match the console", () => {
  assert.equal(ruleTypeLabel("tcp", 22, 22), "SSH");
  assert.equal(ruleTypeLabel("tcp", 443, 443), "HTTPS");
  assert.equal(ruleTypeLabel("-1", -1, -1), "All traffic");
  assert.equal(ruleTypeLabel("tcp", 0, 65535), "All TCP");
  assert.equal(ruleTypeLabel("tcp", 8000, 8100), "Custom TCP");
  assert.equal(ruleTypeLabel("udp", 53, 53), "Custom UDP");
  assert.equal(ruleTypeLabel("icmp", -1, -1), "All ICMP - IPv4");
  assert.equal(portRangeLabel("tcp", 8000, 8100), "8000 - 8100");
  assert.equal(portRangeLabel("-1", undefined, undefined), "All");
});

test("port ranges and sources are validated", () => {
  assert.deepEqual(parsePortRange("22"), { from: 22, to: 22 });
  assert.deepEqual(parsePortRange("8000 - 8100"), { from: 8000, to: 8100 });
  assert.equal(parsePortRange("70000"), null);
  assert.equal(parsePortRange("90-80"), null);
  assert.equal(parsePortRange("ssh"), null);
  assert.deepEqual(parseRuleSource("0.0.0.0/0"), { kind: "ipv4", value: "0.0.0.0/0" });
  assert.deepEqual(parseRuleSource("::/0"), { kind: "ipv6", value: "::/0" });
  assert.deepEqual(parseRuleSource("sg-0abc"), { kind: "group", value: "sg-0abc" });
  assert.equal(parseRuleSource("10.0.0.0/33"), null);
  assert.equal(parseRuleSource("anywhere"), null);
});

test("buildIpPermission builds each source kind", () => {
  assert.deepEqual(buildIpPermission({ type: "ssh", source: "203.0.113.0/24", description: "office" }), {
    ok: true,
    value: { IpProtocol: "tcp", FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: "203.0.113.0/24", Description: "office" }] },
  });
  assert.deepEqual(buildIpPermission({ type: "all-traffic", source: "sg-123" }).value, { IpProtocol: "-1", UserIdGroupPairs: [{ GroupId: "sg-123", Description: undefined }] });
  assert.deepEqual(buildIpPermission({ type: "custom-tcp", ports: "8080", source: "::/0" }).value, { IpProtocol: "tcp", FromPort: 8080, ToPort: 8080, Ipv6Ranges: [{ CidrIpv6: "::/0", Description: undefined }] });
  assert.equal(buildIpPermission({ type: "custom-tcp", ports: "", source: "0.0.0.0/0" }).ok, false);
  assert.equal(buildIpPermission({ type: "nope", source: "0.0.0.0/0" }).ok, false);
  assert.equal(buildIpPermission({ type: "ssh", source: "everyone" }).ok, false);
});

test("rule rows read DescribeSecurityGroupRules output", () => {
  assert.deepEqual(ruleRow({ SecurityGroupRuleId: "sgr-1", IsEgress: false, IpProtocol: "tcp", FromPort: 22, ToPort: 22, CidrIpv4: "0.0.0.0/0", Description: "SSH" }), {
    ruleId: "sgr-1", type: "SSH", protocol: "TCP", portRange: "22", source: "0.0.0.0/0", description: "SSH",
  });
  assert.equal(ruleRow({ IpProtocol: "-1", ReferencedGroupInfo: { GroupId: "sg-9" } }).source, "sg-9");
});

test("user data round-trips through base64", () => {
  assert.equal(encodeUserData("   "), undefined);
  assert.equal(decodeUserData(encodeUserData("#!/bin/bash\necho hi")), "#!/bin/bash\necho hi");
  assert.equal(decodeUserData(undefined), null);
});

test("AMI families and login users", () => {
  assert.equal(amiFamily({ Name: "al2023-ami-2023.6-kernel-6.1-x86_64", Description: "Amazon Linux 2023 AMI" }), "Amazon Linux");
  assert.equal(amiFamily({ Name: "Windows_Server-2022-English-Full-Base", PlatformDetails: "Windows" }), "Windows");
  assert.equal(amiFamily({ Name: "ubuntu/images/hvm-ssd/ubuntu-noble-24.04" }), "Ubuntu");
  assert.equal(amiFamily({ Name: "bottlerocket-aws-ecs-2", Description: "Bottlerocket OS" }), "Other");
  assert.equal(defaultLoginUser({ Description: "Amazon Linux 2 AMI" }), "ec2-user");
  assert.equal(defaultLoginUser({ Name: "ubuntu-noble" }), "ubuntu");
  assert.equal(defaultLoginUser({ PlatformDetails: "Windows" }), null);
});

test("launch-wizard names and status checks", () => {
  assert.equal(nextLaunchWizardName(["default", "launch-wizard-1", "launch-wizard-7", "launch-wizard-x"]), "launch-wizard-8");
  assert.equal(nextLaunchWizardName([]), "launch-wizard-1");
  assert.equal(statusCheckSummary("ok", "ok"), "2/2 checks passed");
  assert.equal(statusCheckSummary("impaired", "ok", "ok"), "2/3 checks passed");
  assert.equal(statusCheckSummary("initializing", "ok"), "Initializing");
  assert.equal(statusCheckSummary(undefined, undefined), null);
});

const good = {
  name: "web", tags: [{ Key: "env", Value: "dev" }], imageId: "ami-0000000000000003d", instanceType: "t3.micro", keyName: "k", vpcId: "vpc-1", subnetId: null,
  autoAssignPublicIp: "enable", securityGroupIds: [], newSecurityGroup: { name: "launch-wizard-1", description: "d", allowSsh: true, sshSource: "0.0.0.0/0", allowHttps: false, allowHttp: true },
  volumeSize: 10, volumeType: "gp3", userData: "", count: 2, iamInstanceProfile: null, terminationProtection: false, detailedMonitoring: true,
};

test("parseLaunchSpec accepts the wizard's request", () => {
  const r = parseLaunchSpec(good);
  assert.equal(r.ok, true);
  assert.equal(r.value.count, 2);
  assert.equal(r.value.autoAssignPublicIp, "enable");
  assert.equal(r.value.newSecurityGroup.allowHttp, true);
});

test("parseLaunchSpec rejects bad input with console wording", () => {
  assert.equal(parseLaunchSpec(null).ok, false);
  assert.match(parseLaunchSpec({ ...good, imageId: "" }).error, /AMI/);
  assert.match(parseLaunchSpec({ ...good, count: 50 }).error, /Number of instances/);
  assert.match(parseLaunchSpec({ ...good, newSecurityGroup: null }).error, /security group/);
  assert.match(parseLaunchSpec({ ...good, newSecurityGroup: { ...good.newSecurityGroup, name: "sg-bad" } }).error, /Security group name/);
  assert.match(parseLaunchSpec({ ...good, newSecurityGroup: { ...good.newSecurityGroup, sshSource: "me" } }).error, /SSH source/);
  assert.match(parseLaunchSpec({ ...good, volumeType: "ssd" }).error, /volume type/);
  assert.match(parseLaunchSpec({ ...good, tags: [{ Key: 1 }] }).error, /tag/);
  assert.equal(parseLaunchSpec({ ...good, autoAssignPublicIp: "maybe" }).value.autoAssignPublicIp, "default");
  assert.equal(checkLaunchSpec({ ...good, securityGroupIds: ["sg-1;rm"], newSecurityGroup: null }), "A selected security group is not valid.");
});

test("state helpers and SSH hint", async () => {
  const { rowState, stateIn, sshHint } = await import("../src/services/ec2/helpers.ts");
  assert.equal(rowState({ state: "running" }), "running");
  assert.equal(rowState({ "Instance state": "stopped" }), "stopped");
  assert.equal(stateIn({}, ["stopped"]), true);
  assert.equal(stateIn({ state: "running" }, ["stopped"]), false);
  assert.match(sshHint("1.2.3.4", "k", "ec2-user"), /ssh -i "k.pem" ec2-user@1.2.3.4/);
  assert.match(sshHint("1.2.3.4", null, null), /without a key pair/);
  assert.match(sshHint(null, "k", null), /no public IPv4/);
});
