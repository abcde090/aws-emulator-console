/**
 * EC2 Key pairs. Create and import use a hand-built page (/ec2/key-pairs/create) because the
 * private key must be handed to the browser once, as the console does with its download.
 */

import { CreateKeyPairCommand, DeleteKeyPairCommand, DescribeKeyPairsCommand, ImportKeyPairCommand } from "@aws-sdk/client-ec2";
import type { Ctx, ResourceDef, Tag } from "../../console/types.ts";
import { tagRows } from "./helpers.ts";
import { tagSpec } from "./options.ts";

export const KEY_NAME = "[\\x20-\\x7E]{1,255}";
const KEY_NAME_RE = new RegExp(`^${KEY_NAME}$`);

export interface NewKeyPair {
  name: string;
  type: "rsa" | "ed25519";
  format: "pem" | "ppk";
  tags: Tag[];
}

export interface CreatedKeyPair {
  name: string;
  keyPairId: string | null;
  fingerprint: string | null;
  material: string;
  fileName: string;
}

export function checkKeyName(name: unknown): string {
  if (typeof name !== "string" || !KEY_NAME_RE.test(name.trim())) throw new Error("Key pair name: up to 255 ASCII characters.");
  return name.trim();
}

export async function createKeyPair(ctx: Ctx, k: NewKeyPair): Promise<CreatedKeyPair> {
  const name = checkKeyName(k.name);
  if (k.type !== "rsa" && k.type !== "ed25519") throw new Error("Key pair type must be RSA or ED25519.");
  if (k.format !== "pem" && k.format !== "ppk") throw new Error("Private key file format must be .pem or .ppk.");
  const r = await ctx.clients.ec2.send(new CreateKeyPairCommand({ KeyName: name, KeyType: k.type, KeyFormat: k.format, TagSpecifications: tagSpec("key-pair", k.tags) }));
  if (!r.KeyMaterial) throw new Error("CreateKeyPair returned no private key.");
  return { name, keyPairId: r.KeyPairId ?? null, fingerprint: r.KeyFingerprint ?? null, material: r.KeyMaterial, fileName: `${name.replace(/[^A-Za-z0-9._-]/g, "_")}.${k.format}` };
}

export async function importKeyPair(ctx: Ctx, nameRaw: unknown, publicKey: unknown, tags: Tag[]): Promise<{ name: string; keyPairId: string | null; fingerprint: string | null }> {
  const name = checkKeyName(nameRaw);
  if (typeof publicKey !== "string" || !/^(ssh-rsa|ssh-ed25519|ecdsa-sha2-nistp\d+) [A-Za-z0-9+/=]+( .*)?$/.test(publicKey.trim()) || publicKey.length > 16384) {
    throw new Error("Paste an OpenSSH public key (ssh-rsa AAAA... or ssh-ed25519 AAAA...).");
  }
  const r = await ctx.clients.ec2.send(new ImportKeyPairCommand({ KeyName: name, PublicKeyMaterial: new TextEncoder().encode(publicKey.trim()), TagSpecifications: tagSpec("key-pair", tags) }));
  return { name, keyPairId: r.KeyPairId ?? null, fingerprint: r.KeyFingerprint ?? null };
}

export const keyPairs: ResourceDef = {
  id: "key-pairs",
  name: "Key Pairs",
  singular: "key pair",
  idField: "name",
  nameField: "Name",
  description: "A key pair (public key held by AWS, private key held by you) proves your identity when you connect to an instance.",
  emptyText: "No key pairs to display. Create or import one.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "type", label: "Type", kind: "text" },
    { key: "created", label: "Created", kind: "date" },
    { key: "fingerprint", label: "Fingerprint", kind: "code" },
    { key: "id", label: "ID", kind: "text" },
  ],
  async list(ctx) {
    return ((await ctx.clients.ec2.send(new DescribeKeyPairsCommand({}))).KeyPairs ?? []).map((k) => ({
      name: k.KeyName ?? "",
      type: k.KeyType ?? null,
      created: k.CreateTime ?? null,
      fingerprint: k.KeyFingerprint ?? null,
      id: k.KeyPairId ?? null,
    }));
  },
  async get(ctx, name) {
    const k = (await ctx.clients.ec2.send(new DescribeKeyPairsCommand({ KeyNames: [name], IncludePublicKey: true }))).KeyPairs?.[0];
    if (!k) throw new Error(`Key pair ${name} was not found.`);
    return {
      summary: { Name: k.KeyName ?? name, "Key pair ID": k.KeyPairId ?? null, Type: k.KeyType ?? null, Created: k.CreateTime ?? null, Fingerprint: k.KeyFingerprint ?? null },
      tabs: [
        { id: "public", label: "Public key", kind: "text", data: k.PublicKey ?? "", emptyText: "DescribeKeyPairs returned no public key." },
        { id: "tags", label: "Tags", kind: "table", columns: [{ key: "Key", label: "Key", kind: "text" }, { key: "Value", label: "Value", kind: "text" }], data: tagRows(k.Tags), emptyText: "No tags." },
      ],
    };
  },
  create: {
    title: "Create key pair",
    description: "Creates a key pair with CreateKeyPair.",
    fields: [
      { name: "name", label: "Name", kind: "text", required: true, validate: { pattern: KEY_NAME, message: "Up to 255 ASCII characters." } },
      { name: "type", label: "Key pair type", kind: "radio", default: "rsa", options: [{ value: "rsa", label: "RSA" }, { value: "ed25519", label: "ED25519" }] },
      { name: "format", label: "Private key file format", kind: "radio", default: "pem", options: [{ value: "pem", label: ".pem (for use with OpenSSH)" }, { value: "ppk", label: ".ppk (for use with PuTTY)" }] },
      { name: "tags", label: "Tags", kind: "tags" },
    ],
    async run(ctx, v) {
      const k = await createKeyPair(ctx, { name: String(v.name), type: v.type === "ed25519" ? "ed25519" : "rsa", format: v.format === "ppk" ? "ppk" : "pem", tags: Array.isArray(v.tags) ? (v.tags as Tag[]) : [] });
      return k.name;
    },
  },
  delete: {
    confirmText: "name",
    async run(ctx, name) {
      await ctx.clients.ec2.send(new DeleteKeyPairCommand({ KeyName: name }));
    },
  },
};
