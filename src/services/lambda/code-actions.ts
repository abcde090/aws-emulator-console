"use server";

/**
 * Server actions for the hand-built Lambda screens: the Code tab (read and deploy the
 * handler file), the Test tab (Invoke with a JSON event) and Create layer (upload a .zip).
 * AWS calls use the permission-checked clients; the code package is downloaded only from the
 * emulator's own pre-signed URL, with the emulator's CA.
 */

import { readFileSync } from "node:fs";
import { request } from "node:https";
import { GetFunctionCommand, GetFunctionConfigurationCommand, InvokeCommand, UpdateFunctionCodeCommand } from "@aws-sdk/client-lambda";
import JSZip from "jszip";
import { revalidatePath } from "next/cache";
import { emulatorEndpoint, emulatorFiles } from "../../lib/emulator-files.ts";
import { isEmulatorLocation, parseLambdaReport, pickEditableFile, type LambdaReport } from "../../lib/lambda-code.ts";
import { errorMessage } from "../../console/serialize.ts";
import { makeCtx } from "../../console/server.ts";
import type { Result } from "../../console/types.ts";
import { decodeLogTail, formatPayload, initDurationFromLog, parseTestEvent, requestIdFromLog } from "./helpers.ts";
import { publishLayer } from "./layers.ts";
import { zipSingleFile } from "./functions.ts";

const MAX_PACKAGE = 20 * 1024 * 1024;
const MAX_EDITABLE = 1024 * 1024;
const NAME = /^[a-zA-Z0-9_-]{1,64}$/;

async function attempt<T>(fn: () => Promise<T>, refresh?: string): Promise<Result<T>> {
  try {
    const data = await fn();
    if (refresh) {
      try {
        revalidatePath(refresh, "layout");
      } catch {
        // Only refreshes cached pages.
      }
    }
    return { ok: true, data };
  } catch (err: unknown) {
    return { ok: false, error: errorMessage(err) };
  }
}

function checkName(name: unknown): string {
  if (typeof name !== "string" || !NAME.test(name)) throw new Error("That is not a valid function name.");
  return name;
}

function download(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const req = request(url, { ca: readFileSync(emulatorFiles().ca, "utf8"), timeout: 15_000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`Downloading the code package failed with HTTP ${res.statusCode ?? "?"}.`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_PACKAGE) {
          req.destroy(new Error("The code package is larger than 20 MB, too large for the editor."));
          return;
        }
        chunks.push(c);
      });
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("Timed out downloading the code package.")));
    req.on("error", reject);
    req.end();
  });
}

/** JSZip internals used to bound decompression (not in its type definitions). */
interface ZipEntryInternals {
  _data?: { uncompressedSize?: number };
  internalStream?: (type: "uint8array") => {
    on(event: "data", cb: (chunk: Uint8Array) => void): unknown;
    on(event: "error", cb: (err: Error) => void): unknown;
    on(event: "end", cb: () => void): unknown;
    resume(): unknown;
    pause(): unknown;
  };
}

/**
 * One zip entry's bytes, or null when it is larger than `max`. The declared size is checked
 * before anything is decompressed, and decompression stops as soon as `max` is passed, so a
 * zip bomb (or a header that lies about its size) never fills memory.
 */
