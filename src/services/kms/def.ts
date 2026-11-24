/**
 * AWS KMS: customer managed keys (create symmetric / asymmetric / HMAC keys with alias,
 * administrators, users and key policy; rotation, aliases, grants, tags, cryptographic test
 * actions), AWS managed keys and custom key stores. The key policy editor is on the
 * hand-built key page (src/app/kms/keys/[id]).
 */

import {
  CancelKeyDeletionCommand,
  CreateAliasCommand,
  CreateGrantCommand,
  CreateKeyCommand,
  DecryptCommand,
  DeleteAliasCommand,
  DescribeCustomKeyStoresCommand,
  DescribeKeyCommand,
  DisableKeyCommand,
  DisableKeyRotationCommand,
  EnableKeyCommand,
  EnableKeyRotationCommand,
  EncryptCommand,
  GenerateDataKeyCommand,
  GenerateMacCommand,
  GetKeyPolicyCommand,
  GetKeyRotationStatusCommand,
  GetPublicKeyCommand,
  ListAliasesCommand,
  ListGrantsCommand,
  ListKeyRotationsCommand,
  ListKeysCommand,
  ListResourceTagsCommand,
  ReplicateKeyCommand,
  RetireGrantCommand,
  RevokeGrantCommand,
  RotateKeyOnDemandCommand,
  ScheduleKeyDeletionCommand,
  SignCommand,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateKeyDescriptionCommand,
  VerifyCommand,
  VerifyMacCommand,
  type AliasListEntry,
  type GrantListEntry,
  type GrantOperation,
  type KeyMetadata,
  type KeySpec,
  type MacAlgorithmSpec,
  type SigningAlgorithmSpec,
} from "@aws-sdk/client-kms";
import type { ActionDef, Ctx, Detail, FieldValues, Option, ResourceDef, Row, ServiceDef, Tag } from "../../console/types.ts";
import { principalArnOptions } from "../iam/common.ts";
import { prettyPolicy } from "../iam/policy-json.ts";
import { defaultKeyPolicy, keyTypeOf, type KeyUsageChoice } from "./key-policy.ts";
import { keyActionAvailable } from "./edit-helpers.ts";
import { secondary, unavailableText } from "../../console/secondary.ts";
import { fieldTags, tagDiff, tagDiffMessage } from "../../console/tags.ts";
import { CONSOLE_REGIONS } from "../../lib/regions.ts";

const ALIAS = "[a-zA-Z0-9/_-]{1,250}";

async function allKeys(ctx: Ctx): Promise<string[]> {
  const ids: string[] = [];
  let marker: string | undefined;
  do {
    const r = await ctx.clients.kms.send(new ListKeysCommand({ Marker: marker, Limit: 1000 }));
    ids.push(...(r.Keys ?? []).map((k) => k.KeyId ?? "").filter(Boolean));
    marker = r.Truncated ? r.NextMarker : undefined;
  } while (marker);
  return ids;
}

async function allAliases(ctx: Ctx, keyId?: string): Promise<AliasListEntry[]> {
  const out: AliasListEntry[] = [];
  let marker: string | undefined;
  do {
    const r = await ctx.clients.kms.send(new ListAliasesCommand({ KeyId: keyId, Marker: marker, Limit: 100 }));
    out.push(...(r.Aliases ?? []));
    marker = r.Truncated ? r.NextMarker : undefined;
  } while (marker);
  return out;
}

async function describe(ctx: Ctx, keyId: string): Promise<KeyMetadata> {
  const r = await ctx.clients.kms.send(new DescribeKeyCommand({ KeyId: keyId }));
  if (!r.KeyMetadata) throw new Error(`KMS returned no metadata for ${keyId}.`);
  return r.KeyMetadata;
}

async function allKeyTags(ctx: Ctx, keyId: string): Promise<Tag[]> {
  const out: Tag[] = [];
  let marker: string | undefined;
  do {
    const r = await ctx.clients.kms.send(new ListResourceTagsCommand({ KeyId: keyId, Marker: marker, Limit: 50 }));
    out.push(...(r.Tags ?? []).map((t) => ({ Key: t.TagKey ?? "", Value: t.TagValue ?? "" })));
    marker = r.Truncated ? r.NextMarker : undefined;
  } while (marker);
  return out;
}

async function allGrants(ctx: Ctx, keyId: string): Promise<GrantListEntry[]> {
  const out: GrantListEntry[] = [];
  let marker: string | undefined;
  do {
    const r = await ctx.clients.kms.send(new ListGrantsCommand({ KeyId: keyId, Marker: marker, Limit: 100 }));
    out.push(...(r.Grants ?? []));
    marker = r.Truncated ? r.NextMarker : undefined;
  } while (marker);
  return out;
}

const withAvailability = (a: ActionDef): ActionDef => ({ ...a, availableFor: (row: Row) => keyActionAvailable(a.id, row) });
const withKeyAvailability = (actions: ActionDef[]): ActionDef[] => actions.map(withAvailability);

const b64 = (u: Uint8Array | undefined): string | null => (u ? Buffer.from(u).toString("base64") : null);
const s = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

function regionality(m: KeyMetadata): string {
  if (!m.MultiRegion) return "Single-Region";
  return m.MultiRegionConfiguration?.MultiRegionKeyType === "REPLICA" ? "Multi-Region replica" : "Multi-Region primary";
}

