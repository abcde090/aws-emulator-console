/**
 * Shared server-side reads for the API Gateway definitions and hand-built screens. REST APIs
 * use the apigateway client, HTTP and WebSocket APIs the apigatewayv2 client.
 */

import { GetRestApiCommand, GetRestApisCommand, GetStagesCommand, type RestApi } from "@aws-sdk/client-api-gateway";
import { GetApiCommand, GetApisCommand, type Api, type GetApiResponse } from "@aws-sdk/client-apigatewayv2";
import { ListFunctionsCommand } from "@aws-sdk/client-lambda";
import type { AwsClients } from "../../lib/aws.ts";
import type { Option, Row, Tag } from "../../console/types.ts";

export type ApiRef = { kind: "rest"; api: RestApi } | { kind: "v2"; api: GetApiResponse };

export function isNotFound(err: unknown): boolean {
  return err instanceof Error && err.name === "NotFoundException";
}

/** Finds an API by id among REST APIs first, then HTTP/WebSocket APIs. */
export async function findApi(clients: AwsClients, id: string): Promise<ApiRef> {
  try {
    const api: RestApi = await clients.apigateway.send(new GetRestApiCommand({ restApiId: id }));
    return { kind: "rest", api };
  } catch (err: unknown) {
    if (!isNotFound(err)) throw err;
  }
  try {
    const api: GetApiResponse = await clients.apigatewayv2.send(new GetApiCommand({ ApiId: id }));
    return { kind: "v2", api };
  } catch (err: unknown) {
    if (isNotFound(err)) throw new Error(`NotFoundException: No REST, HTTP or WebSocket API has the ID ${id}.`);
    throw err;
  }
}

export async function listRestApis(clients: AwsClients): Promise<RestApi[]> {
  const out: RestApi[] = [];
  let position: string | undefined;
  do {
    const r = await clients.apigateway.send(new GetRestApisCommand({ limit: 500, position }));
    out.push(...(r.items ?? []));
    position = r.position;
  } while (position);
  return out;
}

export async function listV2Apis(clients: AwsClients): Promise<Api[]> {
  const out: Api[] = [];
  let token: string | undefined;
  do {
    const r = await clients.apigatewayv2.send(new GetApisCommand({ MaxResults: "500", NextToken: token }));
    out.push(...(r.Items ?? []));
    token = r.NextToken;
  } while (token);
  return out;
}

/** "REST API stage" choices for usage plans and domain mappings: value "apiId/stage". */
export async function restStageOptions(clients: AwsClients): Promise<Option[]> {
  const apis = await listRestApis(clients);
  const per = await Promise.all(
    apis.map(async (a) => {
      const s = await clients.apigateway.send(new GetStagesCommand({ restApiId: a.id }));
      return (s.item ?? []).map((st) => ({ value: `${a.id}/${st.stageName}`, label: `${a.name ?? a.id} (${a.id}) - ${st.stageName}` }));
    })
  );
  return per.flat();
}

export function splitApiStage(v: unknown): { apiId: string; stage: string } {
  const s = typeof v === "string" ? v : "";
  const i = s.indexOf("/");
  if (i <= 0 || i === s.length - 1) throw new Error("Choose an API and stage.");
  return { apiId: s.slice(0, i), stage: s.slice(i + 1) };
}

export async function lambdaFunctionOptions(clients: AwsClients): Promise<Option[]> {
  const out: Option[] = [];
  let marker: string | undefined;
  do {
    const r = await clients.lambda.send(new ListFunctionsCommand({ Marker: marker, MaxItems: 50 }));
    for (const f of r.Functions ?? []) if (f.FunctionArn) out.push({ value: f.FunctionArn, label: f.FunctionName ?? f.FunctionArn });
    marker = r.NextMarker;
  } while (marker);
  return out;
}

export function tagRows(tags: Record<string, string> | undefined): Row[] {
  return Object.entries(tags ?? {}).map(([Key, Value]) => ({ Key, Value }));
}

export function tagsRecord(v: unknown): Record<string, string> | undefined {
  if (!Array.isArray(v) || v.length === 0) return undefined;
  return Object.fromEntries((v as Tag[]).map((t) => [t.Key, t.Value]));
}

export const TAG_COLUMNS = [
  { key: "Key", label: "Key", kind: "text" as const },
  { key: "Value", label: "Value", kind: "text" as const },
];

export const optText = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);

/** A secondary lookup that may fail (e.g. denied for the acting identity) without failing the page. */
/** Every page of a REST API (apigateway) list call, which pages with `position`. */
export async function restPages<T>(fetch: (position: string | undefined) => Promise<{ items?: T[]; position?: string }>): Promise<T[]> {
  const out: T[] = [];
  let position: string | undefined;
  for (let i = 0; i < 100; i++) {
    const r = await fetch(position);
    out.push(...(r.items ?? []));
    if (!r.position || r.position === position) break;
    position = r.position;
  }
  return out;
}

/** Every page of an apigatewayv2 list call, which pages with NextToken. */
export async function v2Pages<T>(fetch: (token: string | undefined) => Promise<{ Items?: T[]; NextToken?: string }>): Promise<T[]> {
  const out: T[] = [];
  let token: string | undefined;
  for (let i = 0; i < 100; i++) {
    const r = await fetch(token);
    out.push(...(r.Items ?? []));
    if (!r.NextToken || r.NextToken === token) break;
    token = r.NextToken;
  }
  return out;
}
