import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aclProtocolNumber,
  aclRuleKey,
  defaultSubnetPrefix,
  destinationParam,
  ipToInt,
  intToIp,
  nameOf,
  parseAclRuleKey,
  parseCidr,
  parsePortRange,
  portRangeLabel,
  protocolLabel,
  routeDestination,
  routeTarget,
  ruleTypeToPorts,
  splitList,
  subnetCidrs,
  targetParam,
  withName,
} from "../src/services/vpc/helpers.ts";

test("VPC: CIDR maths", () => {
  assert.equal(ipToInt("10.0.0.0"), 167772160);
  assert.equal(intToIp(167772160), "10.0.0.0");
  assert.equal(ipToInt("10.0.0.256"), null);
  assert.deepEqual(parseCidr("10.0.0.0/16"), { base: 167772160, prefix: 16 });
  assert.equal(parseCidr("10.0.1.0/16"), null, "host bits set");
  assert.equal(parseCidr("10.0.0.0/33"), null);
  assert.equal(parseCidr("nope"), null);
  assert.equal(defaultSubnetPrefix(16), 20);
  assert.equal(defaultSubnetPrefix(26), 28);
  assert.deepEqual(subnetCidrs("10.0.0.0/16", 3, 20), ["10.0.0.0/20", "10.0.16.0/20", "10.0.32.0/20"]);
  assert.throws(() => subnetCidrs("10.0.0.0/24", 17, 28), /room for only 16/);
  assert.throws(() => subnetCidrs("bad", 1, 20), /not a valid/);
});

test("VPC: route destinations and targets", () => {
  assert.deepEqual(destinationParam("0.0.0.0/0"), { DestinationCidrBlock: "0.0.0.0/0" });
  assert.deepEqual(destinationParam("::/0"), { DestinationIpv6CidrBlock: "::/0" });
  assert.deepEqual(destinationParam("pl-63a5400a"), { DestinationPrefixListId: "pl-63a5400a" });
  assert.deepEqual(targetParam("igw-1"), { GatewayId: "igw-1" });
  assert.deepEqual(targetParam("vgw-1"), { GatewayId: "vgw-1" });
  assert.deepEqual(targetParam("nat-1"), { NatGatewayId: "nat-1" });
  assert.deepEqual(targetParam("tgw-1"), { TransitGatewayId: "tgw-1" });
  assert.deepEqual(targetParam("pcx-1"), { VpcPeeringConnectionId: "pcx-1" });
  assert.deepEqual(targetParam("eigw-1"), { EgressOnlyInternetGatewayId: "eigw-1" });
  assert.deepEqual(targetParam("eni-1"), { NetworkInterfaceId: "eni-1" });
  assert.throws(() => targetParam("xyz"), /not a route target/);
  assert.equal(routeDestination({ DestinationPrefixListId: "pl-1" }), "pl-1");
  assert.equal(routeTarget({ GatewayId: "local" }), "local");
  assert.equal(routeTarget({ NatGatewayId: "nat-1" }), "nat-1");
  assert.equal(routeTarget({}), "");
});

test("VPC: rules", () => {
  assert.equal(protocolLabel("-1"), "All");
  assert.equal(protocolLabel("6"), "TCP");
  assert.equal(protocolLabel("tcp"), "TCP");
  assert.equal(protocolLabel("47"), "47");
  assert.equal(portRangeLabel("-1", undefined, undefined), "All");
  assert.equal(portRangeLabel("tcp", 22, 22), "22");
  assert.equal(portRangeLabel("6", 1024, 65535), "1024 - 65535");
  assert.equal(portRangeLabel("tcp", 0, 65535), "All");
  assert.equal(portRangeLabel("icmp", -1, -1), "All");
  assert.deepEqual(parsePortRange("80"), { from: 80, to: 80 });
  assert.deepEqual(parsePortRange("1024 - 2048"), { from: 1024, to: 2048 });
  assert.equal(parsePortRange("90-80"), null);
  assert.equal(parsePortRange("70000"), null);
  assert.deepEqual(ruleTypeToPorts("ssh", ""), { protocol: "tcp", from: 22, to: 22 });
  assert.deepEqual(ruleTypeToPorts("custom-udp", "53"), { protocol: "udp", from: 53, to: 53 });
  assert.throws(() => ruleTypeToPorts("custom-tcp", ""), /port/);
  assert.throws(() => ruleTypeToPorts("nope", ""), /Unknown/);
  assert.equal(aclProtocolNumber("tcp"), "6");
  assert.equal(aclProtocolNumber("-1"), "-1");
  assert.equal(aclRuleKey(true, 100), "outbound:100");
  assert.deepEqual(parseAclRuleKey("inbound:120"), { egress: false, ruleNumber: 120 });
  assert.equal(parseAclRuleKey("sideways:1"), null);
});

test("VPC: tags and lists", () => {
  assert.equal(nameOf([{ Key: "Name", Value: "web" }]), "web");
  assert.equal(nameOf(undefined), null);
  assert.deepEqual(withName("a", [{ Key: "Name", Value: "b" }, { Key: "env", Value: "dev" }]), [{ Key: "Name", Value: "a" }, { Key: "env", Value: "dev" }]);
  assert.deepEqual(withName("", [{ Key: "env", Value: "dev" }]), [{ Key: "env", Value: "dev" }]);
  assert.deepEqual(withName(null, null), []);
  assert.deepEqual(splitList("a, b\nc"), ["a", "b", "c"]);
  assert.deepEqual(splitList(5), []);
});

