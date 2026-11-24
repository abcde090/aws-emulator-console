/** Pure helpers for the Redshift console (no SDK calls, unit tested). */

export interface RsEndpoint {
  Address?: string;
  Port?: number;
}

export function endpointText(e: RsEndpoint | undefined | null): string | null {
  if (!e?.Address) return null;
  return e.Port !== undefined ? `${e.Address}:${e.Port}` : e.Address;
}

/** The JDBC URL the console shows on a cluster's General information panel. */
export function jdbcUrl(e: RsEndpoint | undefined | null, db: string | undefined): string | null {
  if (!e?.Address) return null;
  return `jdbc:redshift://${e.Address}:${e.Port ?? 5439}/${db ?? "dev"}`;
}

/** Total storage capacity is reported in MB; the console shows TB or GB. */
export function storageText(mb: number | undefined | null): string | null {
  if (typeof mb !== "number" || !Number.isFinite(mb)) return null;
  if (mb >= 1024 * 1024) return `${(mb / (1024 * 1024)).toFixed(1)} TB`;
  return `${(mb / 1024).toFixed(0)} GB`;
}

/**
 * Redshift admin passwords: 8-64 printable ASCII characters with at least one uppercase
 * letter, one lowercase letter and one number, and none of ' " \ / @ or space.
 */
export function passwordProblem(p: string): string | null {
  if (p.length < 8 || p.length > 64) return "The admin password must be 8-64 characters.";
  if (!/[A-Z]/.test(p) || !/[a-z]/.test(p) || !/[0-9]/.test(p)) return "The admin password needs an uppercase letter, a lowercase letter and a number.";
  if (/['"\\/@\s]/.test(p) || /[^\x21-\x7e]/.test(p)) return "The admin password can't contain ' \" \\ / @, spaces or non-printable characters.";
  return null;
}

export function splitList(v: unknown): string[] {
  if (typeof v !== "string") return [];
  return v.split(/[\s,]+/).map((s) => s.trim()).filter((s) => s !== "");
}

/** "available" / "paused" etc. The console capitalises the first letter. */
export function titleCase(v: string | undefined | null): string | null {
  if (!v) return null;
  return v.charAt(0).toUpperCase() + v.slice(1);
}
