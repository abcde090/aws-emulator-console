/**
 * Pure helpers for the API Gateway screens: Lambda integration URIs, invoke URLs from an
 * exported OpenAPI document, stage-variable editing and resource-tree ordering.
 * No AWS calls here, so they are unit-tested in tests/apigateway.test.mjs.
 */

export const HTTP_METHODS = ["ANY", "DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export function isHttpMethod(v: unknown): v is HttpMethod {
  return typeof v === "string" && (HTTP_METHODS as readonly string[]).includes(v);
}

/** The integration URI API Gateway uses to call a Lambda function. */
export function lambdaInvocationUri(region: string, functionArn: string): string {
  return `arn:aws:apigateway:${region}:lambda:path/2015-03-31/functions/${functionArn}/invocations`;
}

/** The Lambda function ARN inside a Lambda integration URI, or null if it is not one. */
export function functionArnFromUri(uri: unknown): string | null {
  if (typeof uri !== "string") return null;
  const m = /:lambda:path\/\d{4}-\d{2}-\d{2}\/functions\/(arn:aws[a-z-]*:lambda:[^/]+)\/invocations$/.exec(uri);
  return m ? m[1] : null;
}

/** "arn:aws:lambda:us-east-1:000000000000:function:fn" -> "fn". */
export function functionName(arn: string): string {
  const parts = arn.split(":");
  return parts[6] ?? arn;
}

/**
 * The stage's invoke URL from an OpenAPI 3 export (GetExport oas30): servers[0].url with
 * its {basePath} variable filled in. Null when the document has no usable server.
 */
export function invokeUrlFromExport(doc: unknown): string | null {
  if (!doc || typeof doc !== "object") return null;
  const servers = (doc as { servers?: unknown }).servers;
  if (!Array.isArray(servers) || servers.length === 0) return null;
  const server = servers[0] as { url?: unknown; variables?: Record<string, { default?: unknown }> };
  if (typeof server.url !== "string") return null;
  return server.url.replace(/\{([^}]+)\}/g, (whole, name: string) => {
    const d = server.variables?.[name]?.default;
    return typeof d === "string" ? d : whole;
  });
}

const VAR_NAME = /^[A-Za-z0-9_]{1,64}$/;
const VAR_VALUE = /^[A-Za-z0-9\-._~:/?#&=,]{1,512}$/;

/** Parses "name=value" lines (blank lines ignored) into stage variables, or an error. */
export function parseStageVariables(text: string): { ok: true; vars: Record<string, string> } | { ok: false; error: string } {
  const vars: Record<string, string> = {};
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
  for (const line of lines) {
    const i = line.indexOf("=");
    if (i <= 0) return { ok: false, error: `"${line}" is not name=value.` };
    const name = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    if (!VAR_NAME.test(name)) return { ok: false, error: `Variable name "${name}" may use only letters, numbers and underscores (up to 64).` };
    if (!VAR_VALUE.test(value)) return { ok: false, error: `Value of ${name} may use letters, numbers and -._~:/?#&=, (1-512 characters).` };
    vars[name] = value;
  }
  return { ok: true, vars };
}

export function formatStageVariables(vars: Record<string, string> | undefined): string {
  return Object.entries(vars ?? {}).map(([k, v]) => `${k}=${v}`).join("\n");
}

export interface PatchOp {
  op: "add" | "remove" | "replace";
  path: string;
  value?: string;
}

/** Patch operations that turn the old stage variables into the new ones. */
export function variablePatches(before: Record<string, string>, after: Record<string, string>): PatchOp[] {
  const ops: PatchOp[] = [];
  for (const k of Object.keys(before)) if (!(k in after)) ops.push({ op: "remove", path: `/variables/${k}` });
  for (const [k, v] of Object.entries(after)) if (before[k] !== v) ops.push({ op: "replace", path: `/variables/${k}`, value: v });
  return ops;
}

/** A path part for CreateResource: letters etc., or a {param} / {proxy+} placeholder. */
export function checkPathPart(part: string): string | null {
  if (part === "") return "Enter a resource name.";
  if (/^\{[A-Za-z0-9._-]+\+?\}$/.test(part)) return null;
  if (/^[A-Za-z0-9._~:@!$&'()*,;=-]+$/.test(part)) return null;
  return "Use letters, numbers and -._~ characters, or a path parameter such as {id} or {proxy+}.";
}

/** "GET /items/{id}", "ANY /{proxy+}", "$default", or a WebSocket key such as "$connect". */
export function checkRouteKey(key: string, protocol: string): string | null {
  if (key === "$default") return null;
  if (protocol === "WEBSOCKET") return /^\$?[A-Za-z0-9_.-]{1,128}$/.test(key) ? null : "Use a route key such as $connect, $disconnect or sendmessage.";
  const m = /^([A-Z]+) (\/[^\s]*)$/.exec(key);
  if (!m || !isHttpMethod(m[1])) return "Use METHOD /path, for example GET /items, or $default.";
  return null;
}

export interface TreeItem {
  id: string;
  path: string;
}

/** Resources ordered as the console's tree (by path), each with its depth. */
export function orderTree<T extends TreeItem>(items: T[]): (T & { depth: number })[] {
  return [...items]
    .sort((a, b) => (a.path === "/" ? -1 : b.path === "/" ? 1 : a.path.localeCompare(b.path)))
    .map((i) => ({ ...i, depth: i.path === "/" ? 0 : i.path.split("/").length - 1 }));
}

/** Child path the console shows while you type a new resource name. */
export function childPath(parentPath: string, part: string): string {
  return `${parentPath === "/" ? "" : parentPath}/${part}`;
}
