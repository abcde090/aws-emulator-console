/**
 * Field specs for the hand-built API editors. The browser draws them with FormFields and
 * the server actions validate against the same specs (validateValues), so nothing the
 * browser sends is trusted. Options that depend on live data are passed in.
 */

import type { FieldMeta, Option } from "../../console/types.ts";
import { HTTP_METHODS } from "./helpers.ts";

const methodOptions = (withAny: boolean): Option[] => HTTP_METHODS.filter((m) => withAny || m !== "ANY").map((m) => ({ value: m, label: m }));

export const NEW_STAGE = "__new__";

export const resourceFields: FieldMeta[] = [
  {
    name: "proxy", label: "Proxy resource", kind: "checkbox", default: false,
    help: "A proxy resource ({name+}) with an ANY method catches every request under its path.",
  },
  {
    name: "pathPart", label: "Resource name", kind: "text", required: true, placeholder: "items",
    help: "The last part of the path. Use {id} for a path parameter, or {proxy+} for a proxy resource.",
    validate: { pattern: "[A-Za-z0-9._~:@!$&'()*,;=-]+|\\{[A-Za-z0-9._-]+\\+?\\}", message: "Letters, numbers and -._~, or a {parameter}." },
  },
];

export function methodFields(lambda: Option[], lambdaError?: string): FieldMeta[] {
  return [
    { name: "httpMethod", label: "Method type", kind: "select", required: true, default: "GET", options: methodOptions(true), section: "Method details" },
    {
      name: "integration", label: "Integration type", kind: "radio", default: "LAMBDA", section: "Method details",
      options: [
        { value: "LAMBDA", label: "Lambda function: integrate with a Lambda function" },
        { value: "HTTP", label: "HTTP: integrate with an existing HTTP endpoint" },
        { value: "MOCK", label: "Mock: generate a response from API Gateway" },
      ],
    },
    { name: "lambdaProxy", label: "Lambda proxy integration", kind: "checkbox", default: true, section: "Method details", showIf: { field: "integration", equals: "LAMBDA" }, help: "Sends the whole request to the function as an event and returns the function's response as is." },
    {
      name: "lambdaArn", label: "Lambda function", kind: "select", required: true, options: lambda, optionsError: lambdaError, section: "Method details", showIf: { field: "integration", equals: "LAMBDA" },
      help: "API Gateway is also given permission to invoke the function (Lambda AddPermission), as the console does.",
    },
    { name: "httpProxy", label: "HTTP proxy integration", kind: "checkbox", default: true, section: "Method details", showIf: { field: "integration", equals: "HTTP" }, help: "Passes the request through to the endpoint and its response back unchanged." },
    { name: "endpointMethod", label: "HTTP method", kind: "select", required: true, default: "GET", options: methodOptions(true), section: "Method details", showIf: { field: "integration", equals: "HTTP" } },
    { name: "endpointUrl", label: "Endpoint URL", kind: "text", required: true, placeholder: "https://example.com/items", section: "Method details", showIf: { field: "integration", equals: "HTTP" }, validate: { pattern: "https?://[^\\s]+", message: "Enter an http:// or https:// URL." } },
    { name: "timeout", label: "Integration timeout (ms)", kind: "number", default: 29000, section: "Method details", validate: { min: 50, max: 29000, message: "Between 50 and 29000 milliseconds." } },
    {
      name: "authorization", label: "Authorization", kind: "select", required: true, default: "NONE", section: "Method request settings",
      options: [
        { value: "NONE", label: "None" },
        { value: "AWS_IAM", label: "AWS IAM" },
      ],
    },
    { name: "apiKeyRequired", label: "API key required", kind: "checkbox", default: false, section: "Method request settings" },
  ];
}

export const testFields: FieldMeta[] = [
  { name: "path", label: "Path", kind: "text", required: true, help: "Replace any {parameters} with values." },
  { name: "query", label: "Query strings", kind: "text", placeholder: "param1=value1&param2=value2" },
  { name: "headers", label: "Headers", kind: "textarea", placeholder: "header1:value1\nheader2:value2", help: "One header per line, as name:value." },
  { name: "body", label: "Request body", kind: "textarea" },
];

