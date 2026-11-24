"use server";

/**
 * Server actions for the hand-built HTTP and WebSocket API screen (routes, integrations,
 * stages, deploy). Every call uses the permission-checked apigatewayv2 and lambda clients;
 * every form is validated against its field spec in forms.ts.
 */

import {
  CreateDeploymentCommand,
  CreateIntegrationCommand,
  CreateRouteCommand,
  CreateStageCommand,
  DeleteIntegrationCommand,
  DeleteRouteCommand,
  DeleteStageCommand,
  GetApiCommand,
  GetIntegrationsCommand,
  GetRoutesCommand,
  GetStagesCommand,
  UpdateRouteCommand,
  UpdateStageCommand,
} from "@aws-sdk/client-apigatewayv2";
import { AddPermissionCommand } from "@aws-sdk/client-lambda";
import { clients } from "../../lib/aws.ts";
import { ACCOUNT_ID } from "../../lib/emulator-files.ts";
import { selectedRegion } from "../../lib/selected-region.ts";
import { errorMessage } from "../../console/serialize.ts";
import { validateValues } from "../../console/validate.ts";
import type { FieldMeta, FieldValues, Option, Result } from "../../console/types.ts";
import { lambdaFunctionOptions, v2Pages } from "./common.ts";
import { attachFields, integrationFields, routeFields, v2StageFields, variablesFields } from "./forms.ts";
import { checkRouteKey, functionArnFromUri, parseStageVariables } from "./helpers.ts";

export interface RouteView {
  id: string;
  key: string;
  target: string | null;
  authorization: string | null;
  apiKeyRequired: boolean;
}

export interface IntegrationView {
  id: string;
  type: string | null;
  method: string | null;
  uri: string | null;
  lambdaFunction: string | null;
  payload: string | null;
  timeoutMs: number | null;
  description: string | null;
}

export interface V2StageView {
  name: string;
  autoDeploy: boolean;
  deploymentId: string | null;
  invokeUrl: string | null;
  description: string | null;
  lastDeployment: string | null;
  variables: Record<string, string>;
  updated: string | null;
}

export interface V2ApiView {
  protocol: string;
  endpoint: string | null;
  routes: RouteView[];
  integrations: IntegrationView[];
  stages: V2StageView[];
}

async function attempt<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err: unknown) {
    return { ok: false, error: errorMessage(err) };
  }
}

const ID = /^[A-Za-z0-9]{1,64}$/;
function checkId(v: unknown, what: string): string {
  if (typeof v !== "string" || !ID.test(v)) throw new Error(`That is not a valid ${what}.`);
  return v;
}
function checkStage(v: unknown): string {
  if (typeof v !== "string" || !/^(\$default|[A-Za-z0-9_-]{1,128})$/.test(v)) throw new Error("That is not a valid stage name.");
  return v;
}
function checked(fields: FieldMeta[], raw: unknown): FieldValues {
  const r = validateValues(fields, raw);
  if (!r.ok) throw new Error(r.error);
  return r.data;
}
const iso = (d: Date | undefined): string | null => (d ? d.toISOString() : null);

function stageUrl(endpoint: string | undefined, protocol: string, stage: string): string | null {
  if (!endpoint) return null;
  if (stage === "$default") return protocol === "WEBSOCKET" ? endpoint : `${endpoint}/`;
  return `${endpoint}/${stage}`;
}

const v2Routes = (ApiId: string) => v2Pages((NextToken) => clients.apigatewayv2.send(new GetRoutesCommand({ ApiId, NextToken })));
const v2Integrations = (ApiId: string) => v2Pages((NextToken) => clients.apigatewayv2.send(new GetIntegrationsCommand({ ApiId, NextToken })));
const v2Stages = (ApiId: string) => v2Pages((NextToken) => clients.apigatewayv2.send(new GetStagesCommand({ ApiId, NextToken })));

async function integrationOptions(apiId: string): Promise<Option[]> {
  return (await v2Integrations(apiId)).filter((i) => i.IntegrationId).map((i) => ({ value: i.IntegrationId as string, label: `${i.IntegrationId} - ${i.IntegrationType ?? ""} ${i.IntegrationUri ?? ""}`.trim() }));
}