async function keyRows(ctx: Ctx, manager: "CUSTOMER" | "AWS"): Promise<Row[]> {
  const [ids, aliasLookup] = await Promise.all([allKeys(ctx), secondary(allAliases(ctx))]);
  // Aliases are secondary: a denied ListAliases still lists the keys.
  const aliases = aliasLookup.ok ? aliasLookup.value : [];
  const noAlias = aliasLookup.ok ? "-" : "(aliases unavailable)";
  const metas = await Promise.all(ids.map((id) => describe(ctx, id)));
  return metas
    .filter((m) => m.KeyManager === manager)
    .map((m) => ({
      keyId: m.KeyId ?? "",
      aliases: aliases.filter((a) => a.TargetKeyId === m.KeyId).map((a) => a.AliasName).join(", ") || noAlias,
      status: m.KeyState ?? null,
      keyType: keyTypeOf(m.KeySpec),
      keySpec: m.KeySpec ?? null,
      keyUsage: m.KeyUsage ?? null,
      origin: m.Origin ?? null,
      regionality: regionality(m),
      created: m.CreationDate ?? null,
      description: m.Description ?? "",
      arn: m.Arn ?? null,
    }));
}

async function keyDetail(ctx: Ctx, keyId: string, editable: boolean): Promise<Detail> {
  const kms = ctx.clients.kms;
  const m = await describe(ctx, keyId);
  const id = m.KeyId ?? keyId;
  const symmetric = m.KeySpec === "SYMMETRIC_DEFAULT";
  const rotatable = symmetric && m.Origin === "AWS_KMS";
  // Everything after DescribeKey is secondary: a denied lookup marks its tab unavailable.
  const [aliasR, policyR, rotationR, rotationsR, tagsR, grantsR, pubR] = await Promise.all([
    secondary(allAliases(ctx, id)),
    secondary(kms.send(new GetKeyPolicyCommand({ KeyId: id, PolicyName: "default" }))),
    rotatable ? secondary(kms.send(new GetKeyRotationStatusCommand({ KeyId: id }))) : Promise.resolve(null),
    rotatable ? secondary(kms.send(new ListKeyRotationsCommand({ KeyId: id }))) : Promise.resolve(null),
    editable ? secondary(allKeyTags(ctx, id)) : Promise.resolve(null),
    secondary(allGrants(ctx, id)),
    !symmetric && !m.KeySpec?.startsWith("HMAC_") && m.KeyState === "Enabled" ? secondary(kms.send(new GetPublicKeyCommand({ KeyId: id }))) : Promise.resolve(null),
  ]);
  const aliases = aliasR.ok ? aliasR.value : [];
  const rotation = rotationR?.ok ? rotationR.value : null;
  const pub = pubR?.ok ? pubR.value : null;
  const tabs: Detail["tabs"] = [
    {
      id: "crypto",
      label: "Cryptographic configuration",
      kind: "keyvalue",
      data: {
        "Key type": keyTypeOf(m.KeySpec),
        "Key spec": m.KeySpec ?? null,
        "Key usage": m.KeyUsage ?? null,
        Origin: m.Origin ?? null,
        Regionality: regionality(m),
        "Encryption algorithms": (m.EncryptionAlgorithms ?? []).join(", ") || null,
        "Signing algorithms": (m.SigningAlgorithms ?? []).join(", ") || null,
        "MAC algorithms": (m.MacAlgorithms ?? []).join(", ") || null,
        "Key agreement algorithms": (m.KeyAgreementAlgorithms ?? []).join(", ") || null,
        "Custom key store ID": m.CustomKeyStoreId ?? null,
      },
    },
    policyR.ok
      ? { id: "policy", label: "Key policy (JSON)", kind: "json", data: JSON.parse(prettyPolicy(policyR.value.Policy) || "null") as unknown }
      : { id: "policy", label: "Key policy (JSON)", kind: "text", data: "", description: `Unavailable: ${policyR.error}` },
  ];
  if (rotationR && !rotationR.ok) tabs.push({ id: "rotation", label: "Key rotation", kind: "text", data: "", description: `Unavailable: ${rotationR.error}` });
  if (rotation) {
    tabs.push({
      id: "rotation",
      label: "Key rotation",
      kind: "keyvalue",
      data: {
        "Automatic key rotation": rotation.KeyRotationEnabled === true,
        "Rotation period (days)": rotation.RotationPeriodInDays ?? null,
        "Next rotation date": rotation.NextRotationDate ?? null,
        "On-demand rotation start date": rotation.OnDemandRotationStartDate ?? null,
      },
    });
    tabs.push({
      id: "rotations",
      label: "Rotation history",
      kind: "table",
      columns: [
        { key: "date", label: "Date of rotation", kind: "date" },
        { key: "type", label: "Rotation type", kind: "text" },
        { key: "material", label: "Key material ID", kind: "code" },
      ],
      description: rotationsR ? unavailableText(rotationsR) : undefined,
      data: (rotationsR?.ok ? rotationsR.value.Rotations ?? [] : []).map((r) => ({ date: r.RotationDate ?? null, type: r.RotationType ?? null, material: (r as { KeyMaterialId?: string }).KeyMaterialId ?? null })),
      emptyText: "This key has not been rotated.",
    });
  }
  tabs.push({
    id: "aliases",
    label: "Aliases",
    kind: "table",
    columns: [
      { key: "AliasName", label: "Alias name", kind: "text" },
      { key: "AliasArn", label: "Alias ARN", kind: "arn" },
      { key: "CreationDate", label: "Created", kind: "date" },
    ],
    description: unavailableText(aliasR),
    data: aliases.map((a) => ({ AliasName: a.AliasName ?? "", AliasArn: a.AliasArn ?? null, CreationDate: a.CreationDate ?? null })),
    emptyText: "No aliases.",
  });
  tabs.push({
    id: "grants",
    label: "Grants",
    kind: "table",
    columns: [
      { key: "name", label: "Grant name", kind: "text" },
      { key: "id", label: "Grant ID", kind: "code" },
      { key: "grantee", label: "Grantee principal", kind: "arn" },
      { key: "operations", label: "Operations", kind: "text" },
      { key: "created", label: "Created", kind: "date" },
    ],
    description: unavailableText(grantsR),
    data: (grantsR.ok ? grantsR.value : []).map((g) => ({ name: g.Name ?? "", id: g.GrantId ?? "", grantee: g.GranteePrincipal ?? null, operations: (g.Operations ?? []).join(", "), created: g.CreationDate ?? null })),
    emptyText: "No grants.",
  });
  if (pub) tabs.push({ id: "public-key", label: "Public key", kind: "text", data: `-----BEGIN PUBLIC KEY-----\n${(b64(pub.PublicKey) ?? "").replace(/(.{64})/g, "$1\n")}\n-----END PUBLIC KEY-----` });
  if (m.MultiRegion) {
    const cfg = m.MultiRegionConfiguration;
    tabs.push({
      id: "regionality",
      label: "Regionality",
      kind: "table",
      columns: [
        { key: "region", label: "Region", kind: "text" },
        { key: "type", label: "Key type", kind: "text" },
        { key: "arn", label: "ARN", kind: "arn" },
      ],
      data: [
        ...(cfg?.PrimaryKey ? [{ region: cfg.PrimaryKey.Region ?? "", type: "Primary", arn: cfg.PrimaryKey.Arn ?? null }] : []),
        ...(cfg?.ReplicaKeys ?? []).map((r) => ({ region: r.Region ?? "", type: "Replica", arn: r.Arn ?? null })),
      ],
    });
  }
  if (tagsR) {
    tabs.push({
      id: "tags",
      label: "Tags",
      kind: "table",
      columns: [{ key: "TagKey", label: "Key", kind: "text" }, { key: "TagValue", label: "Value", kind: "text" }],
      data: (tagsR.ok ? tagsR.value : []).map((t) => ({ TagKey: t.Key, TagValue: t.Value })),
      description: unavailableText(tagsR),
      emptyText: "No tags.",
    });
  }
  return {
    summary: {
      Alias: aliases.map((a) => a.AliasName).join(", ") || (aliasR.ok ? "-" : "(aliases unavailable)"),
      Status: m.KeyState ?? null,
      ARN: m.Arn ?? null,
      Description: m.Description || null,
      "Creation date": m.CreationDate ?? null,
      "Deletion date": m.DeletionDate ?? null,
      "Key ID": id,
      "Key manager": m.KeyManager === "AWS" ? "AWS managed" : "Customer managed",
      "Key spec": m.KeySpec ?? null,
      "Key usage": m.KeyUsage ?? null,
      Origin: m.Origin ?? null,
      Regionality: regionality(m),
      ...(rotation ? { "Automatic key rotation": rotation.KeyRotationEnabled === true } : {}),
    },
    tabs,
  };
}

