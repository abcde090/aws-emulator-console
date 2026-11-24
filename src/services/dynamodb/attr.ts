/**
 * DynamoDB item helpers, pure and shared by the server actions and the item explorer.
 * Items travel between server and browser as "wire" DynamoDB JSON (the format the AWS CLI
 * prints): every value is an object with one type key, binary values are base64 text.
 */

export type ScalarType = "S" | "N" | "B" | "BOOL" | "NULL";
export type AttrType = ScalarType | "L" | "M" | "SS" | "NS" | "BS";

export type Wire =
  | { S: string }
  | { N: string }
  | { B: string }
  | { BOOL: boolean }
  | { NULL: true }
  | { L: Wire[] }
  | { M: Record<string, Wire> }
  | { SS: string[] }
  | { NS: string[] }
  | { BS: string[] };

export type WireItem = Record<string, Wire>;

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const TYPES: readonly AttrType[] = ["S", "N", "B", "BOOL", "NULL", "L", "M", "SS", "NS", "BS"];
const NUMBER = /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const MAX_DEPTH = 32;
export const TABLE_NAME = "[a-zA-Z0-9_.-]{3,255}";
const TABLE_NAME_RE = new RegExp(`^${TABLE_NAME}$`);

export const TYPE_LABELS: Record<AttrType, string> = {
  S: "String",
  N: "Number",
  B: "Binary",
  BOOL: "Boolean",
  NULL: "Null",
  L: "List",
  M: "Map",
  SS: "String set",
  NS: "Number set",
  BS: "Binary set",
};

export function isTableName(v: unknown): v is string {
  return typeof v === "string" && TABLE_NAME_RE.test(v);
}

export function isNumberText(v: string): boolean {
  return NUMBER.test(v.trim());
}

export function typeOf(w: Wire): AttrType {
  return Object.keys(w)[0] as AttrType;
}

function fail<T>(error: string): Parsed<T> {
  return { ok: false, error };
}

function parseSet(type: "SS" | "NS" | "BS", v: unknown, path: string): Parsed<Wire> {
  if (!Array.isArray(v) || v.length === 0) return fail(`${path}: a ${TYPE_LABELS[type]} needs at least one value`);
  if (!v.every((x) => typeof x === "string")) return fail(`${path}: set values must be strings`);
  const values = v as string[];
  if (new Set(values).size !== values.length) return fail(`${path}: set values must be unique`);
  if (type === "NS" && !values.every(isNumberText)) return fail(`${path}: every Number set value must be a number`);
  if (type === "BS" && !values.every((x) => BASE64.test(x))) return fail(`${path}: Binary set values must be base64`);
  return { ok: true, value: { [type]: values } as Wire };
}

/** Checks one DynamoDB JSON value, e.g. {"S":"x"} or {"M":{...}}. */
export function parseWire(v: unknown, path = "value", depth = 0): Parsed<Wire> {
  if (depth > MAX_DEPTH) return fail(`${path}: nested too deeply`);
  if (v === null || typeof v !== "object" || Array.isArray(v)) return fail(`${path}: expected an object such as {"S": "text"}`);
  const keys = Object.keys(v);
  if (keys.length !== 1 || !TYPES.includes(keys[0] as AttrType)) return fail(`${path}: expected exactly one type key (${TYPES.join(", ")})`);
  const type = keys[0] as AttrType;
  const inner = (v as Record<string, unknown>)[type];
  switch (type) {
    case "S":
      return typeof inner === "string" ? { ok: true, value: { S: inner } } : fail(`${path}: S must be a string`);
    case "N":
      return typeof inner === "string" && isNumberText(inner) ? { ok: true, value: { N: inner.trim() } } : fail(`${path}: N must be a number written as a string, e.g. {"N": "42"}`);
    case "B":
      return typeof inner === "string" && BASE64.test(inner) ? { ok: true, value: { B: inner } } : fail(`${path}: B must be base64 text`);
    case "BOOL":
      return typeof inner === "boolean" ? { ok: true, value: { BOOL: inner } } : fail(`${path}: BOOL must be true or false`);
    case "NULL":
      return inner === true ? { ok: true, value: { NULL: true } } : fail(`${path}: NULL must be true`);
    case "L": {
      if (!Array.isArray(inner)) return fail(`${path}: L must be a list`);
      const out: Wire[] = [];
      for (let i = 0; i < inner.length; i++) {
        const p = parseWire(inner[i], `${path}[${i}]`, depth + 1);
        if (!p.ok) return p;
        out.push(p.value);
      }
      return { ok: true, value: { L: out } };
    }
    case "M": {
      const m = parseWireItem(inner, path, depth + 1);
      return m.ok ? { ok: true, value: { M: m.value } } : m;
    }
    default:
      return parseSet(type, inner, path);
  }
}

