/**
 * AWS Emulator fidelity gap: several services (ECS, Glue, Athena, Identity Store …) return
 * epoch-second timestamps with nanosecond fractions, e.g. 1795421453.604998128. Real AWS
 * sends at most milliseconds. The SDK's JSON reader keeps such numbers as exact decimals
 * (NumericValue) and its timestamp parser then throws "Epoch timestamps must be expressed
 * as floating point numbers". trimEpochFractions() rewrites the JSON text so those numbers
 * are cut to milliseconds.
 *
 * Only numbers that are clearly timestamps change: the value must be epoch seconds between
 * 2001 and 2100 with more than 3 decimals, AND its member name (or, inside an array, the
 * array's member name) must look like a timestamp field (…Time, …Date, …At, …Timestamp,
 * LastModified, Expiration …). Metric values, costs, quotas and strings never change.
 */

/** Seconds since 1970 with 4+ decimals; the integer part is checked against the range below. */
const EPOCH_WITH_LONG_FRACTION = /^(\d{10})(\.\d{3})\d+$/;
const MIN_EPOCH_SECONDS = 978_307_200; // 2001-01-01
const MAX_EPOCH_SECONDS = 4_102_444_800; // 2100-01-01
const NUMBER_START = /[-0-9]/;
const NUMBER_CHAR = /[-+0-9.eE]/;

/** Member names AWS uses for timestamps (CreationTime, LastModified, NotAfter …), any case. */
const TIMESTAMP_SUFFIX =
  /(time|times|timestamp|timestamps|date|dates|modified|created|updated|deleted|expiration|expiry|expires|deadline|since|until|validfrom|notbefore|notafter)$/i;
/** camelCase "…At" (createdAt, UpdatedAt), so "Format" or "Stat" never match. */
const CAMEL_AT = /[a-z]At$/;

/** True when `key` names a timestamp member. Exported for tests. */
export function isTimestampKey(key: string | null): boolean {
  return !!key && (TIMESTAMP_SUFFIX.test(key) || CAMEL_AT.test(key));
}

/** Index just past the string that starts at `start` (a double quote). */
function skipString(json: string, start: number): number {
  let i = start + 1;
  while (i < json.length) {
    const c = json[i];
    if (c === "\\") i += 2;
    else if (c === '"') return i + 1;
    else i++;
  }
  return i;
}

function decodeKey(raw: string): string | null {
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

function nextNonSpace(json: string, from: number): string {
  let i = from;
  while (i < json.length && /\s/.test(json[i])) i++;
  return json[i] ?? "";
}

/** One open object or array; `key` is the member name values here belong to. */
interface Frame {
  kind: "object" | "array";
  key: string | null;
}

/** The trimmed number text, or null when `num` under `key` is not a timestamp to trim. */
function trimmed(num: string, key: string | null): string | null {
  const m = EPOCH_WITH_LONG_FRACTION.exec(num);
  if (!m) return null;
  const seconds = Number(m[1]);
  if (seconds < MIN_EPOCH_SECONDS || seconds >= MAX_EPOCH_SECONDS) return null;
  return isTimestampKey(key) ? m[1] + m[2] : null;
}

/** Trims epoch-second timestamps with more than three decimals to three. Pure; JSON text only. */
export function trimEpochFractions(json: string): string {
  let out = "";
  let last = 0;
  let i = 0;
  const stack: Frame[] = [];
  const top = (): Frame | undefined => stack[stack.length - 1];
  while (i < json.length) {
    const c = json[i];
    if (c === '"') {
      const end = skipString(json, i);
      const frame = top();
      if (frame?.kind === "object" && nextNonSpace(json, end) === ":") frame.key = decodeKey(json.slice(i, end));
      i = end;
      continue;
    }
    if (c === "{") stack.push({ kind: "object", key: null });
    else if (c === "[") stack.push({ kind: "array", key: top()?.key ?? null });
    else if (c === "}" || c === "]") stack.pop();
    else if (NUMBER_START.test(c)) {
      let end = i + 1;
      while (end < json.length && NUMBER_CHAR.test(json[end])) end++;
      const replacement = trimmed(json.slice(i, end), top()?.key ?? null);
      if (replacement !== null) {
        out += json.slice(last, i) + replacement;
        last = end;
      }
      i = end;
      continue;
    }
    i++;
  }
  return last === 0 ? json : out + json.slice(last);
}

/** True when the text holds at least one number trimEpochFractions might change (cheap pre-check). */
export function hasLongEpochFraction(json: string): boolean {
  return /\d{10}\.\d{4,}/.test(json);
}