async function keyOptions(ctx: Ctx): Promise<Option[]> {
  return (await keyRows(ctx, "CUSTOMER")).map((r) => ({ value: String(r.keyId), label: `${r.aliases} (${r.keyId})` }));
}

const KEY_CONFIGS: { value: string; label: string; usage: KeyUsageChoice; symmetric: boolean }[] = [
  { value: "sym-enc", label: "Symmetric - Encrypt and decrypt: a single key used for encrypting and decrypting data", usage: "ENCRYPT_DECRYPT", symmetric: true },
  { value: "hmac", label: "Symmetric - Generate and verify MAC: an HMAC key used to generate and verify message authentication codes", usage: "GENERATE_VERIFY_MAC", symmetric: true },
  { value: "asym-enc", label: "Asymmetric - Encrypt and decrypt: a public and private key pair", usage: "ENCRYPT_DECRYPT", symmetric: false },
  { value: "asym-sign", label: "Asymmetric - Sign and verify: a public and private key pair for digital signatures", usage: "SIGN_VERIFY", symmetric: false },
  { value: "agree", label: "Asymmetric - Key agreement: derive shared secrets", usage: "KEY_AGREEMENT", symmetric: false },
];

const opts = (xs: string[]): Option[] => xs.map((x) => ({ value: x, label: x }));

function specFor(v: FieldValues): KeySpec {
  switch (v.keyConfig) {
    case "sym-enc":
      return "SYMMETRIC_DEFAULT";
    case "hmac":
      return String(v.hmacSpec || "HMAC_256") as KeySpec;
    case "asym-enc":
      return String(v.encSpec || "RSA_2048") as KeySpec;
    case "asym-sign":
      return String(v.signSpec || "RSA_2048") as KeySpec;
    case "agree":
      return String(v.agreeSpec || "ECC_NIST_P256") as KeySpec;
    default:
      throw new Error("Choose a key type and usage.");
  }
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : []);