function readEntryCapped(entry: JSZip.JSZipObject, max: number): Promise<Uint8Array | null> {
  const internals = entry as unknown as ZipEntryInternals;
  const declared = internals._data?.uncompressedSize;
  if (typeof declared !== "number" || declared > max || !internals.internalStream) return Promise.resolve(null);
  const stream = internals.internalStream("uint8array");
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    let done = false;
    stream.on("data", (chunk) => {
      if (done) return;
      size += chunk.byteLength;
      if (size > max) {
        done = true;
        stream.pause();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    stream.on("error", (err) => {
      if (!done) reject(err);
      done = true;
    });
    stream.on("end", () => {
      if (done) return;
      done = true;
      const out = new Uint8Array(size);
      let offset = 0;
      for (const c of chunks) {
        out.set(c, offset);
        offset += c.byteLength;
      }
      resolve(out);
    });
    stream.resume();
  });
}

export interface FunctionCode {
  handler: string;
  runtime: string;
  files: string[];
  file: string | null;
  editable: boolean;
  content: string | null;
  codeSha256: string | null;
  packageType: string;
}

export async function loadFunctionCode(nameRaw: string): Promise<Result<FunctionCode>> {
  return attempt(async () => {
    const name = checkName(nameRaw);
    const ctx = await makeCtx();
    const f = await ctx.clients.lambda.send(new GetFunctionCommand({ FunctionName: name }));
    const c = f.Configuration ?? {};
    const base = { handler: c.Handler ?? "", runtime: c.Runtime ?? "", codeSha256: c.CodeSha256 ?? null, packageType: c.PackageType ?? "Zip" };
    if (c.PackageType === "Image") return { ...base, files: [], file: null, editable: false, content: null };
    const location = f.Code?.Location;
    if (!isEmulatorLocation(location, emulatorEndpoint())) throw new Error("GetFunction returned a code location outside the emulator, so it was not downloaded.");
    const zip = await JSZip.loadAsync(await download(location as string));
    const files = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
    const pick = pickEditableFile(files, base.handler);
    let content: string | null = null;
    if (pick.file) {
      const bytes = await readEntryCapped(zip.files[pick.file], MAX_EDITABLE);
      content = bytes ? new TextDecoder().decode(bytes) : null;
    }
    return { ...base, files, file: pick.file, editable: pick.editable && content !== null, content };
  });
}

export async function deployFunctionCode(nameRaw: string, file: string, content: string): Promise<Result<{ codeSha256: string | null; lastModified: string | null }>> {
  return attempt(async () => {
    const name = checkName(nameRaw);
    if (typeof file !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(file)) throw new Error("The file name is not valid.");
    if (typeof content !== "string" || content.length > MAX_EDITABLE) throw new Error("The code must be text of at most 1 MB.");
    const ctx = await makeCtx();
    const r = await ctx.clients.lambda.send(new UpdateFunctionCodeCommand({ FunctionName: name, ZipFile: await zipSingleFile(file, content) }));
    return { codeSha256: r.CodeSha256 ?? null, lastModified: r.LastModified ?? null };
  }, "/lambda");
}

/** LastUpdateStatus after a deploy: "InProgress" until the new code is live, then "Successful" or "Failed". */
export async function functionUpdateStatus(nameRaw: string): Promise<Result<{ status: string | null; reason: string | null }>> {
  return attempt(async () => {
    const name = checkName(nameRaw);
    const c = await (await makeCtx()).clients.lambda.send(new GetFunctionConfigurationCommand({ FunctionName: name }));
    return { status: c.LastUpdateStatus ?? null, reason: c.LastUpdateStatusReason ?? null };
  });
}

export interface TestResult {
  status: "succeeded" | "failed";
  statusCode: number | null;
  functionError: string | null;
  response: string;
  log: string;
  requestId: string | null;
  executedVersion: string | null;
  report: LambdaReport;
  initDurationMs: number | null;
}

export async function testFunction(nameRaw: string, event: string, qualifier?: string): Promise<Result<TestResult>> {
  return attempt(async () => {
    const name = checkName(nameRaw);
    const parsed = parseTestEvent(typeof event === "string" ? event : "");
    if (!parsed.ok) throw new Error(parsed.error);
    if (parsed.value.length > 256 * 1024) throw new Error("The event is larger than 256 KB.");
    const q = typeof qualifier === "string" && /^[a-zA-Z0-9$_-]{1,128}$/.test(qualifier) ? qualifier : undefined;
    const ctx = await makeCtx();
    const r = await ctx.clients.lambda.send(new InvokeCommand({ FunctionName: name, Qualifier: q, Payload: new TextEncoder().encode(parsed.value), LogType: "Tail", InvocationType: "RequestResponse" }));
    const log = decodeLogTail(r.LogResult);
    return {
      status: r.FunctionError ? "failed" : "succeeded",
      statusCode: r.StatusCode ?? null,
      functionError: r.FunctionError ?? null,
      response: formatPayload(r.Payload),
      log,
      requestId: requestIdFromLog(log),
      executedVersion: r.ExecutedVersion ?? null,
      report: parseLambdaReport(log),
      initDurationMs: initDurationFromLog(log),
    };
  });
}

export async function publishLayerFromForm(form: FormData): Promise<Result<{ name: string; version: number | null; arn: string | null }>> {
  return attempt(async () => {
    const file = form.get("zip");
    if (!file || typeof file === "string" || !("arrayBuffer" in file)) throw new Error("Choose a .zip file to upload.");
    const text = (k: string) => {
      const v = form.get(k);
      return typeof v === "string" ? v.trim() : "";
    };
    const list = (k: string) => form.getAll(k).filter((v): v is string => typeof v === "string");
    return publishLayer(await makeCtx(), {
      name: text("name"),
      description: text("description"),
      license: text("license"),
      runtimes: list("runtimes"),
      architectures: list("architectures"),
      zip: new Uint8Array(await file.arrayBuffer()),
    });
  }, "/lambda");
}
