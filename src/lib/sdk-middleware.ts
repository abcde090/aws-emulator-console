/**
 * Middleware every emulator client gets (see aws.ts):
 *   1. simulatedIamCheck (initialize step, high priority): the IAM simulator, before anything else.
 *   2. emulatorEpochTrim (deserialize step, low priority = closest to the raw response):
 *      trims nanosecond epoch fractions in JSON bodies before the SDK parses them
 *      (see epoch-trim.ts). Payload-carrying commands (S3 objects, Lambda Invoke output,
 *      Glacier job output, API exports) are never touched: those bytes belong to the user.
 * Plus the transport: an HTTP/1.1 NodeHttpHandler for every client, because the emulator
 * refuses HTTP/2 (Kinesis and a few other clients default to HTTP/2).
 */

import type { Agent } from "node:https";
import { Readable } from "node:stream";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { hasLongEpochFraction, trimEpochFractions } from "./epoch-trim.ts";

export const IAM_MIDDLEWARE_NAME = "simulatedIamCheck";
export const EPOCH_MIDDLEWARE_NAME = "emulatorEpochTrim";

/** Commands whose response body is user data, not an API document. */
const PAYLOAD_COMMANDS = new Set([
  "LambdaClient:InvokeCommand",
  "LambdaClient:InvokeWithResponseStreamCommand",
  "LambdaClient:InvokeAsyncCommand",
  "GlacierClient:GetJobOutputCommand",
  "APIGatewayClient:GetExportCommand",
  "APIGatewayClient:GetSdkCommand",
  "ApiGatewayV2Client:ExportApiCommand",
]);
const PAYLOAD_CLIENTS = new Set(["S3Client"]);

export type Enforce = (clientName: string | undefined, commandName: string | undefined, input: unknown) => Promise<void>;

interface MwContext {
  clientName?: string;
  commandName?: string;
}
interface RawResponse {
  body?: unknown;
  headers?: Record<string, string | undefined>;
}
type Handler = (args: { input: unknown }) => Promise<{ response?: unknown; output?: unknown }>;
type Middleware = (next: Handler, context: MwContext) => Handler;

export interface StackOwner {
  middlewareStack: { add: (mw: Middleware, opts: Record<string, unknown>) => void };
}

function headerValue(headers: RawResponse["headers"], name: string): string {
  if (!headers) return "";
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? String(headers[key] ?? "") : "";
}

async function readBody(body: unknown): Promise<Buffer | null> {
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body && typeof body === "object" && Symbol.asyncIterator in body) {
    const chunks: Buffer[] = [];
    for await (const c of body as AsyncIterable<Uint8Array | string>) chunks.push(typeof c === "string" ? Buffer.from(c) : Buffer.from(c));
    return Buffer.concat(chunks);
  }
  return null;
}

/** Headers for a rewritten body: new length, and no body checksum (it described the old bytes). */
export function adjustedHeaders(headers: Record<string, string | undefined>, length: number): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (lower === "x-amz-crc32") continue;
    out[k] = lower === "content-length" ? String(length) : v;
  }
  return out;
}

/** Whether the epoch fix may read this response's body. */
export function shouldTrimResponse(context: MwContext, contentType: string): boolean {
  // Unlabelled bodies are checked too: some emulator responses omit the content type.
  if (contentType !== "" && !/json/i.test(contentType)) return false;
  if (context.clientName && PAYLOAD_CLIENTS.has(context.clientName)) return false;
  return !PAYLOAD_COMMANDS.has(`${context.clientName ?? ""}:${context.commandName ?? ""}`);
}

const epochTrim: Middleware = (next, context) => async (args) => {
  const out = await next(args);
  const res = out.response as RawResponse | undefined;
  if (!res || !shouldTrimResponse(context, headerValue(res.headers, "content-type"))) return out;
  const raw = await readBody(res.body);
  if (raw === null) return out;
  const text = raw.toString("utf8");
  const fixed = hasLongEpochFraction(text) ? Buffer.from(trimEpochFractions(text), "utf8") : raw;
  // A stream again, so every SDK body reader (collectBody, sdkStreamMixin) accepts it.
  res.body = Readable.from([fixed]);
  if (res.headers && fixed !== raw) res.headers = adjustedHeaders(res.headers, fixed.length);
  return out;
};

/** Adds the IAM check (when `enforce` is given) and the epoch fix to one client. */
export function installEmulatorMiddleware(client: StackOwner, enforce: Enforce | null): void {
  if (enforce) {
    client.middlewareStack.add(
      (next, context) => async (args) => {
        await enforce(context.clientName, context.commandName, args.input);
        return next(args);
      },
      { step: "initialize", name: IAM_MIDDLEWARE_NAME, priority: "high" }
    );
  }
  client.middlewareStack.add(epochTrim, { step: "deserialize", name: EPOCH_MIDDLEWARE_NAME, priority: "low" });
}

/** HTTP/1.1 request handler over the emulator's TLS agent. */
export function emulatorRequestHandler(agent: Agent): NodeHttpHandler {
  return new NodeHttpHandler({ httpsAgent: agent, connectionTimeout: 5000, requestTimeout: 30000 });
}