const cryptoActions: ActionDef[] = [
  {
    id: "encrypt",
    label: "Encrypt (test)",
    fields: [{ name: "plaintext", label: "Plaintext", kind: "textarea", required: true, help: "UTF-8 text, up to 4 KB. Symmetric or asymmetric ENCRYPT_DECRYPT keys." }, { name: "algorithm", label: "Encryption algorithm", kind: "select", options: opts(["SYMMETRIC_DEFAULT", "RSAES_OAEP_SHA_1", "RSAES_OAEP_SHA_256", "SM2PKE"]), default: "SYMMETRIC_DEFAULT", required: true }],
    async run(ctx, id, v) {
      const r = await ctx.clients.kms.send(new EncryptCommand({ KeyId: id, Plaintext: Buffer.from(String(v.plaintext ?? ""), "utf8"), EncryptionAlgorithm: s(v.algorithm) as "SYMMETRIC_DEFAULT" }));
      return { message: "Encrypted. Copy the base64 ciphertext to try Decrypt.", json: { KeyId: r.KeyId, EncryptionAlgorithm: r.EncryptionAlgorithm, CiphertextBlob: b64(r.CiphertextBlob) } };
    },
  },
  {
    id: "decrypt",
    label: "Decrypt (test)",
    fields: [{ name: "ciphertext", label: "Ciphertext (base64)", kind: "textarea", required: true }, { name: "algorithm", label: "Encryption algorithm", kind: "select", options: opts(["SYMMETRIC_DEFAULT", "RSAES_OAEP_SHA_1", "RSAES_OAEP_SHA_256", "SM2PKE"]), default: "SYMMETRIC_DEFAULT", required: true }],
    async run(ctx, id, v) {
      const r = await ctx.clients.kms.send(new DecryptCommand({ KeyId: id, CiphertextBlob: Buffer.from(s(v.ciphertext), "base64"), EncryptionAlgorithm: s(v.algorithm) as "SYMMETRIC_DEFAULT" }));
      return { message: "Decrypted.", json: { KeyId: r.KeyId, EncryptionAlgorithm: r.EncryptionAlgorithm, Plaintext: r.Plaintext ? Buffer.from(r.Plaintext).toString("utf8") : null } };
    },
  },
  {
    id: "generate-data-key",
    label: "Generate data key (test)",
    fields: [{ name: "spec", label: "Data key spec", kind: "select", required: true, options: opts(["AES_256", "AES_128"]), default: "AES_256" }],
    async run(ctx, id, v) {
      const r = await ctx.clients.kms.send(new GenerateDataKeyCommand({ KeyId: id, KeySpec: s(v.spec) as "AES_256" }));
      return { message: "Data key generated (envelope encryption): use the plaintext key locally, store the encrypted copy.", json: { KeyId: r.KeyId, Plaintext: b64(r.Plaintext), CiphertextBlob: b64(r.CiphertextBlob) } };
    },
  },
  {
    id: "sign",
    label: "Sign (test)",
    fields: [{ name: "message", label: "Message", kind: "textarea", required: true }, { name: "algorithm", label: "Signing algorithm", kind: "select", required: true, options: opts(["RSASSA_PSS_SHA_256", "RSASSA_PSS_SHA_384", "RSASSA_PSS_SHA_512", "RSASSA_PKCS1_V1_5_SHA_256", "RSASSA_PKCS1_V1_5_SHA_384", "RSASSA_PKCS1_V1_5_SHA_512", "ECDSA_SHA_256", "ECDSA_SHA_384", "ECDSA_SHA_512"]) }],
    async run(ctx, id, v) {
      const r = await ctx.clients.kms.send(new SignCommand({ KeyId: id, Message: Buffer.from(String(v.message ?? ""), "utf8"), MessageType: "RAW", SigningAlgorithm: s(v.algorithm) as SigningAlgorithmSpec }));
      return { message: "Signed.", json: { SigningAlgorithm: r.SigningAlgorithm, Signature: b64(r.Signature) } };
    },
  },
  {
    id: "verify",
    label: "Verify signature (test)",
    fields: [{ name: "message", label: "Message", kind: "textarea", required: true }, { name: "signature", label: "Signature (base64)", kind: "textarea", required: true }, { name: "algorithm", label: "Signing algorithm", kind: "select", required: true, options: opts(["RSASSA_PSS_SHA_256", "RSASSA_PSS_SHA_384", "RSASSA_PSS_SHA_512", "RSASSA_PKCS1_V1_5_SHA_256", "RSASSA_PKCS1_V1_5_SHA_384", "RSASSA_PKCS1_V1_5_SHA_512", "ECDSA_SHA_256", "ECDSA_SHA_384", "ECDSA_SHA_512"]) }],
    async run(ctx, id, v) {
      const r = await ctx.clients.kms.send(new VerifyCommand({ KeyId: id, Message: Buffer.from(String(v.message ?? ""), "utf8"), MessageType: "RAW", Signature: Buffer.from(s(v.signature), "base64"), SigningAlgorithm: s(v.algorithm) as SigningAlgorithmSpec }));
      return { message: r.SignatureValid ? "The signature is valid." : "The signature is not valid." };
    },
  },
  {
    id: "generate-mac",
    label: "Generate MAC (test)",
    fields: [{ name: "message", label: "Message", kind: "textarea", required: true }, { name: "algorithm", label: "MAC algorithm", kind: "select", required: true, options: opts(["HMAC_SHA_224", "HMAC_SHA_256", "HMAC_SHA_384", "HMAC_SHA_512"]) }],
    async run(ctx, id, v) {
      const r = await ctx.clients.kms.send(new GenerateMacCommand({ KeyId: id, Message: Buffer.from(String(v.message ?? ""), "utf8"), MacAlgorithm: s(v.algorithm) as MacAlgorithmSpec }));
      return { message: "MAC generated.", json: { MacAlgorithm: r.MacAlgorithm, Mac: b64(r.Mac) } };
    },
  },
  {
    id: "verify-mac",
    label: "Verify MAC (test)",
    fields: [{ name: "message", label: "Message", kind: "textarea", required: true }, { name: "mac", label: "MAC (base64)", kind: "text", required: true }, { name: "algorithm", label: "MAC algorithm", kind: "select", required: true, options: opts(["HMAC_SHA_224", "HMAC_SHA_256", "HMAC_SHA_384", "HMAC_SHA_512"]) }],
    async run(ctx, id, v) {
      try {
        const r = await ctx.clients.kms.send(new VerifyMacCommand({ KeyId: id, Message: Buffer.from(String(v.message ?? ""), "utf8"), Mac: Buffer.from(s(v.mac), "base64"), MacAlgorithm: s(v.algorithm) as MacAlgorithmSpec }));
        return { message: r.MacValid ? "The MAC is valid." : "The MAC is not valid." };
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "KMSInvalidMacException") return { message: "The MAC is not valid (KMSInvalidMacException)." };
        throw err;
      }
    },
  },
];