export function deployFields(stages: Option[]): FieldMeta[] {
  return [
    { name: "stage", label: "Stage", kind: "select", required: true, default: stages[0]?.value ?? NEW_STAGE, options: [...stages, { value: NEW_STAGE, label: "*New stage*" }] },
    { name: "stageName", label: "Stage name", kind: "text", required: true, placeholder: "prod", showIf: { field: "stage", equals: NEW_STAGE }, validate: { pattern: "[A-Za-z0-9_-]{1,128}", message: "Letters, numbers, hyphens and underscores." } },
    { name: "description", label: "Deployment description", kind: "text" },
  ];
}

export const variablesFields: FieldMeta[] = [
  { name: "variables", label: "Stage variables", kind: "textarea", placeholder: "name=value", help: "One per line as name=value. Leave empty to remove all variables." },
];

export function routeFields(protocol: string, integrations: Option[]): FieldMeta[] {
  const target: FieldMeta = { name: "integrationId", label: "Integration", kind: "select", options: integrations, help: "Attach an existing integration, or leave empty and attach one later." };
  if (protocol === "WEBSOCKET") {
    return [{ name: "routeKey", label: "Route key", kind: "text", required: true, placeholder: "$connect", help: "$connect, $disconnect, $default or a custom key matched by the route selection expression." }, target];
  }
  return [
    { name: "method", label: "Method", kind: "select", required: true, default: "ANY", options: methodOptions(true) },
    { name: "path", label: "Path", kind: "text", required: true, placeholder: "/items/{id}", help: "Starts with /. Use {param} for path parameters and {proxy+} for a greedy path. Use $default to catch everything else.", validate: { pattern: "\\$default|/[^\\s]*", message: "Start with / (or use $default)." } },
    target,
  ];
}

export function integrationFields(protocol: string, lambda: Option[], lambdaError?: string): FieldMeta[] {
  const types: Option[] = [
    { value: "LAMBDA", label: "Lambda function" },
    { value: "HTTP_PROXY", label: "HTTP URI" },
    ...(protocol === "WEBSOCKET" ? [{ value: "MOCK", label: "Mock" }] : []),
  ];
  return [
    { name: "type", label: "Integration type", kind: "radio", default: "LAMBDA", options: types },
    { name: "lambdaArn", label: "Lambda function", kind: "select", required: true, options: lambda, optionsError: lambdaError, showIf: { field: "type", equals: "LAMBDA" }, help: "API Gateway is also given permission to invoke the function." },
    {
      name: "payload", label: "Payload format version", kind: "select", default: "2.0", showIf: { field: "type", equals: "LAMBDA" },
      options: protocol === "WEBSOCKET" ? [{ value: "1.0", label: "1.0" }] : [{ value: "2.0", label: "2.0 (recommended)" }, { value: "1.0", label: "1.0" }],
    },
    { name: "url", label: "URL", kind: "text", required: true, placeholder: "https://example.com", showIf: { field: "type", equals: "HTTP_PROXY" }, validate: { pattern: "https?://[^\\s]+", message: "Enter an http:// or https:// URL." } },
    { name: "httpMethod", label: "Method", kind: "select", default: "ANY", options: methodOptions(true), showIf: { field: "type", equals: "HTTP_PROXY" } },
    { name: "description", label: "Description", kind: "text" },
  ];
}

export const attachFields = (integrations: Option[]): FieldMeta[] => [{ name: "integrationId", label: "Integration", kind: "select", required: true, options: integrations }];

export const v2StageFields: FieldMeta[] = [
  { name: "name", label: "Stage name", kind: "text", required: true, placeholder: "prod", help: "Use $default to serve the API from the base of its URL.", validate: { pattern: "\\$default|[A-Za-z0-9_-]{1,128}", message: "Letters, numbers, hyphens and underscores, or $default." } },
  { name: "autoDeploy", label: "Enable automatic deployment", kind: "checkbox", default: true, help: "Deploys every change to the API to this stage." },
  { name: "description", label: "Description", kind: "text" },
];