/** Checks a whole item in DynamoDB JSON: {"attr": {"S": "x"}, ...}. */
export function parseWireItem(v: unknown, path = "item", depth = 0): Parsed<WireItem> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return fail(`${path}: expected a JSON object`);
  const out: WireItem = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (k === "") return fail(`${path}: attribute names can't be empty`);
    const p = parseWire(val, path === "item" ? k : `${path}.${k}`, depth);
    if (!p.ok) return p;
    out[k] = p.value;
  }
  return { ok: true, value: out };
}

/** DynamoDB JSON to plain JSON (sets become arrays, binary stays base64 text). */
export function wireToPlain(w: Wire): unknown {
  if ("S" in w) return w.S;
  if ("N" in w) {
    const n = Number(w.N);
    // Numbers that JSON can't hold exactly (big or oddly written) stay as their text.
    return Number.isFinite(n) && String(n) === w.N ? n : w.N;
  }
  if ("B" in w) return w.B;
  if ("BOOL" in w) return w.BOOL;
  if ("NULL" in w) return null;
  if ("L" in w) return w.L.map(wireToPlain);
  if ("M" in w) return itemToPlain(w.M);
  if ("SS" in w) return [...w.SS];
  if ("NS" in w) return w.NS.map((n) => wireToPlain({ N: n }));
  return [...w.BS];
}

export function itemToPlain(item: WireItem): Record<string, unknown> {
  return Object.fromEntries(Object.entries(item).map(([k, v]) => [k, wireToPlain(v)]));
}

/** Plain JSON to DynamoDB JSON, as the console's normal JSON view does. */
export function plainToWire(v: unknown, path = "value", depth = 0): Parsed<Wire> {
  if (depth > MAX_DEPTH) return fail(`${path}: nested too deeply`);
  if (v === null) return { ok: true, value: { NULL: true } };
  if (typeof v === "string") return { ok: true, value: { S: v } };
  if (typeof v === "boolean") return { ok: true, value: { BOOL: v } };
  if (typeof v === "number") return Number.isFinite(v) ? { ok: true, value: { N: String(v) } } : fail(`${path}: not a finite number`);
  if (Array.isArray(v)) {
    const out: Wire[] = [];
    for (let i = 0; i < v.length; i++) {
      const p = plainToWire(v[i], `${path}[${i}]`, depth + 1);
      if (!p.ok) return p;
      out.push(p.value);
    }
    return { ok: true, value: { L: out } };
  }
  if (typeof v === "object") {
    const m = plainToItem(v, path, depth + 1);
    return m.ok ? { ok: true, value: { M: m.value } } : m;
  }
  return fail(`${path}: unsupported value`);
}

export function plainToItem(v: unknown, path = "item", depth = 0): Parsed<WireItem> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return fail(`${path}: expected a JSON object`);
  const out: WireItem = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (k === "") return fail(`${path}: attribute names can't be empty`);
    const p = plainToWire(val, path === "item" ? k : `${path}.${k}`, depth);
    if (!p.ok) return p;
    out[k] = p.value;
  }
  return { ok: true, value: out };
}

/** True when plain JSON can't hold the item exactly (sets, binary). */
export function needsDynamoJson(item: WireItem): boolean {
  return Object.values(item).some(wireNeedsDynamoJson);
}

function wireNeedsDynamoJson(w: Wire): boolean {
  const t = typeOf(w);
  if (t === "SS" || t === "NS" || t === "BS" || t === "B") return true;
  if ("L" in w) return w.L.some(wireNeedsDynamoJson);
  if ("M" in w) return Object.values(w.M).some(wireNeedsDynamoJson);
  return false;
}