export async function loadV2Api(apiId: string): Promise<Result<V2ApiView>> {
  return attempt(async () => {
    const ApiId = checkId(apiId, "API ID");
    const v2 = clients.apigatewayv2;
    const [api, routes, integrations, stages] = await Promise.all([
      v2.send(new GetApiCommand({ ApiId })),
      v2Routes(ApiId),
      v2Integrations(ApiId),
      v2Stages(ApiId),
    ]);
    const protocol = api.ProtocolType ?? "HTTP";
    return {
      protocol,
      endpoint: api.ApiEndpoint ?? null,
      routes: routes
        .map((r) => ({ id: r.RouteId ?? "", key: r.RouteKey ?? "", target: r.Target ?? null, authorization: r.AuthorizationType ?? null, apiKeyRequired: r.ApiKeyRequired === true }))
        .sort((a, b) => a.key.localeCompare(b.key)),
      integrations: integrations.map((i) => ({
        id: i.IntegrationId ?? "",
        type: i.IntegrationType ?? null,
        method: i.IntegrationMethod ?? null,
        uri: i.IntegrationUri ?? null,
        lambdaFunction: functionArnFromUri(i.IntegrationUri) ?? (i.IntegrationUri?.startsWith("arn:aws:lambda:") ? i.IntegrationUri : null),
        payload: i.PayloadFormatVersion ?? null,
        timeoutMs: i.TimeoutInMillis ?? null,
        description: i.Description ?? null,
      })),
      stages: stages.map((s) => ({
        name: s.StageName ?? "",
        autoDeploy: s.AutoDeploy === true,
        deploymentId: s.DeploymentId ?? null,
        invokeUrl: stageUrl(api.ApiEndpoint, protocol, s.StageName ?? ""),
        description: s.Description ?? null,
        lastDeployment: s.LastDeploymentStatusMessage ?? null,
        variables: s.StageVariables ?? {},
        updated: iso(s.LastUpdatedDate),
      })),
    };
  });
}

async function protocolOf(apiId: string): Promise<string> {
  return (await clients.apigatewayv2.send(new GetApiCommand({ ApiId: apiId }))).ProtocolType ?? "HTTP";
}

export async function createV2Route(apiId: string, raw: unknown): Promise<Result<{ message: string }>> {
  return attempt(async () => {
    const ApiId = checkId(apiId, "API ID");
    const protocol = await protocolOf(ApiId);
    const v = checked(routeFields(protocol, await integrationOptions(ApiId)), raw);
    const key = protocol === "WEBSOCKET" ? String(v.routeKey) : String(v.path) === "$default" ? "$default" : `${String(v.method)} ${String(v.path)}`;
    const bad = checkRouteKey(key, protocol);
    if (bad) throw new Error(bad);
    const target = typeof v.integrationId === "string" && v.integrationId !== "" ? `integrations/${v.integrationId}` : undefined;
    const r = await clients.apigatewayv2.send(new CreateRouteCommand({ ApiId, RouteKey: key, Target: target }));
    return { message: `Created route ${r.RouteKey ?? key}.` };
  });
}

export async function attachV2Integration(apiId: string, routeId: string, raw: unknown): Promise<Result<{ message: string }>> {
  return attempt(async () => {
    const ApiId = checkId(apiId, "API ID");
    const v = checked(attachFields(await integrationOptions(ApiId)), raw);
    await clients.apigatewayv2.send(new UpdateRouteCommand({ ApiId, RouteId: checkId(routeId, "route ID"), Target: `integrations/${String(v.integrationId)}` }));
    return { message: `Attached integration ${String(v.integrationId)}.` };
  });
}

export async function deleteV2Route(apiId: string, routeId: string): Promise<Result<null>> {
  return attempt(async () => {
    await clients.apigatewayv2.send(new DeleteRouteCommand({ ApiId: checkId(apiId, "API ID"), RouteId: checkId(routeId, "route ID") }));
    return null;
  });
}

