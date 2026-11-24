/** Pure Athena helpers: result-set shaping and the editor's input checks. */

export interface ResultColumn {
  name: string;
  type: string | null;
}

export interface ResultSetLike {
  Rows?: { Data?: { VarCharValue?: string }[] }[];
  ResultSetMetadata?: { ColumnInfo?: { Name?: string; Label?: string; Type?: string }[] };
}

export interface ShapedResults {
  columns: ResultColumn[];
  rows: (string | null)[][];
}

/**
 * Turns GetQueryResults output into columns and rows. On the first page of a SELECT, Athena
 * repeats the column names as the first row; DDL/SHOW results don't. So the first row is
 * dropped only on the first page and only when it equals the column labels.
 */
export function shapeResults(rs: ResultSetLike | undefined, firstPage: boolean): ShapedResults {
  const info = rs?.ResultSetMetadata?.ColumnInfo ?? [];
  const columns = info.map((c, i) => ({ name: c.Label ?? c.Name ?? `_col${i}`, type: c.Type ?? null }));
  let rows = (rs?.Rows ?? []).map((r) => (r.Data ?? []).map((d) => (d.VarCharValue === undefined ? null : d.VarCharValue)));
  if (firstPage && rows.length > 0 && columns.length > 0) {
    const first = rows[0];
    if (first.length === columns.length && first.every((v, i) => v === columns[i].name)) rows = rows.slice(1);
  }
  // Results without metadata (rare) still get column headings.
  const width = Math.max(columns.length, ...rows.map((r) => r.length));
  const filled = columns.length >= width ? columns : [...columns, ...Array.from({ length: width - columns.length }, (_, i) => ({ name: `_col${columns.length + i}`, type: null }))];
  return { columns: filled, rows };
}

/** 1234 -> "1.23 sec"; 950 -> "950 ms". */
export function formatRunTime(ms: number | undefined | null): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) return "-";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} sec`;
}

export const TERMINAL_STATES = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);

export const MAX_QUERY_LENGTH = 262_144;
export const NAME_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
/** Glue database and catalog names. */
export const IDENT_PATTERN = /^[A-Za-z0-9_-]{1,255}$/;
/** Query execution and named-query ids are UUIDs. */
export const UUID_PATTERN = /^[0-9a-fA-F-]{36}$/;

export function checkSql(sql: unknown): string {
  if (typeof sql !== "string" || sql.trim() === "") throw new Error("Enter a query.");
  if (sql.length > MAX_QUERY_LENGTH) throw new Error("The query is longer than 256 KiB.");
  return sql;
}

export function checkName(v: unknown, what: string, pattern: RegExp = NAME_PATTERN): string {
  if (typeof v !== "string" || !pattern.test(v)) throw new Error(`${what} is not valid.`);
  return v;
}

export function optionalName(v: unknown, what: string, pattern: RegExp = IDENT_PATTERN): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  return checkName(v, what, pattern);
}