/** How a value is shown in an item table cell. */
export function displayValue(w: Wire | undefined): string {
  if (!w) return "";
  if ("S" in w) return w.S;
  if ("N" in w) return w.N;
  if ("BOOL" in w) return w.BOOL ? "true" : "false";
  if ("NULL" in w) return "null";
  if ("B" in w) return w.B;
  return JSON.stringify(wireToPlain(w));
}

/** A key or filter value typed into a text box. */
export function scalarWire(type: ScalarType, raw: string, label: string): Parsed<Wire> {
  switch (type) {
    case "S":
      return { ok: true, value: { S: raw } };
    case "N":
      return isNumberText(raw) ? { ok: true, value: { N: raw.trim() } } : fail(`${label}: "${raw}" is not a number`);
    case "B":
      return raw !== "" && BASE64.test(raw.trim()) ? { ok: true, value: { B: raw.trim() } } : fail(`${label}: enter base64 text`);
    case "BOOL":
      return raw === "true" || raw === "false" ? { ok: true, value: { BOOL: raw === "true" } } : fail(`${label}: enter true or false`);
    case "NULL":
      return { ok: true, value: { NULL: true } };
  }
}

export function keyOf(item: WireItem, keyNames: string[]): Parsed<WireItem> {
  const key: WireItem = {};
  for (const k of keyNames) {
    const v = item[k];
    if (!v) return fail(`The item has no value for key attribute ${k}.`);
    key[k] = v;
  }
  return { ok: true, value: key };
}

export function sameKey(a: WireItem, b: WireItem, keyNames: string[]): boolean {
  return keyNames.every((k) => JSON.stringify(a[k] ?? null) === JSON.stringify(b[k] ?? null));
}

/** Key attributes first (partition, then sort), then the rest in name order. */
export function itemColumns(items: WireItem[], keyNames: string[]): string[] {
  const others = new Set<string>();
  for (const it of items) for (const k of Object.keys(it)) if (!keyNames.includes(k)) others.add(k);
  return [...keyNames, ...[...others].sort((a, b) => a.localeCompare(b))];
}

// ---- Expressions ----

export type KeyOp = "=" | "<" | "<=" | ">" | ">=" | "between" | "begins_with";
export type FilterOp = KeyOp | "<>" | "contains" | "not_contains" | "exists" | "not_exists";

export interface Condition {
  attr: string;
  type: ScalarType;
  op: FilterOp;
  value: string;
  value2?: string;
}

export interface Expression {
  expression: string;
  names: Record<string, string>;
  values: WireItem;
}

export const KEY_OPS: KeyOp[] = ["=", "<", "<=", ">", ">=", "between", "begins_with"];
export const FILTER_OPS: FilterOp[] = ["=", "<>", "<", "<=", ">", ">=", "between", "begins_with", "contains", "not_contains", "exists", "not_exists"];

export const OP_LABELS: Record<FilterOp, string> = {
  "=": "Equal to",
  "<>": "Not equal to",
  "<": "Less than",
  "<=": "Less than or equal to",
  ">": "Greater than",
  ">=": "Greater than or equal to",
  between: "Between",
  begins_with: "Begins with",
  contains: "Contains",
  not_contains: "Not contains",
  exists: "Exists",
  not_exists: "Not exists",
};

class ExpressionBuilder {
  names: Record<string, string> = {};
  values: WireItem = {};
  private n = 0;
  private v = 0;
  private readonly prefix: string;
  constructor(prefix: string) {
    this.prefix = prefix;
  }
  name(attr: string): string {
    const found = Object.entries(this.names).find(([, a]) => a === attr);
    if (found) return found[0];
    const key = `#${this.prefix}${this.n++}`;
    this.names[key] = attr;
    return key;
  }
  value(w: Wire): string {
    const key = `:${this.prefix}${this.v++}`;
    this.values[key] = w;
    return key;
  }
}

