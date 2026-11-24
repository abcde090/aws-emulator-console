/**
 * Amazon API Gateway. REST APIs (apigateway client) and HTTP/WebSocket APIs (apigatewayv2
 * client) share one APIs list, as in the console. The API detail screen is hand-built
 * (src/app/apigateway/apis/[api]) for the resource tree, method editor, routes and stages;
 * its summary and read-only tabs come from get() below.
 */

import { secondary, unavailableText } from "../../console/secondary.ts";
import {
  CreateRestApiCommand,
  DeleteRestApiCommand,
  GetAuthorizersCommand,
  GetDeploymentsCommand,
  GetModelsCommand,
  GetTagsCommand,
  UpdateRestApiCommand,
  type EndpointType,
  type RestApi,
} from "@aws-sdk/client-api-gateway";
import {
  CreateApiCommand,
  DeleteApiCommand,
  GetAuthorizersCommand as GetV2AuthorizersCommand,
  GetDeploymentsCommand as GetV2DeploymentsCommand,
  UpdateApiCommand,
  type GetApiResponse,
  type ProtocolType,
} from "@aws-sdk/client-apigatewayv2";
import type { Ctx, Detail, ResourceDef, Row, ServiceDef } from "../../console/types.ts";
import { findApi, listRestApis, listV2Apis, optText, restPages, tagRows, tagsRecord, TAG_COLUMNS, v2Pages } from "./common.ts";
import { apiKeys, usagePlans } from "./keys.ts";
import { clientCertificates, customDomains } from "./domains.ts";

const ENDPOINT_LABEL: Record<string, string> = { REGIONAL: "Regional", EDGE: "Edge-optimized", PRIVATE: "Private" };
const PROTOCOL_LABEL: Record<string, string> = { HTTP: "HTTP", WEBSOCKET: "WebSocket" };

function restRow(a: RestApi): Row {
  return {
    id: a.id ?? "",
    name: a.name ?? a.id ?? "",
    description: a.description ?? null,
    protocol: "REST",
    endpointType: (a.endpointConfiguration?.types ?? []).map((t) => ENDPOINT_LABEL[t] ?? t).join(", ") || null,
    created: a.createdDate ?? null,
    status: a.apiStatus ?? null,
  };
}

function v2Row(a: GetApiResponse): Row {
  return {
    id: a.ApiId ?? "",
    name: a.Name ?? a.ApiId ?? "",
    description: a.Description ?? null,
    protocol: PROTOCOL_LABEL[a.ProtocolType ?? ""] ?? a.ProtocolType ?? null,
    endpointType: "Regional",
    created: a.CreatedDate ?? null,
    status: null,
  };
}

async function restDetail(ctx: Ctx, a: RestApi): Promise<Detail> {
  const restApiId = a.id ?? "";
  const gw = ctx.clients.apigateway;
  // Secondary lookups: a denied one marks its tab unavailable instead of failing the page.
  const [deploymentsR, modelsR, authorizersR, tagsR] = await Promise.all([
    secondary(restPages((position) => gw.send(new GetDeploymentsCommand({ restApiId, limit: 500, position })))),
    secondary(restPages((position) => gw.send(new GetModelsCommand({ restApiId, limit: 500, position })))),
    secondary(restPages((position) => gw.send(new GetAuthorizersCommand({ restApiId, limit: 500, position })))),
    secondary(gw.send(new GetTagsCommand({ resourceArn: `arn:aws:apigateway:${ctx.region}::/restapis/${restApiId}` }))),
  ]);
  const row = restRow(a);
  return {
    summary: { Name: row.name, "API ID": restApiId, Protocol: "REST", "API endpoint type": row.endpointType, Description: row.description, Created: row.created },
    tabs: [
      {
        id: "settings",
        label: "API settings",
        kind: "keyvalue",
        data: {
          "API key source": a.apiKeySource ?? null,
          "Default execute-api endpoint": a.disableExecuteApiEndpoint ? "Inactive" : "Active",
          "Minimum compression size": a.minimumCompressionSize ?? "Off",
          "Binary media types": (a.binaryMediaTypes ?? []).join(", ") || "None",
          "Security policy": a.securityPolicy ?? null,
          "Root resource ID": a.rootResourceId ?? null,
          "API status": a.apiStatus ?? null,
          Version: a.version ?? null,
        },
      },
      {
        id: "deployments",
        label: "Deployment history",
        kind: "table",
        columns: [
          { key: "id", label: "Deployment ID", kind: "text" },
          { key: "description", label: "Description", kind: "text" },
          { key: "createdDate", label: "Deployment date", kind: "date" },
        ],
        data: deploymentsR.ok ? deploymentsR.value.map((d) => ({ id: d.id ?? "", description: d.description ?? null, createdDate: d.createdDate ?? null })) : [],
        emptyText: unavailableText(deploymentsR, "This API has not been deployed. Use Deploy API on the Resources tab."),
      },
      {
        id: "models",
        label: "Models",
        kind: "table",
        columns: [
          { key: "name", label: "Name", kind: "text" },
          { key: "contentType", label: "Content type", kind: "text" },
          { key: "description", label: "Description", kind: "text" },
        ],
        data: modelsR.ok ? modelsR.value.map((m) => ({ name: m.name ?? "", contentType: m.contentType ?? null, description: m.description ?? null })) : [],
        emptyText: unavailableText(modelsR, "No models."),
      },
      {
        id: "authorizers",
        label: "Authorizers",
        kind: "table",
        columns: [
          { key: "name", label: "Name", kind: "text" },
          { key: "id", label: "ID", kind: "text" },
          { key: "type", label: "Type", kind: "text" },
          { key: "identitySource", label: "Identity source", kind: "code" },
        ],
        data: authorizersR.ok ? authorizersR.value.map((z) => ({ name: z.name ?? "", id: z.id ?? "", type: z.type ?? null, identitySource: z.identitySource ?? null })) : [],
        emptyText: unavailableText(authorizersR, "No authorizers."),
      },
      { id: "tags", label: "Tags", kind: "table", columns: TAG_COLUMNS, data: tagsR.ok ? tagRows(tagsR.value.tags) : [], emptyText: unavailableText(tagsR, "No tags.") },
    ],
  };
}

