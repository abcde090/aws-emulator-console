/**
 * Reads the dashboard's "act as" cookie. No cookie means the emulator admin. A cookie that
 * cannot be read is "invalid", which the simulator treats as deny-all, never as admin.
 */

export type IdentityCookie =
  | { type: "admin" }
  | { type: "user" | "role"; name: string }
  | { type: "invalid"; error: string };

const IAM_NAME = /^[\w+=,.@-]{1,128}$/;

export function parseIdentityCookie(raw: string | undefined): IdentityCookie {
  if (raw === undefined || raw === "") return { type: "admin" };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { type: "invalid", error: "identity cookie is not valid JSON" };
  }
  const v = value as { type?: unknown; name?: unknown } | null;
  if (!v || (v.type !== "user" && v.type !== "role") || typeof v.name !== "string" || !IAM_NAME.test(v.name)) {
    return { type: "invalid", error: "identity cookie does not name a user or role" };
  }
  return { type: v.type, name: v.name };
}
