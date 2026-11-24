"use server";

/**
 * Server actions for the hand-built REST API editor (resources, methods, test, stages,
 * deploy). Every call goes through the permission-checked clients; every form is checked
 * against its field spec (forms.ts) before anything is sent.
 */

import {
  CreateDeploymentCommand,
  CreateResourceCommand,
  DeleteMethodCommand,
  DeleteResourceCommand,
  DeleteStageCommand,
  GetExportCommand,
  GetMethodCommand,
  GetResourcesCommand,
  GetStageCommand,
  GetStagesCommand,
  PutIntegrationCommand,
  PutIntegrationResponseCommand,
  PutMethodCommand,
  PutMethodResponseCommand,
  TestInvokeMethodCommand,
  UpdateStageCommand,
  type IntegrationType,
} from "@aws-sdk/client-api-gateway";
import { AddPermissionCommand } from "@aws-sdk/client-lambda";
import { clients } from "../../lib/aws.ts";
import { ACCOUNT_ID } from "../../lib/emulator-files.ts";
import { selectedRegion } from "../../lib/selected-region.ts";
import { errorMessage } from "../../console/serialize.ts";
import { validateValues } from "../../console/validate.ts";
import type { FieldMeta, FieldValues, Option, Result } from "../../console/types.ts";
import { lambdaFunctionOptions } from "./common.ts";
import { deployFields, methodFields, NEW_STAGE, resourceFields, testFields, variablesFields } from "./forms.ts";
import { functionArnFromUri, isHttpMethod, invokeUrlFromExport, lambdaInvocationUri, parseStageVariables, variablePatches } from "./helpers.ts";

export interface RestResourceView {
  id: string;
  path: string;
  parentId: string | null;
  methods: string[];
}

export interface MethodView {
  httpMethod: string;
  authorization: string;
  apiKeyRequired: boolean;
  integrationType: string | null;
  integrationMethod: string | null;
  uri: string | null;
  lambdaFunction: string | null;
  timeoutMs: number | null;
  passthrough: string | null;
  requestTemplates: Record<string, string>;
  methodResponses: string[];
  integrationResponses: { status: string; pattern: string | null; templates: Record<string, string> }[];
}

export interface StageView {
  name: string;
  deploymentId: string | null;
  description: string | null;
  invokeUrl: string | null;
  invokeUrlError: string | null;
  variables: Record<string, string>;
  created: string | null;
  updated: string | null;
  tracing: boolean;
}