async function v2Detail(ctx: Ctx, a: GetApiResponse): Promise<Detail> {
  const ApiId = a.ApiId ?? "";
  const v2 = ctx.clients.apigatewayv2;
  const [deploymentsR, authorizersR] = await Promise.all([
    secondary(v2Pages((NextToken) => v2.send(new GetV2DeploymentsCommand({ ApiId, NextToken })))),
    secondary(v2Pages((NextToken) => v2.send(new GetV2AuthorizersCommand({ ApiId, NextToken })))),
  ]);
  const row = v2Row(a);
  return {
    summary: { Name: row.name, "API ID": ApiId, Protocol: row.protocol, "API endpoint": a.ApiEndpoint ?? null, Description: row.description, Created: row.created },
    tabs: [
      {
        id: "settings",
        label: "API settings",
        kind: "keyvalue",
        data: {
          "Route selection expression": a.RouteSelectionExpression ?? null,
          "API key selection expression": a.ApiKeySelectionExpression ?? null,
          "Default endpoint": a.DisableExecuteApiEndpoint ? "Disabled" : "Enabled",
          "IP address type": a.IpAddressType ?? null,
          Version: a.Version ?? null,
        },
      },
      {
        id: "deployments",
        label: "Deployments",
        kind: "table",
        columns: [
          { key: "id", label: "Deployment ID", kind: "text" },
          { key: "status", label: "Status", kind: "status" },
          { key: "auto", label: "Automatic", kind: "boolean" },
          { key: "description", label: "Description", kind: "text" },
          { key: "created", label: "Created", kind: "date" },
        ],
        data: deploymentsR.ok ? deploymentsR.value.map((d) => ({ id: d.DeploymentId ?? "", status: d.DeploymentStatus ?? null, auto: d.AutoDeployed ?? null, description: d.Description ?? null, created: d.CreatedDate ?? null })) : [],
        emptyText: unavailableText(deploymentsR, "No deployments."),
      },
      {
        id: "authorizers",
        label: "Authorizers",
        kind: "table",
        columns: [
          { key: "name", label: "Name", kind: "text" },
          { key: "id", label: "ID", kind: "text" },
          { key: "type", label: "Type", kind: "text" },
        ],
        data: authorizersR.ok ? authorizersR.value.map((z) => ({ name: z.Name ?? "", id: z.AuthorizerId ?? "", type: z.AuthorizerType ?? null })) : [],
        emptyText: unavailableText(authorizersR, "No authorizers."),
      },
      { id: "cors", label: "CORS", kind: "json", data: a.CorsConfiguration ?? null, emptyText: "CORS is not configured for this API." },
      { id: "tags", label: "Tags", kind: "table", columns: TAG_COLUMNS, data: tagRows(a.Tags), emptyText: "No tags." },
    ],
  };
}

