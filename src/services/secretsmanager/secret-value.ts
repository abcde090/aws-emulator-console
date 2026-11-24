/** Pure helpers for secret values: key/value pairs <-> JSON SecretString. */

export type SecretValue = { kind: "kv"; pairs: { Key: string; Value: string }[] } | { kind: "plaintext"; text: string } | { kind: "binary"; bytes: number };

/** Builds the SecretString from the create form's key/value pairs or plaintext. */
export function secretStringFrom(type: "kv" | "plaintext", pairs: unknown, plaintext: unknown): string {
  if (type === "plaintext") {
    if (typeof plaintext !== "string" || plaintext === "") throw new Error("Enter the secret value.");
    return plaintext;
  }
  const list = Array.isArray(pairs) ? (pairs as { Key?: unknown; Value?: unknown }[]) : [];
  const obj: Record<string, string> = {};
  for (const p of list) {
    if (typeof p?.Key !== "string" || p.Key.trim() === "") continue;
    const key = p.Key.trim();
    if (key in obj) throw new Error(`The key "${key}" appears twice.`);
    obj[key] = typeof p.Value === "string" ? p.Value : "";
  }
  if (Object.keys(obj).length === 0) throw new Error("Add at least one key/value pair.");
  return JSON.stringify(obj);
}

/** Shows a SecretString as key/value pairs when it is a flat JSON object of scalars, otherwise as plaintext. */
export function parseSecretString(text: string): SecretValue {
  try {
    const v: unknown = JSON.parse(text);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const entries = Object.entries(v as Record<string, unknown>);
      if (entries.every(([, x]) => ["string", "number", "boolean"].includes(typeof x) || x === null)) {
        return { kind: "kv", pairs: entries.map(([Key, x]) => ({ Key, Value: x === null ? "null" : String(x) })) };
      }
    }
  } catch {
    // not JSON
  }
  return { kind: "plaintext", text };
}

/** The console's secret types. The database ones store the JSON the rotation templates expect. */
export type SecretType = "rds" | "docdb" | "redshift" | "otherdb" | "other";

export const SECRET_TYPES: { value: SecretType; label: string }[] = [
  { value: "rds", label: "Credentials for Amazon RDS database" },
  { value: "docdb", label: "Credentials for Amazon DocumentDB database" },
  { value: "redshift", label: "Credentials for Amazon Redshift data warehouse" },
  { value: "otherdb", label: "Credentials for other database" },
  { value: "other", label: "Other type of secret (API key, OAuth token, other)" },
];

export const DB_ENGINES = ["mysql", "postgres", "mariadb", "oracle", "sqlserver"] as const;

const DEFAULT_PORTS: Record<string, number> = { mysql: 3306, mariadb: 3306, postgres: 5432, oracle: 1521, sqlserver: 1433, mongo: 27017, redshift: 5439 };

export interface DatabaseSecretInput {
  username: unknown;
  password: unknown;
  engine: unknown;
  host: unknown;
  port: unknown;
  dbname: unknown;
}

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** {"username","password","engine","host","port","dbname"} for a database secret type. */
export function databaseSecretString(type: Exclude<SecretType, "other">, input: DatabaseSecretInput): string {
  const username = text(input.username);
  const password = typeof input.password === "string" ? input.password : "";
  if (!username) throw new Error("Enter the database user name.");
  if (!password) throw new Error("Enter the database password.");
  const engine = type === "docdb" ? "mongo" : type === "redshift" ? "redshift" : text(input.engine);
  if (!engine) throw new Error("Choose the database engine.");
  const host = text(input.host);
  if (!host) throw new Error("Enter the database server address.");
  const port = typeof input.port === "number" && Number.isInteger(input.port) && input.port > 0 ? input.port : DEFAULT_PORTS[engine];
  const out: Record<string, string | number> = { username, password, engine, host };
  if (port) out.port = port;
  const dbname = text(input.dbname);
  if (dbname) out.dbname = dbname;
  return JSON.stringify(out);
}
