/** Small helpers shared by the user pool and identity pool screens. */

export const s = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
export const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : []);