const apis: ResourceDef = {
  id: "apis",
  name: "APIs",
  singular: "API",
  idField: "id",
  nameField: "Name",
  description: "REST, HTTP and WebSocket APIs in this Region.",
  emptyText: "You don't have any APIs. Create an API to get started.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "description", label: "Description", kind: "text" },
    { key: "id", label: "ID", kind: "text" },
    { key: "protocol", label: "Protocol", kind: "text" },
    { key: "endpointType", label: "API endpoint type", kind: "text" },
    { key: "created", label: "Created", kind: "date" },
  ],

  async list(ctx) {
    const [rest, v2] = await Promise.all([listRestApis(ctx.clients), listV2Apis(ctx.clients)]);
    return [...rest.map(restRow), ...v2.map(v2Row)];
  },

  async get(ctx, id) {
    const ref = await findApi(ctx.clients, id);
    return ref.kind === "rest" ? restDetail(ctx, ref.api) : v2Detail(ctx, ref.api);
  },

  create: {
    title: "Create API",
    description: "Creates a REST API (CreateRestApi) or an HTTP or WebSocket API (CreateApi). Add resources, routes and stages on the API's page.",
    fields: [
      {
        name: "type", label: "API type", kind: "radio", default: "REST", section: "Choose an API type",
        options: [
          { value: "REST", label: "REST API: full control over requests and responses, API keys, usage plans" },
          { value: "HTTP", label: "HTTP API: low-latency, cost-effective APIs for Lambda functions and HTTP back ends" },
          { value: "WEBSOCKET", label: "WebSocket API: persistent connections for real-time use cases such as chat" },
        ],
      },
      { name: "name", label: "API name", kind: "text", required: true, section: "API details", placeholder: "MyAPI", validate: { pattern: "[^\\s].{0,127}", message: "1-128 characters." } },
      { name: "description", label: "Description", kind: "text", section: "API details", validate: { max: 1024, message: "At most 1024 characters." } },
      {
        name: "endpointType", label: "API endpoint type", kind: "select", required: true, default: "REGIONAL", section: "API details", showIf: { field: "type", equals: "REST" },
        help: "Regional APIs are deployed in the current Region. Edge-optimized APIs route requests through CloudFront. Private APIs are reachable only from VPCs through interface endpoints.",
        options: [
          { value: "REGIONAL", label: "Regional" },
          { value: "EDGE", label: "Edge-optimized" },
          { value: "PRIVATE", label: "Private" },
        ],
      },
      {
        name: "routeSelection", label: "Route selection expression", kind: "text", required: true, default: "$request.body.action", section: "API details", showIf: { field: "type", equals: "WEBSOCKET" },
        help: "Which part of an incoming message chooses the route, for example $request.body.action.",
      },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags - optional" },
    ],
    async run(ctx, v) {
      const name = String(v.name);
      const description = optText(v.description);
      const tags = tagsRecord(v.tags);
      if (v.type === "REST") {
        const types: EndpointType[] = [v.endpointType === "EDGE" ? "EDGE" : v.endpointType === "PRIVATE" ? "PRIVATE" : "REGIONAL"];
        const r = await ctx.clients.apigateway.send(new CreateRestApiCommand({ name, description, endpointConfiguration: { types }, tags }));
        if (!r.id) throw new Error("CreateRestApi returned no API ID.");
        return r.id;
      }
      const protocol: ProtocolType = v.type === "WEBSOCKET" ? "WEBSOCKET" : "HTTP";
      const r = await ctx.clients.apigatewayv2.send(
        new CreateApiCommand({ Name: name, Description: description, ProtocolType: protocol, RouteSelectionExpression: protocol === "WEBSOCKET" ? String(v.routeSelection) : undefined, Tags: tags })
      );
      if (!r.ApiId) throw new Error("CreateApi returned no API ID.");
      return r.ApiId;
    },
  },

  actions: [
    {
      id: "edit",
      label: "Edit API details",
      fields: [
        { name: "name", label: "API name", kind: "text", required: true, validate: { pattern: "[^\\s].{0,127}", message: "1-128 characters." } },
        { name: "description", label: "Description", kind: "text", help: "Clear the box to remove the description." },
      ],
      async initialValues(ctx, id) {
        const ref = await findApi(ctx.clients, id);
        return ref.kind === "rest"
          ? { name: ref.api.name ?? "", description: ref.api.description ?? "" }
          : { name: ref.api.Name ?? "", description: ref.api.Description ?? "" };
      },
      async run(ctx, id, v) {
        const ref = await findApi(ctx.clients, id);
        const name = String(v.name);
        const description = optText(v.description) ?? "";
        if (ref.kind === "rest") {
          await ctx.clients.apigateway.send(
            new UpdateRestApiCommand({ restApiId: id, patchOperations: [{ op: "replace", path: "/name", value: name }, { op: "replace", path: "/description", value: description }] })
          );
        } else {
          await ctx.clients.apigatewayv2.send(new UpdateApiCommand({ ApiId: id, Name: name, Description: description }));
        }
        return { message: `Saved API ${name}.` };
      },
    },
  ],

  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      const ref = await findApi(ctx.clients, id);
      if (ref.kind === "rest") await ctx.clients.apigateway.send(new DeleteRestApiCommand({ restApiId: id }));
      else await ctx.clients.apigatewayv2.send(new DeleteApiCommand({ ApiId: id }));
    },
  },
  detailHref: "apis/{id}",
};

export const apigatewayService: ServiceDef = {
  id: "apigateway",
  name: "API Gateway",
  category: "Networking & Content Delivery",
  description: "Create, publish, maintain, monitor and secure REST, HTTP and WebSocket APIs at any scale.",
  resources: [apis, customDomains, apiKeys, usagePlans, clientCertificates],
  notSupported: [
    "Tagging HTTP and WebSocket APIs after creation (TagResource, UntagResource and GetTags are not implemented for API Gateway V2)",
  ],
};
