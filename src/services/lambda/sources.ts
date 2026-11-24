/** Live options shared by the Lambda resources: roles, functions, layers and event sources. */

import { AttachRolePolicyCommand, CreateRoleCommand, ListRolesCommand } from "@aws-sdk/client-iam";
import {
  ListAliasesCommand,
  ListEventSourceMappingsCommand,
  ListFunctionsCommand,
  ListLayersCommand,
  ListLayerVersionsCommand,
  ListProvisionedConcurrencyConfigsCommand,
  ListVersionsByFunctionCommand,
  type AliasConfiguration,
  type EventSourceMappingConfiguration,
  type FunctionConfiguration,
  type LayersListItem,
  type LayerVersionsListItem,
  type ProvisionedConcurrencyConfigListItem,
} from "@aws-sdk/client-lambda";
import { GetQueueAttributesCommand, ListQueuesCommand } from "@aws-sdk/client-sqs";
import { ListStreamsCommand, type ListStreamsCommandOutput } from "@aws-sdk/client-kinesis";
import { DescribeTableCommand, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import type { Ctx, Option } from "../../console/types.ts";

export async function allFunctions(ctx: Ctx): Promise<FunctionConfiguration[]> {
  const out: FunctionConfiguration[] = [];
  let marker: string | undefined;
  do {
    const r = await ctx.clients.lambda.send(new ListFunctionsCommand({ Marker: marker, MaxItems: 50 }));
    out.push(...(r.Functions ?? []));
    marker = r.NextMarker;
  } while (marker);
  return out;
}

export async function functionOptions(ctx: Ctx): Promise<Option[]> {
  return (await allFunctions(ctx)).filter((f) => f.FunctionName).map((f) => ({ value: f.FunctionName as string, label: `${f.FunctionName} (${f.Runtime ?? f.PackageType ?? ""})` }));
}

export async function roleOptions(ctx: Ctx): Promise<Option[]> {
  const out: Option[] = [];
  let marker: string | undefined;
  do {
    const r = await ctx.clients.iam.send(new ListRolesCommand({ Marker: marker, MaxItems: 1000 }));
    for (const role of r.Roles ?? []) if (role.Arn && role.RoleName) out.push({ value: role.Arn, label: role.RoleName });
    marker = r.IsTruncated ? r.Marker : undefined;
  } while (marker);
  return out;
}

const TRUST = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] });

