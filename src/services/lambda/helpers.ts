/**
 * Pure helpers for the Lambda console: runtimes and their starter code, environment variables,
 * log tails and invoke results. Unit-tested in tests/lambda-helpers.test.mjs.
 */

export interface RuntimeInfo {
  id: string;
  label: string;
  language: "nodejs" | "python";
}

/**
 * Runtimes offered for "Author from scratch". Only Node.js and Python: AWS Emulator runs both,
 * while Ruby functions fail at invoke and Java/.NET/custom runtimes need a compiled package.
 */
export const RUNTIMES: RuntimeInfo[] = [
  { id: "nodejs24.x", label: "Node.js 24.x", language: "nodejs" },
  { id: "nodejs22.x", label: "Node.js 22.x", language: "nodejs" },
  { id: "nodejs20.x", label: "Node.js 20.x", language: "nodejs" },
  { id: "python3.14", label: "Python 3.14", language: "python" },
  { id: "python3.13", label: "Python 3.13", language: "python" },
  { id: "python3.12", label: "Python 3.12", language: "python" },
  { id: "python3.11", label: "Python 3.11", language: "python" },
  { id: "python3.10", label: "Python 3.10", language: "python" },
];

export interface StarterCode {
  fileName: string;
  handler: string;
  code: string;
}

/** The "Hello from Lambda!" function the console creates for a new function. */
export function starterCode(runtime: string): StarterCode {
  if (runtime.startsWith("python")) {
    return {
      fileName: "lambda_function.py",
      handler: "lambda_function.lambda_handler",
      code: "import json\n\ndef lambda_handler(event, context):\n    # TODO implement\n    return {\n        'statusCode': 200,\n        'body': json.dumps('Hello from Lambda!')\n    }\n",
    };
  }
  if (runtime.startsWith("nodejs")) {
    return {
      fileName: "index.mjs",
      handler: "index.handler",
      code: "export const handler = async (event) => {\n  // TODO implement\n  const response = {\n    statusCode: 200,\n    body: JSON.stringify('Hello from Lambda!'),\n  };\n  return response;\n};\n",
    };
  }
  throw new Error(`No starter code for runtime ${runtime}. Choose a Node.js or Python runtime.`);
}

export const FUNCTION_NAME = "[a-zA-Z0-9_-]{1,64}";

/** Environment variables arrive from the form's key/value editor. Keys must be valid names. */
export function envFromPairs(pairs: { Key: string; Value: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of pairs) {
    const key = p.Key.trim();
    if (key === "") continue;
    if (!/^[a-zA-Z]\w*$/.test(key)) throw new Error(`Environment variable "${key}": keys start with a letter and contain only letters, numbers and underscores.`);
    if (/^AWS_/.test(key) && key !== "AWS_LAMBDA_EXEC_WRAPPER") throw new Error(`Environment variable "${key}": keys starting with AWS_ are reserved by Lambda.`);
    out[key] = p.Value;
  }
  if (JSON.stringify(out).length > 4096) throw new Error("Environment variables are limited to 4 KB in total.");
  return out;
}

/** Decodes the base64 LogResult of an Invoke with LogType Tail. */
export function decodeLogTail(b64: string | undefined): string {
  if (!b64) return "";
  try {
    return Buffer.from(b64, "base64").toString("utf8");
  } catch {
    return "";
  }
}

/** The request ID from the START/REPORT lines of a log tail, or null. */
export function requestIdFromLog(log: string): string | null {
  const m = log.match(/(?:START|REPORT|END) RequestId: ([0-9a-fA-F-]{8,})/);
  return m ? m[1] : null;
}

/** "Init Duration: 3.16 ms" from the REPORT line, or null. */
export function initDurationFromLog(log: string): number | null {
  const m = log.match(/Init Duration: ([\d.]+) ms/);
  return m ? Number(m[1]) : null;
}

/** Pretty-prints an Invoke payload when it is JSON; otherwise returns the text as is. */
export function formatPayload(bytes: Uint8Array | undefined): string {
  if (!bytes || bytes.byteLength === 0) return "";
  const text = new TextDecoder().decode(bytes);
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** Parses a test event; the console requires valid JSON. */
export function parseTestEvent(text: string): { ok: true; value: string } | { ok: false; error: string } {
  const t = text.trim() === "" ? "{}" : text;
  try {
    JSON.parse(t);
    return { ok: true, value: t };
  } catch (err: unknown) {
    return { ok: false, error: `The event is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Lambda reports LastModified as "2026-11-23T06:50:38.050+0000"; make it ISO for the UI. */
export function lambdaDate(v: string | undefined): string | null {
  if (!v) return null;
  const iso = v.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? v : d.toISOString();
}

/** Statements of a resource-based policy JSON string, as table rows. */
export function policyStatements(policy: string | undefined): Record<string, string | null>[] {
  if (!policy) return [];
  try {
    const doc = JSON.parse(policy) as { Statement?: unknown };
    const list = Array.isArray(doc.Statement) ? doc.Statement : doc.Statement ? [doc.Statement] : [];
    return list.map((s) => {
      const st = s as { Sid?: string; Effect?: string; Principal?: unknown; Action?: unknown; Condition?: unknown };
      const principal = typeof st.Principal === "string" ? st.Principal : st.Principal ? Object.values(st.Principal as Record<string, unknown>).flat().join(", ") : null;
      return {
        sid: st.Sid ?? null,
        effect: st.Effect ?? null,
        principal,
        action: Array.isArray(st.Action) ? st.Action.join(", ") : typeof st.Action === "string" ? st.Action : null,
        conditions: st.Condition ? JSON.stringify(st.Condition) : null,
      };
    });
  } catch {
    return [];
  }
}

/** Record<string,string> as the key/value rows of a "tags" field. */
export function pairsFrom(record: Record<string, string> | undefined): { Key: string; Value: string }[] {
  return Object.entries(record ?? {}).map(([Key, Value]) => ({ Key, Value }));
}

export function sameRecord(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => b[k] === a[k]);
}

export interface GeneralSettings {
  Description?: string;
  MemorySize?: number;
  EphemeralStorage?: { Size?: number };
  Timeout?: number;
  Role?: string;
}

export interface GeneralEdits {
  description: string;
  memory?: number;
  ephemeral?: number;
  timeout?: number;
  role?: string;
}

/**
 * The UpdateFunctionConfiguration fields that the "Edit general configuration" form changed.
 * Fields the user left as they were are not sent, so they can't be reset by mistake.
 */
export function generalPatch(current: GeneralSettings, edits: GeneralEdits): { Description?: string; MemorySize?: number; EphemeralStorage?: { Size: number }; Timeout?: number; Role?: string } {
  const out: { Description?: string; MemorySize?: number; EphemeralStorage?: { Size: number }; Timeout?: number; Role?: string } = {};
  if (edits.description !== (current.Description ?? "")) out.Description = edits.description;
  if (edits.memory !== undefined && edits.memory !== current.MemorySize) out.MemorySize = edits.memory;
  if (edits.ephemeral !== undefined && edits.ephemeral !== (current.EphemeralStorage?.Size ?? 512)) out.EphemeralStorage = { Size: edits.ephemeral };
  if (edits.timeout !== undefined && edits.timeout !== current.Timeout) out.Timeout = edits.timeout;
  if (edits.role && edits.role !== current.Role) out.Role = edits.role;
  return out;
}