export async function createV2Integration(apiId: string, raw: unknown): Promise<Result<{ message: string }>> {
  return attempt(async () => {
    const ApiId = checkId(apiId, "API ID");
    const protocol = await protocolOf(ApiId);
    const lambda = await lambdaFunctionOptions(clients).then(
      (o) => ({ options: o, error: undefined as string | undefined }),
      (err: unknown) => ({ options: [] as Option[], error: `choices could not be loaded: ${errorMessage(err)}` })
    );
    const v = checked(integrationFields(protocol, lambda.options, lambda.error), raw);
    const description = typeof v.description === "string" && v.description.trim() ? v.description.trim() : undefined;
    const v2 = clients.apigatewayv2;
    if (v.type === "LAMBDA") {
      const fn = String(v.lambdaArn);
      const r = await v2.send(
        new CreateIntegrationCommand({ ApiId, IntegrationType: "AWS_PROXY", IntegrationUri: fn, IntegrationMethod: "POST", PayloadFormatVersion: v.payload === "1.0" ? "1.0" : protocol === "WEBSOCKET" ? "1.0" : "2.0", Description: description })
      );
      const sourceArn = `arn:aws:execute-api:${await selectedRegion()}:${ACCOUNT_ID}:${ApiId}/*`;
      let note: string;
      try {
        await clients.lambda.send(new AddPermissionCommand({ FunctionName: fn, StatementId: `apigateway-${ApiId}-${Date.now().toString(36)}`, Action: "lambda:InvokeFunction", Principal: "apigateway.amazonaws.com", SourceArn: sourceArn }));
        note = `Lambda AddPermission granted apigateway.amazonaws.com invoke access for ${sourceArn}.`;
      } catch (err: unknown) {
        note = `Lambda AddPermission failed: ${errorMessage(err)}`;
      }
      return { message: `Created integration ${r.IntegrationId ?? ""}. ${note}` };
    }
    if (v.type === "MOCK") {
      const r = await v2.send(new CreateIntegrationCommand({ ApiId, IntegrationType: "MOCK", Description: description }));
      return { message: `Created integration ${r.IntegrationId ?? ""}.` };
    }
    const r = await v2.send(
      new CreateIntegrationCommand({ ApiId, IntegrationType: "HTTP_PROXY", IntegrationUri: String(v.url), IntegrationMethod: String(v.httpMethod || "ANY"), PayloadFormatVersion: "1.0", Description: description })
    );
    return { message: `Created integration ${r.IntegrationId ?? ""}.` };
  });
}

export async function deleteV2Integration(apiId: string, integrationId: string): Promise<Result<null>> {
  return attempt(async () => {
    await clients.apigatewayv2.send(new DeleteIntegrationCommand({ ApiId: checkId(apiId, "API ID"), IntegrationId: checkId(integrationId, "integration ID") }));
    return null;
  });
}

export async function createV2Stage(apiId: string, raw: unknown): Promise<Result<{ message: string }>> {
  return attempt(async () => {
    const ApiId = checkId(apiId, "API ID");
    const v = checked(v2StageFields, raw);
    const name = checkStage(v.name);
    await clients.apigatewayv2.send(new CreateStageCommand({ ApiId, StageName: name, AutoDeploy: v.autoDeploy === true, Description: typeof v.description === "string" && v.description ? v.description : undefined }));
    return { message: `Created stage ${name}.` };
  });
}

export async function deleteV2Stage(apiId: string, stage: string): Promise<Result<null>> {
  return attempt(async () => {
    await clients.apigatewayv2.send(new DeleteStageCommand({ ApiId: checkId(apiId, "API ID"), StageName: checkStage(stage) }));
    return null;
  });
}

export async function deployV2Stage(apiId: string, stage: string): Promise<Result<{ message: string }>> {
  return attempt(async () => {
    const name = checkStage(stage);
    const r = await clients.apigatewayv2.send(new CreateDeploymentCommand({ ApiId: checkId(apiId, "API ID"), StageName: name }));
    return { message: `Deployed to stage ${name} (deployment ${r.DeploymentId ?? "?"}, ${r.DeploymentStatus ?? "status not returned"}).` };
  });
}

export async function saveV2StageVariables(apiId: string, stage: string, raw: unknown): Promise<Result<{ message: string }>> {
  return attempt(async () => {
    const v = checked(variablesFields, raw);
    const parsed = parseStageVariables(typeof v.variables === "string" ? v.variables : "");
    if (!parsed.ok) throw new Error(parsed.error);
    await clients.apigatewayv2.send(new UpdateStageCommand({ ApiId: checkId(apiId, "API ID"), StageName: checkStage(stage), StageVariables: parsed.vars }));
    return { message: `Saved ${Object.keys(parsed.vars).length} stage variable(s) on ${stage}.` };
  });
}