/** "Create a new role with basic Lambda permissions": a role Lambda can assume, with CloudWatch Logs access. */
export async function createBasicRole(ctx: Ctx, functionName: string): Promise<string> {
  const roleName = `${functionName}-role-${Date.now().toString(36)}`.slice(0, 64);
  const r = await ctx.clients.iam.send(new CreateRoleCommand({ RoleName: roleName, Path: "/service-role/", AssumeRolePolicyDocument: TRUST, Description: `Execution role for Lambda function ${functionName}` }));
  if (!r.Role?.Arn) throw new Error("CreateRole returned no ARN.");
  await ctx.clients.iam.send(new AttachRolePolicyCommand({ RoleName: roleName, PolicyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole" }));
  return r.Role.Arn;
}

export async function allLayers(ctx: Ctx): Promise<LayersListItem[]> {
  const out: LayersListItem[] = [];
  let marker: string | undefined;
  do {
    const r = await ctx.clients.lambda.send(new ListLayersCommand({ Marker: marker }));
    out.push(...(r.Layers ?? []));
    marker = r.NextMarker;
  } while (marker);
  return out;
}

export async function allLayerVersions(ctx: Ctx, layerName: string): Promise<LayerVersionsListItem[]> {
  const out: LayerVersionsListItem[] = [];
  let marker: string | undefined;
  do {
    const r = await ctx.clients.lambda.send(new ListLayerVersionsCommand({ LayerName: layerName, Marker: marker }));
    out.push(...(r.LayerVersions ?? []));
    marker = r.NextMarker;
  } while (marker);
  return out;
}

export async function allVersions(ctx: Ctx, functionName: string): Promise<FunctionConfiguration[]> {
  const out: FunctionConfiguration[] = [];
  let marker: string | undefined;
  do {
    const r = await ctx.clients.lambda.send(new ListVersionsByFunctionCommand({ FunctionName: functionName, Marker: marker }));
    out.push(...(r.Versions ?? []));
    marker = r.NextMarker;
  } while (marker);
  return out;
}

export async function allAliases(ctx: Ctx, functionName: string): Promise<AliasConfiguration[]> {
  const out: AliasConfiguration[] = [];
  let marker: string | undefined;
  do {
    const r = await ctx.clients.lambda.send(new ListAliasesCommand({ FunctionName: functionName, Marker: marker }));
    out.push(...(r.Aliases ?? []));
    marker = r.NextMarker;
  } while (marker);
  return out;
}

/** Event source mappings, of one function or (no name) of the whole Region. */
export async function allMappings(ctx: Ctx, functionName?: string): Promise<EventSourceMappingConfiguration[]> {
  const out: EventSourceMappingConfiguration[] = [];
  let marker: string | undefined;
  do {
    const r = await ctx.clients.lambda.send(new ListEventSourceMappingsCommand({ FunctionName: functionName, Marker: marker }));
    out.push(...(r.EventSourceMappings ?? []));
    marker = r.NextMarker;
  } while (marker);
  return out;
}

export async function allProvisioned(ctx: Ctx, functionName: string): Promise<ProvisionedConcurrencyConfigListItem[]> {
  const out: ProvisionedConcurrencyConfigListItem[] = [];
  let marker: string | undefined;
  do {
    const r = await ctx.clients.lambda.send(new ListProvisionedConcurrencyConfigsCommand({ FunctionName: functionName, Marker: marker }));
    out.push(...(r.ProvisionedConcurrencyConfigs ?? []));
    marker = r.NextMarker;
  } while (marker);
  return out;
}

export async function layerVersionOptions(ctx: Ctx): Promise<Option[]> {
  const out: Option[] = [];
  for (const l of await allLayers(ctx)) {
    if (!l.LayerName) continue;
    for (const v of await allLayerVersions(ctx, l.LayerName)) if (v.LayerVersionArn) out.push({ value: v.LayerVersionArn, label: `${l.LayerName}:${v.Version}${v.Description ? ` (${v.Description})` : ""}` });
  }
  return out;
}

/** Published versions and aliases of a function (provisioned concurrency can't go on $LATEST). */
export async function qualifierOptions(ctx: Ctx, functionName?: string): Promise<Option[]> {
  if (!functionName) return [];
  const [versions, aliases] = await Promise.all([allVersions(ctx, functionName), allAliases(ctx, functionName)]);
  return [
    ...aliases.filter((a) => a.Name).map((a) => ({ value: a.Name as string, label: `Alias: ${a.Name} (version ${a.FunctionVersion ?? "?"})` })),
    ...versions.filter((v) => v.Version && v.Version !== "$LATEST").map((v) => ({ value: v.Version as string, label: `Version ${v.Version}${v.Description ? ` (${v.Description})` : ""}` })),
  ];
}

/** $LATEST plus the function's published versions: what an alias can point to. */
export async function versionOptions(ctx: Ctx, functionName?: string): Promise<Option[]> {
  if (!functionName) return [{ value: "$LATEST", label: "$LATEST" }];
  const versions = await allVersions(ctx, functionName);
  return [{ value: "$LATEST", label: "$LATEST" }, ...versions.filter((v) => v.Version && v.Version !== "$LATEST").map((v) => ({ value: v.Version as string, label: `Version ${v.Version}${v.Description ? ` (${v.Description})` : ""}` }))];
}

/** SQS queues, Kinesis streams and DynamoDB tables with streams: the sources an event source mapping can poll. */
export async function eventSourceOptions(ctx: Ctx): Promise<Option[]> {
  const out: Option[] = [];
  let next: string | undefined;
  const queues: string[] = [];
  do {
    const r = await ctx.clients.sqs.send(new ListQueuesCommand({ MaxResults: 1000, NextToken: next }));
    queues.push(...(r.QueueUrls ?? []));
    next = r.NextToken;
  } while (next);
  for (const url of queues) {
    const arn = (await ctx.clients.sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ["QueueArn"] }))).Attributes?.QueueArn;
    if (arn) out.push({ value: arn, label: `SQS: ${arn.split(":").pop()}` });
  }
  next = undefined;
  do {
    const r: ListStreamsCommandOutput = await ctx.clients.kinesis.send(new ListStreamsCommand({ NextToken: next }));
    for (const s of r.StreamSummaries ?? []) if (s.StreamARN) out.push({ value: s.StreamARN, label: `Kinesis: ${s.StreamName}` });
    next = r.HasMoreStreams ? r.NextToken : undefined;
  } while (next);
  const tables: string[] = [];
  let start: string | undefined;
  do {
    const r = await ctx.clients.dynamodb.send(new ListTablesCommand({ ExclusiveStartTableName: start }));
    tables.push(...(r.TableNames ?? []));
    start = r.LastEvaluatedTableName;
  } while (start);
  for (const t of tables) {
    const d = (await ctx.clients.dynamodb.send(new DescribeTableCommand({ TableName: t }))).Table;
    if (d?.LatestStreamArn) out.push({ value: d.LatestStreamArn, label: `DynamoDB: ${t} stream` });
  }
  return out;
}

export function isStreamSource(arn: string): boolean {
  return arn.startsWith("arn:aws:kinesis:") || arn.includes(":dynamodb:");
}
