/**
 * Amazon VPC: the VPC console's left nav, from the dashboard to Site-to-Site VPN. Every
 * value comes from an EC2 API response; every control calls an EC2 API.
 */

import { DescribeFlowLogsCommand, DescribeTransitGatewayRouteTablesCommand, DescribeVpcEndpointsCommand, DescribeVpnConnectionsCommand } from "@aws-sdk/client-ec2";
import type { Ctx, ResourceDef, Row, ServiceDef } from "../../console/types.ts";
import { errorMessage } from "../../console/serialize.ts";
import {
  describeAcls,
  describeAddresses,
  describeCgws,
  describeDhcp,
  describeEgressIgws,
  describeIgws,
  describeNats,
  describePeerings,
  describeRouteTables,
  describeSecurityGroups,
  describeSubnets,
  describeTgwAttachments,
  describeTgws,
  describeVgws,
  describeVpcs,
} from "./ec2.ts";
import { endpoints, peeringConnections } from "./endpoints.ts";
import { networkAcls, securityGroups } from "./firewalls.ts";
import { flowLogs } from "./flow-logs.ts";
import { dhcpOptionSets, egressOnlyGateways, elasticIps, internetGateways, natGateways } from "./gateways.ts";
import { routeTables } from "./route-tables.ts";
import { subnets } from "./subnets.ts";
import { tgwAttachments, tgwRouteTables, transitGateways } from "./tgw.ts";
import { vpcs } from "./vpcs.ts";
import { customerGateways, virtualPrivateGateways, vpnConnections } from "./vpn.ts";

const live = <T extends { State?: string }>(items: T[]): T[] => items.filter((i) => i.State !== "deleted");

const COUNTS: { path: string; label: string; group: string; count: (ctx: Ctx) => Promise<number> }[] = [
  { path: "vpcs", label: "VPCs", group: "Virtual private cloud", count: async (c) => (await describeVpcs(c)).length },
  { path: "subnets", label: "Subnets", group: "Virtual private cloud", count: async (c) => (await describeSubnets(c)).length },
  { path: "route-tables", label: "Route tables", group: "Virtual private cloud", count: async (c) => (await describeRouteTables(c)).length },
  { path: "internet-gateways", label: "Internet gateways", group: "Virtual private cloud", count: async (c) => (await describeIgws(c)).length },
  { path: "egress-only-internet-gateways", label: "Egress-only internet gateways", group: "Virtual private cloud", count: async (c) => (await describeEgressIgws(c)).length },
  { path: "dhcp-option-sets", label: "DHCP option sets", group: "Virtual private cloud", count: async (c) => (await describeDhcp(c)).length },
  { path: "elastic-ips", label: "Elastic IPs", group: "Virtual private cloud", count: async (c) => (await describeAddresses(c)).length },
  { path: "endpoints", label: "Endpoints", group: "Virtual private cloud", count: async (c) => live((await c.clients.ec2.send(new DescribeVpcEndpointsCommand({}))).VpcEndpoints ?? []).length },
  { path: "nat-gateways", label: "NAT gateways", group: "Virtual private cloud", count: async (c) => live(await describeNats(c)).length },
  { path: "peering-connections", label: "Peering connections", group: "Virtual private cloud", count: async (c) => (await describePeerings(c)).filter((p) => p.Status?.Code !== "deleted").length },
  { path: "network-acls", label: "Network ACLs", group: "Security", count: async (c) => (await describeAcls(c)).length },
  { path: "security-groups", label: "Security groups", group: "Security", count: async (c) => (await describeSecurityGroups(c)).length },
  { path: "flow-logs", label: "Flow logs", group: "Security", count: async (c) => ((await c.clients.ec2.send(new DescribeFlowLogsCommand({}))).FlowLogs ?? []).length },
  { path: "customer-gateways", label: "Customer gateways", group: "Virtual private network (VPN)", count: async (c) => live(await describeCgws(c)).length },
  { path: "virtual-private-gateways", label: "Virtual private gateways", group: "Virtual private network (VPN)", count: async (c) => live(await describeVgws(c)).length },
  { path: "vpn-connections", label: "Site-to-Site VPN connections", group: "Virtual private network (VPN)", count: async (c) => live((await c.clients.ec2.send(new DescribeVpnConnectionsCommand({}))).VpnConnections ?? []).length },
  { path: "transit-gateways", label: "Transit gateways", group: "Transit gateways", count: async (c) => live(await describeTgws(c)).length },
  { path: "transit-gateway-attachments", label: "Transit gateway attachments", group: "Transit gateways", count: async (c) => live(await describeTgwAttachments(c)).length },
  { path: "transit-gateway-route-tables", label: "Transit gateway route tables", group: "Transit gateways", count: async (c) => live((await c.clients.ec2.send(new DescribeTransitGatewayRouteTablesCommand({}))).TransitGatewayRouteTables ?? []).length },
];

const dashboard: ResourceDef = {
  id: "dashboard",
  name: "VPC dashboard",
  singular: "resource type",
  idField: "path",
  description: "Resources by Region: what you have in US East (N. Virginia). Deleted resources are not counted.",
  emptyText: "No resource counts could be loaded.",
  columns: [
    { key: "resource", label: "Resource", kind: "link" },
    { key: "count", label: "Count", kind: "count" },
    { key: "group", label: "Section", kind: "text" },
    { key: "region", label: "Region", kind: "text" },
    { key: "error", label: "Error", kind: "text" },
  ],
  async list(ctx) {
    return Promise.all(
      COUNTS.map(async (c): Promise<Row> => {
        try {
          return { path: c.path, resource: c.label, count: await c.count(ctx), group: c.group, region: ctx.region, error: null };
        } catch (err: unknown) {
          return { path: c.path, resource: c.label, count: null, group: c.group, region: ctx.region, error: errorMessage(err) };
        }
      })
    );
  },
  detailHref: "{id}",
};

export const vpcService: ServiceDef = {
  id: "vpc",
  name: "VPC",
  category: "Networking & Content Delivery",
  description: "Isolated cloud resources: VPCs, subnets, route tables, gateways, endpoints, peering, transit gateways, network ACLs, security groups, flow logs and Site-to-Site VPN.",
  resources: [
    dashboard,
    vpcs,
    subnets,
    routeTables,
    internetGateways,
    egressOnlyGateways,
    dhcpOptionSets,
    elasticIps,
    endpoints,
    natGateways,
    peeringConnections,
    networkAcls,
    securityGroups,
    flowLogs,
    customerGateways,
    virtualPrivateGateways,
    vpnConnections,
    transitGateways,
    tgwAttachments,
    tgwRouteTables,
  ],
  notSupported: [
    "Editing peering connection DNS settings (ModifyVpcPeeringConnectionOptions)",
    "Removing a secondary VPC CIDR (DisassociateVpcCidrBlock)",
    "Route propagation from a virtual private gateway (EnableVgwRoutePropagation / DisableVgwRoutePropagation)",
    "Deleting a transit gateway route table association (DisassociateTransitGatewayRouteTable)",
    "Deleting a transit gateway static route (DeleteTransitGatewayRoute)",
  ],
};