function conditionText(b: ExpressionBuilder, c: Condition, label: string): Parsed<string> {
  if (c.attr.trim() === "") return fail(`${label}: enter an attribute name`);
  const name = b.name(c.attr.trim());
  if (c.op === "exists") return { ok: true, value: `attribute_exists(${name})` };
  if (c.op === "not_exists") return { ok: true, value: `attribute_not_exists(${name})` };
  const first = scalarWire(c.type, c.value, label);
  if (!first.ok) return first;
  const v1 = b.value(first.value);
  switch (c.op) {
    case "between": {
      const second = scalarWire(c.type, c.value2 ?? "", label);
      if (!second.ok) return second;
      return { ok: true, value: `${name} BETWEEN ${v1} AND ${b.value(second.value)}` };
    }
    case "begins_with":
      return { ok: true, value: `begins_with(${name}, ${v1})` };
    case "contains":
      return { ok: true, value: `contains(${name}, ${v1})` };
    case "not_contains":
      return { ok: true, value: `NOT contains(${name}, ${v1})` };
    default:
      return { ok: true, value: `${name} ${c.op} ${v1}` };
  }
}

/** KeyConditionExpression for a Query: partition key equals, optional sort key condition. */
export function buildKeyCondition(pk: { attr: string; type: ScalarType; value: string }, sk: Condition | null): Parsed<Expression> {
  const b = new ExpressionBuilder("k");
  if (pk.value === "") return fail(`Enter a value for the partition key ${pk.attr}.`);
  const first = conditionText(b, { attr: pk.attr, type: pk.type, op: "=", value: pk.value }, `Partition key ${pk.attr}`);
  if (!first.ok) return first;
  const parts = [first.value];
  if (sk && (sk.value !== "" || sk.op === "between")) {
    if (!KEY_OPS.includes(sk.op as KeyOp)) return fail(`Sort key condition "${sk.op}" can't be used in a query.`);
    const second = conditionText(b, sk, `Sort key ${sk.attr}`);
    if (!second.ok) return second;
    parts.push(second.value);
  }
  return { ok: true, value: { expression: parts.join(" AND "), names: b.names, values: b.values } };
}

/** FilterExpression from the explorer's filter rows, joined with AND. Null when there are none. */
export function buildFilter(conditions: Condition[]): Parsed<Expression | null> {
  const b = new ExpressionBuilder("f");
  const parts: string[] = [];
  for (let i = 0; i < conditions.length; i++) {
    const c = conditions[i];
    if (c.attr.trim() === "") continue;
    if (!FILTER_OPS.includes(c.op)) return fail(`Filter ${i + 1}: unknown condition ${c.op}`);
    const t = conditionText(b, c, `Filter ${i + 1}`);
    if (!t.ok) return t;
    parts.push(t.value);
  }
  if (parts.length === 0) return { ok: true, value: null };
  return { ok: true, value: { expression: parts.join(" AND "), names: b.names, values: b.values } };
}

// ---- Form view ----

export interface FormRow {
  name: string;
  type: AttrType;
  value: string;
}

/** One form row per attribute; lists, maps and sets are edited as JSON text. */
export function itemToFormRows(item: WireItem): FormRow[] {
  return Object.entries(item).map(([name, w]) => {
    const type = typeOf(w);
    let value: string;
    if ("S" in w) value = w.S;
    else if ("N" in w) value = w.N;
    else if ("B" in w) value = w.B;
    else if ("BOOL" in w) value = String(w.BOOL);
    else if ("NULL" in w) value = "";
    else if ("L" in w || "M" in w) value = JSON.stringify(w, null, 2);
    else value = JSON.stringify(Object.values(w)[0]);
    return { name, type, value };
  });
}

/** Builds an item from form rows; lists and maps take DynamoDB JSON, sets a JSON array. */
export function formRowsToItem(rows: FormRow[]): Parsed<WireItem> {
  const item: WireItem = {};
  for (const r of rows) {
    const name = r.name.trim();
    if (name === "") return fail("Every attribute needs a name.");
    if (item[name]) return fail(`Attribute ${name} appears twice.`);
    if (r.type === "S" || r.type === "N" || r.type === "B" || r.type === "BOOL" || r.type === "NULL") {
      const w = scalarWire(r.type, r.value, name);
      if (!w.ok) return w;
      item[name] = w.value;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.value);
    } catch {
      return fail(`${name}: not valid JSON`);
    }
    const w = r.type === "L" || r.type === "M" ? parseWire(parsed, name) : parseWire({ [r.type]: parsed }, name);
    if (!w.ok) return w;
    if (typeOf(w.value) !== r.type) return fail(`${name}: expected a ${TYPE_LABELS[r.type]} such as {"${r.type}": ...}`);
    item[name] = w.value;
  }
  return { ok: true, value: item };
}