export interface TestView {
  status: number | null;
  latency: number | null;
  body: string;
  headers: Record<string, string>;
  log: string;
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
function checkMethod(v: unknown): string {
  if (!isHttpMethod(v)) throw new Error("That is not an HTTP method.");
  return v;
}
function checkStage(v: unknown): string {
  if (typeof v !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(v)) throw new Error("That is not a valid stage name.");
  return v;
}
function checked(fields: FieldMeta[], raw: unknown): FieldValues {
  const r = validateValues(fields, raw);
  if (!r.ok) throw new Error(r.error);
  return r.data;
}
const iso = (d: Date | undefined): string | null => (d ? d.toISOString() : null);

export async function listLambdaOptions(): Promise<Result<Option[]>> {
  return attempt(() => lambdaFunctionOptions(clients));
}

export async function listRestResources(apiId: string): Promise<Result<RestResourceView[]>> {
  return attempt(async () => {
    const restApiId = checkId(apiId, "API ID");
    const out: RestResourceView[] = [];
    let position: string | undefined;
    do {
      const r = await clients.apigateway.send(new GetResourcesCommand({ restApiId, limit: 500, position, embed: ["methods"] }));
      for (const i of r.items ?? []) {
        if (!i.id) continue;
        out.push({ id: i.id, path: i.path ?? "/", parentId: i.parentId ?? null, methods: Object.keys(i.resourceMethods ?? {}).sort() });
      }
      position = r.position;
    } while (position);
    return out;
  });
}

export async function getRestMethod(apiId: string, resourceId: string, httpMethod: string): Promise<Result<MethodView>> {
  return attempt(async () => {
    const m = await clients.apigateway.send(new GetMethodCommand({ restApiId: checkId(apiId, "API ID"), resourceId: checkId(resourceId, "resource ID"), httpMethod: checkMethod(httpMethod) }));
    const i = m.methodIntegration;
    return {
      httpMethod: m.httpMethod ?? httpMethod,
      authorization: m.authorizationType ?? "NONE",
      apiKeyRequired: m.apiKeyRequired === true,
      integrationType: i?.type ?? null,
      integrationMethod: i?.httpMethod ?? null,
      uri: i?.uri ?? null,
      lambdaFunction: functionArnFromUri(i?.uri),
      timeoutMs: i?.timeoutInMillis ?? null,
      passthrough: i?.passthroughBehavior ?? null,
      requestTemplates: i?.requestTemplates ?? {},
      methodResponses: Object.keys(m.methodResponses ?? {}).sort(),
      integrationResponses: Object.values(i?.integrationResponses ?? {}).map((r) => ({ status: r.statusCode ?? "", pattern: r.selectionPattern ?? null, templates: r.responseTemplates ?? {} })),
    };
  });
}

export async function createRestResource(apiId: string, parentId: string, raw: unknown): Promise<Result<{ id: string; path: string }>> {
  return attempt(async () => {
    const restApiId = checkId(apiId, "API ID");
    const v = checked(resourceFields, raw);
    const pathPart = String(v.pathPart);
    if (v.proxy === true && !/^\{[A-Za-z0-9._-]+\+\}$/.test(pathPart)) throw new Error("A proxy resource name must look like {proxy+}.");
    const r = await clients.apigateway.send(new CreateResourceCommand({ restApiId, parentId: checkId(parentId, "parent resource ID"), pathPart }));
    if (!r.id) throw new Error("CreateResource returned no ID.");
    if (v.proxy === true) {
      await clients.apigateway.send(new PutMethodCommand({ restApiId, resourceId: r.id, httpMethod: "ANY", authorizationType: "NONE" }));
    }
    return { id: r.id, path: r.path ?? pathPart };
  });
}

export async function deleteRestResource(apiId: string, resourceId: string): Promise<Result<null>> {
  return attempt(async () => {
    await clients.apigateway.send(new DeleteResourceCommand({ restApiId: checkId(apiId, "API ID"), resourceId: checkId(resourceId, "resource ID") }));
    return null;
  });
}

async function grantLambda(functionArn: string, apiId: string, method: string, path: string): Promise<string> {
  const sourceArn = `arn:aws:execute-api:${await selectedRegion()}:${ACCOUNT_ID}:${apiId}/*/${method === "ANY" ? "*" : method}${path}`;
  try {
    await clients.lambda.send(
      new AddPermissionCommand({ FunctionName: functionArn, StatementId: `apigateway-${apiId}-${Date.now().toString(36)}`, Action: "lambda:InvokeFunction", Principal: "apigateway.amazonaws.com", SourceArn: sourceArn })
    );
    return `Lambda AddPermission granted apigateway.amazonaws.com invoke access for ${sourceArn}.`;
  } catch (err: unknown) {
    return `The method was created, but Lambda AddPermission failed: ${errorMessage(err)}`;
  }
}

export async function createRestMethod(apiId: string, resourceId: string, path: string, raw: unknown): Promise<Result<{ message: string }>> {
  return attempt(async () => {
    const restApiId = checkId(apiId, "API ID");
    const resId = checkId(resourceId, "resource ID");
    const lambda = await lambdaFunctionOptions(clients).then(
      (o) => ({ options: o, error: undefined as string | undefined }),
      (err: unknown) => ({ options: [] as Option[], error: `choices could not be loaded: ${errorMessage(err)}` })
    );
    const v = checked(methodFields(lambda.options, lambda.error), raw);
    const httpMethod = checkMethod(v.httpMethod);
    const gw = clients.apigateway;
    await gw.send(new PutMethodCommand({ restApiId, resourceId: resId, httpMethod, authorizationType: v.authorization === "AWS_IAM" ? "AWS_IAM" : "NONE", apiKeyRequired: v.apiKeyRequired === true }));
    const timeoutInMillis = typeof v.timeout === "number" ? v.timeout : undefined;
    let type: IntegrationType;
    let note = "";
    if (v.integration === "LAMBDA") {
      const fn = String(v.lambdaArn);
      type = v.lambdaProxy === true ? "AWS_PROXY" : "AWS";
      await gw.send(new PutIntegrationCommand({ restApiId, resourceId: resId, httpMethod, type, integrationHttpMethod: "POST", uri: lambdaInvocationUri(await selectedRegion(), fn), timeoutInMillis }));
      note = ` ${await grantLambda(fn, restApiId, httpMethod, typeof path === "string" ? path : "/")}`;
    } else if (v.integration === "HTTP") {
      type = v.httpProxy === true ? "HTTP_PROXY" : "HTTP";
      await gw.send(new PutIntegrationCommand({ restApiId, resourceId: resId, httpMethod, type, integrationHttpMethod: checkMethod(v.endpointMethod), uri: String(v.endpointUrl), timeoutInMillis }));
    } else {
      type = "MOCK";
      await gw.send(new PutIntegrationCommand({ restApiId, resourceId: resId, httpMethod, type, requestTemplates: { "application/json": '{"statusCode": 200}' }, timeoutInMillis }));
    }
    // Non-proxy integrations need a method response and an integration response, as the console sets up.
    if (type === "MOCK" || type === "HTTP" || type === "AWS") {
      await gw.send(new PutMethodResponseCommand({ restApiId, resourceId: resId, httpMethod, statusCode: "200", responseModels: { "application/json": "Empty" } }));
      await gw.send(new PutIntegrationResponseCommand({ restApiId, resourceId: resId, httpMethod, statusCode: "200", responseTemplates: { "application/json": "" } }));
    }
    return { message: `Created ${httpMethod} method with a ${type} integration.${note}` };
  });
}

export async function deleteRestMethod(apiId: string, resourceId: string, httpMethod: string): Promise<Result<null>> {
  return attempt(async () => {
    await clients.apigateway.send(new DeleteMethodCommand({ restApiId: checkId(apiId, "API ID"), resourceId: checkId(resourceId, "resource ID"), httpMethod: checkMethod(httpMethod) }));
    return null;
  });
}

function parseHeaders(text: unknown): Record<string, string> | undefined {
  if (typeof text !== "string" || text.trim() === "") return undefined;
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const i = line.indexOf(":");
    if (i <= 0) throw new Error(`Header "${line}" is not name:value.`);
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

export async function testRestMethod(apiId: string, resourceId: string, httpMethod: string, raw: unknown): Promise<Result<TestView>> {
  return attempt(async () => {
    const v = checked(testFields, raw);
    const query = typeof v.query === "string" && v.query.trim() !== "" ? `?${v.query.trim().replace(/^\?/, "")}` : "";
    const r = await clients.apigateway.send(
      new TestInvokeMethodCommand({
        restApiId: checkId(apiId, "API ID"),
        resourceId: checkId(resourceId, "resource ID"),
        httpMethod: checkMethod(httpMethod),
        pathWithQueryString: `${String(v.path)}${query}`,
        headers: parseHeaders(v.headers),
        body: typeof v.body === "string" && v.body !== "" ? v.body : undefined,
      })
    );
    return { status: r.status ?? null, latency: r.latency ?? null, body: r.body ?? "", headers: r.headers ?? {}, log: r.log ?? "" };
  });
}

async function invokeUrl(restApiId: string, stageName: string): Promise<{ url: string | null; error: string | null }> {
  try {
    const r = await clients.apigateway.send(new GetExportCommand({ restApiId, stageName, exportType: "oas30", accepts: "application/json" }));
    const text = r.body ? new TextDecoder().decode(r.body) : "";
    const url = invokeUrlFromExport(JSON.parse(text));
    return url ? { url, error: null } : { url: null, error: "The export has no server URL." };
  } catch (err: unknown) {
    return { url: null, error: errorMessage(err) };
  }
}

export async function listRestStages(apiId: string): Promise<Result<StageView[]>> {
  return attempt(async () => {
    const restApiId = checkId(apiId, "API ID");
    const r = await clients.apigateway.send(new GetStagesCommand({ restApiId }));
    return Promise.all(
      (r.item ?? []).map(async (s) => {
        const name = s.stageName ?? "";
        const u = await invokeUrl(restApiId, name);
        return {
          name,
          deploymentId: s.deploymentId ?? null,
          description: s.description ?? null,
          invokeUrl: u.url,
          invokeUrlError: u.error,
          variables: s.variables ?? {},
          created: iso(s.createdDate),
          updated: iso(s.lastUpdatedDate),
          tracing: s.tracingEnabled === true,
        };
      })
    );
  });
}

export async function deployRestApi(apiId: string, raw: unknown): Promise<Result<{ message: string }>> {
  return attempt(async () => {
    const restApiId = checkId(apiId, "API ID");
    const existing = (await clients.apigateway.send(new GetStagesCommand({ restApiId }))).item ?? [];
    const options = existing.map((s) => ({ value: s.stageName ?? "", label: s.stageName ?? "" }));
    const v = checked(deployFields(options), raw);
    const stageName = v.stage === NEW_STAGE ? checkStage(v.stageName) : checkStage(v.stage);
    const d = await clients.apigateway.send(new CreateDeploymentCommand({ restApiId, stageName, description: typeof v.description === "string" && v.description ? v.description : undefined }));
    return { message: `Deployed to stage ${stageName} (deployment ${d.id ?? "?"}).` };
  });
}

export async function deleteRestStage(apiId: string, stageName: string): Promise<Result<null>> {
  return attempt(async () => {
    await clients.apigateway.send(new DeleteStageCommand({ restApiId: checkId(apiId, "API ID"), stageName: checkStage(stageName) }));
    return null;
  });
}

export async function saveRestStageVariables(apiId: string, stageName: string, raw: unknown): Promise<Result<{ message: string }>> {
  return attempt(async () => {
    const restApiId = checkId(apiId, "API ID");
    const stage = checkStage(stageName);
    const v = checked(variablesFields, raw);
    const parsed = parseStageVariables(typeof v.variables === "string" ? v.variables : "");
    if (!parsed.ok) throw new Error(parsed.error);
    const current = await clients.apigateway.send(new GetStageCommand({ restApiId, stageName: stage }));
    const ops = variablePatches(current.variables ?? {}, parsed.vars);
    if (ops.length === 0) return { message: "No changes to save." };
    await clients.apigateway.send(new UpdateStageCommand({ restApiId, stageName: stage, patchOperations: ops }));
    return { message: `Saved ${Object.keys(parsed.vars).length} stage variable(s) on ${stage}.` };
  });
}
