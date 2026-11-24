/** Pure helpers for the KMS definition: which key actions apply to a key (from a list row or a detail summary). */

/** Key facts the KMS actions depend on, from a list row (camelCase) or a detail summary (labels). */
export interface KeyFacts {
  state: string;
  spec: string;
  usage: string;
  origin: string;
  regionality: string;
  rotation: boolean | null;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function keyFacts(row: Record<string, unknown>): KeyFacts {
  const rot = row["Automatic key rotation"];
  return {
    state: str(row.status ?? row.Status),
    spec: str(row.keySpec ?? row["Key spec"]),
    usage: str(row.keyUsage ?? row["Key usage"]),
    origin: str(row.origin ?? row.Origin),
    regionality: str(row.regionality ?? row.Regionality),
    rotation: typeof rot === "boolean" ? rot : null,
  };
}

const usable = (f: KeyFacts): boolean => f.state === "" || f.state === "Enabled";
const symmetricEnc = (f: KeyFacts): boolean => f.spec === "" || f.spec === "SYMMETRIC_DEFAULT";
const rotatable = (f: KeyFacts): boolean => symmetricEnc(f) && (f.origin === "" || f.origin === "AWS_KMS");

/** availableFor() rules for the customer managed key actions; unknown facts count as "applies". */
export const KEY_ACTION_RULES: Record<string, (f: KeyFacts) => boolean> = {
  enable: (f) => f.state === "" || f.state === "Disabled",
  disable: (f) => f.state === "" || f.state === "Enabled",
  "schedule-deletion": (f) => f.state !== "PendingDeletion" && f.state !== "PendingReplicaDeletion",
  "cancel-deletion": (f) => f.state === "" || f.state === "PendingDeletion",
  "enable-rotation": (f) => rotatable(f) && usable(f),
  "rotate-now": (f) => rotatable(f) && usable(f),
  replicate: (f) => f.regionality === "" || f.regionality === "Multi-Region primary",
  encrypt: (f) => usable(f) && (f.usage === "" || f.usage === "ENCRYPT_DECRYPT"),
  decrypt: (f) => usable(f) && (f.usage === "" || f.usage === "ENCRYPT_DECRYPT"),
  "generate-data-key": (f) => usable(f) && (f.usage === "" || f.usage === "ENCRYPT_DECRYPT") && symmetricEnc(f),
  sign: (f) => usable(f) && (f.usage === "" || f.usage === "SIGN_VERIFY"),
  verify: (f) => usable(f) && (f.usage === "" || f.usage === "SIGN_VERIFY"),
  "generate-mac": (f) => usable(f) && (f.usage === "" || f.usage === "GENERATE_VERIFY_MAC"),
  "verify-mac": (f) => usable(f) && (f.usage === "" || f.usage === "GENERATE_VERIFY_MAC"),
};

export function keyActionAvailable(actionId: string, row: Record<string, unknown>): boolean {
  const rule = KEY_ACTION_RULES[actionId];
  return rule ? rule(keyFacts(row)) : true;
}