const customerKeys: ResourceDef = {
  id: "keys",
  name: "Customer managed keys",
  singular: "key",
  idField: "keyId",
  nameField: "Key ID",
  detailHref: "keys/{id}",
  description: "Keys you create, own and manage. You control their key policies, rotation, aliases and grants.",
  emptyText: "No customer managed keys. Create a key to encrypt data or sign messages.",
  columns: [
    { key: "aliases", label: "Aliases", kind: "text" },
    { key: "keyId", label: "Key ID", kind: "link" },
    { key: "status", label: "Status", kind: "status" },
    { key: "keyType", label: "Key type", kind: "text" },
    { key: "keySpec", label: "Key spec", kind: "text" },
    { key: "keyUsage", label: "Key usage", kind: "text" },
    { key: "regionality", label: "Regionality", kind: "text" },
    { key: "description", label: "Description", kind: "text", hidden: true },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],
  list: (ctx) => keyRows(ctx, "CUSTOMER"),
  get: (ctx, id) => keyDetail(ctx, id, true),
  create: {
    title: "Create key",
    description: "Creates the key with CreateKey (with the key policy built from your administrator and user choices), then CreateAlias.",
    fields: [
      { name: "keyConfig", label: "Key type and usage", kind: "radio", default: "sym-enc", section: "Configure key", options: KEY_CONFIGS.map((k) => ({ value: k.value, label: k.label })) },
      { name: "hmacSpec", label: "Key spec", kind: "select", required: true, section: "Configure key", options: opts(["HMAC_224", "HMAC_256", "HMAC_384", "HMAC_512"]), default: "HMAC_256", showIf: { field: "keyConfig", equals: "hmac" } },
      { name: "encSpec", label: "Key spec", kind: "select", required: true, section: "Configure key", options: opts(["RSA_2048", "RSA_3072", "RSA_4096", "SM2"]), default: "RSA_2048", showIf: { field: "keyConfig", equals: "asym-enc" } },
      { name: "signSpec", label: "Key spec", kind: "select", required: true, section: "Configure key", options: opts(["RSA_2048", "RSA_3072", "RSA_4096", "ECC_NIST_P256", "ECC_NIST_P384", "ECC_NIST_P521", "ECC_SECG_P256K1", "SM2"]), default: "RSA_2048", showIf: { field: "keyConfig", equals: "asym-sign" } },
      { name: "agreeSpec", label: "Key spec", kind: "select", required: true, section: "Configure key", options: opts(["ECC_NIST_P256", "ECC_NIST_P384", "ECC_NIST_P521", "SM2"]), default: "ECC_NIST_P256", showIf: { field: "keyConfig", equals: "agree" } },
      { name: "origin", label: "Key material origin", kind: "radio", default: "AWS_KMS", section: "Advanced options", options: [{ value: "AWS_KMS", label: "KMS - recommended" }, { value: "EXTERNAL", label: "External (Import key material)" }] },
      { name: "multiRegion", label: "Multi-Region key: allow this key to be replicated into other Regions", kind: "checkbox", default: false, section: "Advanced options" },
      { name: "alias", label: "Alias", kind: "text", required: true, section: "Add labels", help: "Without the alias/ prefix. Letters, numbers, slashes, underscores and hyphens; can't begin with aws/.", validate: { pattern: ALIAS, message: "Use letters, numbers, /, _ and -." } },
      { name: "description", label: "Description", kind: "textarea", section: "Add labels", validate: { max: 8192, message: "At most 8192 characters." } },
      { name: "tags", label: "Tags", kind: "tags", section: "Add labels" },
      { name: "admins", label: "Key administrators", kind: "multiselect", options: principalArnOptions, section: "Define key administrative permissions", help: "IAM users and roles that can administer this key through the KMS API." },
      { name: "allowAdminsDelete", label: "Allow key administrators to delete this key", kind: "checkbox", default: true, section: "Define key administrative permissions" },
      { name: "users", label: "Key users", kind: "multiselect", options: principalArnOptions, section: "Define key usage permissions", help: "IAM users and roles that can use the key in cryptographic operations." },
      { name: "otherAccounts", label: "Other AWS accounts", kind: "text", section: "Define key usage permissions", help: "Optional comma-separated 12-digit account IDs that can use this key." },
    ],
    async run(ctx, v) {
      const cfg = KEY_CONFIGS.find((k) => k.value === v.keyConfig);
      if (!cfg) throw new Error("Choose a key type and usage.");
      const alias = s(v.alias).replace(/^alias\//, "");
      if (alias.startsWith("aws/")) throw new Error("Aliases that begin with aws/ are reserved for AWS managed keys.");
      const policy = defaultKeyPolicy({
        accountId: ctx.accountId,
        admins: strs(v.admins),
        allowAdminsDelete: v.allowAdminsDelete === true,
        users: strs(v.users),
        otherAccounts: s(v.otherAccounts).split(",").map((x) => x.trim()).filter(Boolean),
        usage: cfg.usage,
        symmetric: cfg.symmetric,
      });
      const tags = Array.isArray(v.tags) ? (v.tags as { Key: string; Value: string }[]).map((t) => ({ TagKey: t.Key, TagValue: t.Value })) : [];
      const r = await ctx.clients.kms.send(
        new CreateKeyCommand({
          KeySpec: specFor(v),
          KeyUsage: cfg.usage,
          Origin: v.origin === "EXTERNAL" ? "EXTERNAL" : "AWS_KMS",
          MultiRegion: v.multiRegion === true,
          Description: s(v.description) || undefined,
          Policy: JSON.stringify(policy),
          Tags: tags.length ? tags : undefined,
        })
      );
      const id = r.KeyMetadata?.KeyId;
      if (!id) throw new Error("CreateKey returned no key ID.");
      await ctx.clients.kms.send(new CreateAliasCommand({ AliasName: `alias/${alias}`, TargetKeyId: id }));
      return id;
    },
  },
  actions: withKeyAvailability([
    {
      id: "enable",
      label: "Enable",
      async run(ctx, id) {
        await ctx.clients.kms.send(new EnableKeyCommand({ KeyId: id }));
        return { message: `Key ${id} enabled.` };
      },
    },
    {
      id: "disable",
      label: "Disable",
      danger: true,
      confirm: "Disabled keys can't be used in cryptographic operations until you enable them again.",
      async run(ctx, id) {
        await ctx.clients.kms.send(new DisableKeyCommand({ KeyId: id }));
        return { message: `Key ${id} disabled.` };
      },
    },
    {
      id: "schedule-deletion",
      label: "Schedule key deletion",
      danger: true,
      confirm: "After the waiting period, KMS deletes the key and all its metadata. Data encrypted under the key can't be decrypted after that.",
      fields: [{ name: "days", label: "Waiting period (in days)", kind: "number", default: 30, required: true, validate: { min: 7, max: 30, message: "Between 7 and 30 days." } }],
      async run(ctx, id, v) {
        const r = await ctx.clients.kms.send(new ScheduleKeyDeletionCommand({ KeyId: id, PendingWindowInDays: typeof v.days === "number" ? v.days : 30 }));
        return { message: `Key ${id} is pending deletion. Deletion date: ${r.DeletionDate?.toISOString() ?? "-"}.` };
      },
    },
    {
      id: "cancel-deletion",
      label: "Cancel key deletion",
      async run(ctx, id) {
        await ctx.clients.kms.send(new CancelKeyDeletionCommand({ KeyId: id }));
        return { message: `Deletion cancelled. The key is now Disabled; enable it to use it again.` };
      },
    },
    {
      id: "edit-description",
      label: "Edit description",
      fields: [{ name: "description", label: "Description", kind: "textarea", validate: { max: 8192, message: "At most 8192 characters." } }],
      async initialValues(ctx, id) {
        return { description: (await describe(ctx, id)).Description ?? "" };
      },
      async run(ctx, id, v) {
        const next = typeof v.description === "string" ? v.description : "";
        if (next === ((await describe(ctx, id)).Description ?? "")) return { message: "No changes to the description." };
        await ctx.clients.kms.send(new UpdateKeyDescriptionCommand({ KeyId: id, Description: next }));
        return { message: "Description updated." };
      },
    },
    {
      id: "create-alias",
      label: "Create alias",
      fields: [{ name: "alias", label: "Alias", kind: "text", required: true, help: "Without the alias/ prefix.", validate: { pattern: ALIAS, message: "Use letters, numbers, /, _ and -." } }],
      async run(ctx, id, v) {
        const alias = `alias/${s(v.alias).replace(/^alias\//, "")}`;
        await ctx.clients.kms.send(new CreateAliasCommand({ AliasName: alias, TargetKeyId: id }));
        return { message: `Alias ${alias} now points to this key.` };
      },
    },
    {
      id: "delete-aliases",
      label: "Delete alias",
      danger: true,
      async run(ctx, id) {
        return {
          table: {
            rowKey: "alias",
            columns: [{ key: "alias", label: "Alias name", kind: "text" }],
            rows: (await allAliases(ctx, id)).map((a) => ({ alias: a.AliasName ?? "" })),
            emptyText: "No aliases.",
            selectionAction: { actionId: "remove-aliases", label: "Delete", danger: true, valuesField: "aliases" },
          },
        };
      },
    },
    {
      id: "remove-aliases",
      label: "Remove aliases",
      hidden: true,
      danger: true,
      fields: [{ name: "aliases", label: "Aliases", kind: "multiselect", required: true }],
      async run(ctx, _id, v) {
        const list = strs(v.aliases);
        for (const a of list) await ctx.clients.kms.send(new DeleteAliasCommand({ AliasName: a }));
        return { message: `Deleted ${list.length} alias${list.length === 1 ? "" : "es"}.` };
      },
    },
    {
      id: "enable-rotation",
      label: "Edit automatic key rotation",
      fields: [
        { name: "enabled", label: "Automatically rotate this KMS key", kind: "checkbox", default: false },
        { name: "days", label: "Key rotation period (in days)", kind: "number", default: 365, required: true, showIf: { field: "enabled", equals: true }, validate: { min: 90, max: 2560, message: "Between 90 and 2560 days." } },
      ],
      async initialValues(ctx, id) {
        const r = await ctx.clients.kms.send(new GetKeyRotationStatusCommand({ KeyId: id }));
        const values: FieldValues = { enabled: r.KeyRotationEnabled === true };
        if (r.RotationPeriodInDays) values.days = r.RotationPeriodInDays;
        return values;
      },
      async run(ctx, id, v) {
        const r = await ctx.clients.kms.send(new GetKeyRotationStatusCommand({ KeyId: id }));
        const wasOn = r.KeyRotationEnabled === true;
        if (v.enabled !== true) {
          if (!wasOn) return { message: "No changes to save." };
          await ctx.clients.kms.send(new DisableKeyRotationCommand({ KeyId: id }));
          return { message: "Automatic key rotation disabled." };
        }
        const days = typeof v.days === "number" ? v.days : 365;
        if (wasOn && r.RotationPeriodInDays === days) return { message: "No changes to save." };
        await ctx.clients.kms.send(new EnableKeyRotationCommand({ KeyId: id, RotationPeriodInDays: days }));
        return { message: `Automatic key rotation enabled, every ${days} days.` };
      },
    },
    {
      id: "rotate-now",
      label: "Rotate key now",
      confirm: "Starts on-demand rotation of the key material (RotateKeyOnDemand). Existing ciphertexts still decrypt.",
      async run(ctx, id) {
        await ctx.clients.kms.send(new RotateKeyOnDemandCommand({ KeyId: id }));
        return { message: "On-demand rotation started." };
      },
    },
    {
      id: "create-grant",
      label: "Create grant",
      fields: [
        { name: "name", label: "Grant name", kind: "text" },
        { name: "grantee", label: "Grantee principal", kind: "select", required: true, options: principalArnOptions },
        { name: "operations", label: "Operations", kind: "multiselect", required: true, options: opts(["Encrypt", "Decrypt", "ReEncryptFrom", "ReEncryptTo", "GenerateDataKey", "GenerateDataKeyWithoutPlaintext", "GenerateDataKeyPair", "DescribeKey", "CreateGrant", "RetireGrant", "Sign", "Verify", "GetPublicKey", "GenerateMac", "VerifyMac", "DeriveSharedSecret"]) },
        { name: "retiring", label: "Retiring principal", kind: "select", options: principalArnOptions },
      ],
      async run(ctx, id, v) {
        const r = await ctx.clients.kms.send(
          new CreateGrantCommand({ KeyId: id, Name: s(v.name) || undefined, GranteePrincipal: s(v.grantee), RetiringPrincipal: s(v.retiring) || undefined, Operations: strs(v.operations) as GrantOperation[] })
        );
        return { message: "Grant created.", json: { GrantId: r.GrantId, GrantToken: r.GrantToken } };
      },
    },
    {
      id: "revoke-grants",
      label: "Revoke grant",
      danger: true,
      async run(ctx, id) {
        const grants = await allGrants(ctx, id);
        return {
          table: {
            rowKey: "id",
            columns: [
              { key: "name", label: "Grant name", kind: "text" },
              { key: "id", label: "Grant ID", kind: "code" },
              { key: "operations", label: "Operations", kind: "text" },
            ],
            rows: grants.map((g) => ({ name: g.Name ?? "", id: g.GrantId ?? "", operations: (g.Operations ?? []).join(", ") })),
            emptyText: "No grants.",
            selectionAction: { actionId: "revoke-selected-grants", label: "Revoke", danger: true, valuesField: "grants" },
          },
        };
      },
    },
    {
      id: "revoke-selected-grants",
      label: "Revoke grants",
      hidden: true,
      danger: true,
      fields: [{ name: "grants", label: "Grants", kind: "multiselect", required: true }],
      async run(ctx, id, v) {
        const list = strs(v.grants);
        for (const g of list) await ctx.clients.kms.send(new RevokeGrantCommand({ KeyId: id, GrantId: g }));
        return { message: `Revoked ${list.length} grant${list.length === 1 ? "" : "s"}.` };
      },
    },
    {
      id: "retire-grant",
      label: "Retire grant",
      danger: true,
      fields: [{ name: "grantId", label: "Grant ID", kind: "text", required: true }],
      async run(ctx, id, v) {
        await ctx.clients.kms.send(new RetireGrantCommand({ KeyId: id, GrantId: s(v.grantId) }));
        return { message: "Grant retired." };
      },
    },
    {
      id: "edit-tags",
      label: "Edit tags",
      fields: [{ name: "tags", label: "Tags", kind: "tags", help: "Tags you remove here are removed from the key (UntagResource); new or changed ones are set with TagResource." }],
      async initialValues(ctx, id) {
        return { tags: await allKeyTags(ctx, id) };
      },
      async run(ctx, id, v) {
        const diff = tagDiff(await allKeyTags(ctx, id), fieldTags(v.tags));
        if (diff.remove.length) await ctx.clients.kms.send(new UntagResourceCommand({ KeyId: id, TagKeys: diff.remove }));
        if (diff.set.length) await ctx.clients.kms.send(new TagResourceCommand({ KeyId: id, Tags: diff.set.map((x) => ({ TagKey: x.Key, TagValue: x.Value })) }));
        return { message: tagDiffMessage(diff) };
      },
    },
    {
      id: "replicate",
      label: "Create replica key",
      fields: [
        { name: "region", label: "Replica Region", kind: "select", required: true, options: async (ctx) => CONSOLE_REGIONS.filter((r) => r.code !== ctx.region).map((r) => ({ value: r.code, label: `${r.name} ${r.code}` })), help: "Multi-Region primary keys only. The replica lives in the chosen Region: switch Region in the top bar to see it." },
        { name: "description", label: "Description", kind: "text" },
      ],
      async run(ctx, id, v) {
        const r = await ctx.clients.kms.send(new ReplicateKeyCommand({ KeyId: id, ReplicaRegion: s(v.region), Description: s(v.description) || undefined }));
        return { message: `Replica created: ${r.ReplicaKeyMetadata?.Arn ?? "-"}.` };
      },
    },
    ...cryptoActions,
  ]),
};

const awsManagedKeys: ResourceDef = {
  id: "aws-managed-keys",
  name: "AWS managed keys",
  singular: "AWS managed key",
  idField: "keyId",
  nameField: "Key ID",
  description: "Keys that AWS services create and manage in your account (alias/aws/...). You can view them but not change them.",
  emptyText: "No AWS managed keys. AWS services create them the first time you use their default encryption.",
  columns: [
    { key: "aliases", label: "Aliases", kind: "text" },
    { key: "keyId", label: "Key ID", kind: "link" },
    { key: "status", label: "Status", kind: "status" },
    { key: "created", label: "Created", kind: "date" },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],
  list: (ctx) => keyRows(ctx, "AWS"),
  get: (ctx, id) => keyDetail(ctx, id, false),
  actions: cryptoActions.filter((a) => a.id === "encrypt" || a.id === "decrypt" || a.id === "generate-data-key").map(withAvailability),
};

const keyStores: ResourceDef = {
  id: "custom-key-stores",
  name: "Custom key stores",
  singular: "custom key store",
  idField: "id",
  nameField: "Name",
  description: "Key stores backed by an AWS CloudHSM cluster or an external key manager (XKS proxy). Creating one needs a reachable CloudHSM cluster or XKS proxy, which this local setup doesn't have.",
  emptyText: "No custom key stores.",
  columns: [
    { key: "name", label: "Custom key store name", kind: "link" },
    { key: "id", label: "Custom key store ID", kind: "code" },
    { key: "type", label: "Type", kind: "text" },
    { key: "state", label: "Connection state", kind: "status" },
    { key: "created", label: "Created", kind: "date" },
  ],
  async list(ctx) {
    const r = await ctx.clients.kms.send(new DescribeCustomKeyStoresCommand({}));
    return (r.CustomKeyStores ?? []).map((k) => ({ name: k.CustomKeyStoreName ?? "", id: k.CustomKeyStoreId ?? "", type: k.CustomKeyStoreType ?? null, state: k.ConnectionState ?? null, created: k.CreationDate ?? null }));
  },
  async get(ctx, id) {
    const r = await ctx.clients.kms.send(new DescribeCustomKeyStoresCommand({ CustomKeyStoreId: id }));
    const k = r.CustomKeyStores?.[0];
    if (!k) throw new Error(`Custom key store ${id} not found.`);
    return { summary: { Name: k.CustomKeyStoreName ?? id, ID: k.CustomKeyStoreId ?? id, Type: k.CustomKeyStoreType ?? null, "Connection state": k.ConnectionState ?? null, Created: k.CreationDate ?? null }, tabs: [{ id: "raw", label: "Configuration", kind: "json", data: k }] };
  },
};

export const kmsService: ServiceDef = {
  id: "kms",
  name: "Key Management Service",
  category: "Security, Identity, & Compliance",
  description: "Create and control the cryptographic keys that protect your data.",
  resources: [awsManagedKeys, customerKeys, keyStores],
  notSupported: [],
};

export { keyOptions };
