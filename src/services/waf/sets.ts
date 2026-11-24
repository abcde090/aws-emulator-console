/** AWS WAF IP sets and regex pattern sets, in the Regional and Global (CloudFront) scopes. */

import { secondary } from "../../console/secondary.ts";
import {
  CreateIPSetCommand,
  CreateRegexPatternSetCommand,
  DeleteIPSetCommand,
  DeleteRegexPatternSetCommand,
  GetIPSetCommand,
  GetRegexPatternSetCommand,
  UpdateIPSetCommand,
  UpdateRegexPatternSetCommand,
} from "@aws-sdk/client-wafv2";
import type { Ctx, ResourceDef, Row } from "../../console/types.ts";
import { findSummary, listBothScopes, refId, SCOPE_COLUMN, scopeField, scopeLabel, scopeValue, tagRows, tagsAction, TAG_COLUMNS, toWafTags, wafFor } from "./client.ts";
import { parseAddresses, parseRegexList } from "./helpers.ts";

const NAME = "[\\w-]{1,128}";
const DESCRIPTION = { pattern: "[\\w+=:#@/\\-,.][\\w+=:#@/\\-,.\\s]+[\\w+=:#@/\\-,.]", message: "At least 3 characters; letters, numbers, spaces and + = : # @ / - , . only." };
const str = (v: unknown): string => (typeof v === "string" ? v : "");

async function readIpSet(ctx: Ctx, id: string) {
  const s = await findSummary(ctx, "ipset", id);
  const r = await wafFor(ctx, s.scope).send(new GetIPSetCommand({ Scope: s.scope, Name: s.Name, Id: s.Id }));
  if (!r.IPSet) throw new Error(`GetIPSet returned nothing for ${s.Name}.`);
  return { s, set: r.IPSet, lockToken: r.LockToken };
}

async function readRegexSet(ctx: Ctx, id: string) {
  const s = await findSummary(ctx, "regex", id);
  const r = await wafFor(ctx, s.scope).send(new GetRegexPatternSetCommand({ Scope: s.scope, Name: s.Name, Id: s.Id }));
  if (!r.RegexPatternSet) throw new Error(`GetRegexPatternSet returned nothing for ${s.Name}.`);
  return { s, set: r.RegexPatternSet, lockToken: r.LockToken };
}

export const ipSets: ResourceDef = {
  id: "ip-sets",
  name: "IP sets",
  singular: "IP set",
  idField: "id",
  nameField: "name",
  description: "Collections of IP addresses and ranges that rules can match on.",
  emptyText: "No IP sets. Create an IP set to allow or block a list of addresses.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "description", label: "Description", kind: "text" },
    { key: "wafId", label: "ID", kind: "text" },
    SCOPE_COLUMN,
    { key: "version", label: "IP version", kind: "text" },
    { key: "addresses", label: "Addresses", kind: "count" },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],
  async list(ctx) {
    const items = await listBothScopes(ctx, "ipset");
    return Promise.all(
      items.map(async (s): Promise<Row> => {
        const scope = s.scope ?? "REGIONAL";
        // Version and address count need GetIPSet: if it's denied, those cells stay blank instead of failing the list.
        const r = await secondary(wafFor(ctx, scope).send(new GetIPSetCommand({ Scope: scope, Name: s.Name, Id: s.Id })));
        const set = r.ok ? r.value.IPSet : undefined;
        return { id: refId(scope, s.Id ?? ""), wafId: s.Id ?? "", scope: scopeLabel(scope, ctx.region), name: s.Name ?? "", description: s.Description || null, arn: s.ARN ?? null, version: set?.IPAddressVersion ?? null, addresses: set?.Addresses?.length ?? null };
      })
    );
  },
  async get(ctx, id) {
    const { s, set } = await readIpSet(ctx, id);
    const tags = await secondary(tagRows(ctx, set.ARN));
    return {
      summary: { Name: set.Name, ID: set.Id, ARN: set.ARN, Description: set.Description || "-", "IP version": set.IPAddressVersion, Scope: scopeLabel(s.scope, ctx.region) },
      tabs: [
        { id: "addresses", label: "IP addresses", kind: "table", columns: [{ key: "address", label: "Address (CIDR)", kind: "text" }], data: (set.Addresses ?? []).map((a) => ({ address: a })), emptyText: "This IP set has no addresses." },
        { id: "tags", label: "Tags", kind: "table", columns: TAG_COLUMNS, data: tags.ok ? tags.value : [], emptyText: tags.ok ? "No tags." : `Tags unavailable: ${tags.error}` },
      ],
    };
  },
  create: {
    title: "Create IP set",
    description: "Creates an IP set with CreateIPSet in the scope you choose.",
    fields: [
      scopeField("IP set details"),
      { name: "name", label: "IP set name", kind: "text", required: true, section: "IP set details", validate: { pattern: NAME, message: "Use 1-128 letters, numbers, hyphens or underscores." } },
      { name: "description", label: "Description", kind: "text", section: "IP set details", validate: DESCRIPTION },
      { name: "version", label: "IP version", kind: "radio", default: "IPV4", section: "IP set details", options: [{ value: "IPV4", label: "IPv4" }, { value: "IPV6", label: "IPv6" }] },
      { name: "addresses", label: "IP addresses", kind: "textarea", section: "IP set details", placeholder: "192.0.2.44/32\n192.0.2.0/24", help: "One address per line in CIDR notation. WAF supports all IPv4 ranges from /1 to /32 and IPv6 from /1 to /128." },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const version = v.version === "IPV6" ? "IPV6" : "IPV4";
      const scope = scopeValue(v);
      const r = await wafFor(ctx, scope).send(
        new CreateIPSetCommand({ Scope: scope, Name: str(v.name), Description: str(v.description) || undefined, IPAddressVersion: version, Addresses: parseAddresses(str(v.addresses), version), Tags: toWafTags(v.tags) })
      );
      if (!r.Summary?.Id) throw new Error("CreateIPSet returned no ID.");
      return refId(scope, r.Summary.Id);
    },
  },
  actions: [
    {
      id: "edit-addresses",
      label: "Edit IP addresses",
      fields: [
        { name: "addresses", label: "IP addresses", kind: "textarea", help: "One address per line in CIDR notation. Shows the current list; saving replaces it with what is here." },
        { name: "confirmEmpty", label: "Remove every address from this IP set", kind: "checkbox", default: false, help: "Needed only when you save an empty list." },
      ],
      async initialValues(ctx, id) {
        const { set } = await readIpSet(ctx, id);
        return { addresses: (set.Addresses ?? []).join("\n") };
      },
      async run(ctx, id, v) {
        const { s, set, lockToken } = await readIpSet(ctx, id);
        const addresses = parseAddresses(str(v.addresses), set.IPAddressVersion === "IPV6" ? "IPV6" : "IPV4");
        if (!addresses.length && (set.Addresses ?? []).length && v.confirmEmpty !== true) {
          throw new Error("The list is empty. Tick \"Remove every address from this IP set\" to save an empty IP set.");
        }
        await wafFor(ctx, s.scope).send(new UpdateIPSetCommand({ Scope: s.scope, Name: s.Name, Id: s.Id, LockToken: lockToken, Description: set.Description || undefined, Addresses: addresses }));
        return { message: `IP set ${s.Name} now has ${addresses.length} address${addresses.length === 1 ? "" : "es"}.` };
      },
    },
    tagsAction("ipset"),
  ],
  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      const { s, lockToken } = await readIpSet(ctx, id);
      await wafFor(ctx, s.scope).send(new DeleteIPSetCommand({ Scope: s.scope, Name: s.Name, Id: s.Id, LockToken: lockToken }));
    },
  },
};

export const regexSets: ResourceDef = {
  id: "regex-pattern-sets",
  name: "Regex pattern sets",
  singular: "regex pattern set",
  idField: "id",
  nameField: "name",
  description: "Collections of regular expressions that rules can match against a part of the request.",
  emptyText: "No regex pattern sets.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "description", label: "Description", kind: "text" },
    { key: "wafId", label: "ID", kind: "text" },
    SCOPE_COLUMN,
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],
  async list(ctx) {
    return (await listBothScopes(ctx, "regex")).map((s) => ({ id: refId(s.scope ?? "REGIONAL", s.Id ?? ""), wafId: s.Id ?? "", scope: scopeLabel(s.scope ?? "REGIONAL", ctx.region), name: s.Name ?? "", description: s.Description || null, arn: s.ARN ?? null }));
  },
  async get(ctx, id) {
    const { s, set } = await readRegexSet(ctx, id);
    const tags = await secondary(tagRows(ctx, set.ARN));
    return {
      summary: { Name: set.Name, ID: set.Id, ARN: set.ARN, Description: set.Description || "-", Scope: scopeLabel(s.scope, ctx.region) },
      tabs: [
        { id: "regex", label: "Regular expressions", kind: "table", columns: [{ key: "regex", label: "Regular expression", kind: "code" }], data: (set.RegularExpressionList ?? []).map((r) => ({ regex: r.RegexString ?? "" })), emptyText: "No regular expressions." },
        { id: "tags", label: "Tags", kind: "table", columns: TAG_COLUMNS, data: tags.ok ? tags.value : [], emptyText: tags.ok ? "No tags." : `Tags unavailable: ${tags.error}` },
      ],
    };
  },
  create: {
    title: "Create regex pattern set",
    fields: [
      scopeField("Regex pattern set details"),
      { name: "name", label: "Regex pattern set name", kind: "text", required: true, section: "Regex pattern set details", validate: { pattern: NAME, message: "Use 1-128 letters, numbers, hyphens or underscores." } },
      { name: "description", label: "Description", kind: "text", section: "Regex pattern set details", validate: DESCRIPTION },
      { name: "regex", label: "Regular expressions", kind: "textarea", required: true, section: "Regex pattern set details", placeholder: "^/admin\n\\.php$", help: "One regular expression per line, up to 10." },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const scope = scopeValue(v);
      const r = await wafFor(ctx, scope).send(
        new CreateRegexPatternSetCommand({ Scope: scope, Name: str(v.name), Description: str(v.description) || undefined, RegularExpressionList: parseRegexList(str(v.regex)).map((RegexString) => ({ RegexString })), Tags: toWafTags(v.tags) })
      );
      if (!r.Summary?.Id) throw new Error("CreateRegexPatternSet returned no ID.");
      return refId(scope, r.Summary.Id);
    },
  },
  actions: [
    {
      id: "edit-regex",
      label: "Edit regular expressions",
      fields: [{ name: "regex", label: "Regular expressions", kind: "textarea", required: true, help: "One per line. Shows the current list; saving replaces it with what is here." }],
      async initialValues(ctx, id) {
        const { set } = await readRegexSet(ctx, id);
        return { regex: (set.RegularExpressionList ?? []).map((r) => r.RegexString ?? "").filter(Boolean).join("\n") };
      },
      async run(ctx, id, v) {
        const { s, set, lockToken } = await readRegexSet(ctx, id);
        const list = parseRegexList(str(v.regex));
        await wafFor(ctx, s.scope).send(new UpdateRegexPatternSetCommand({ Scope: s.scope, Name: s.Name, Id: s.Id, LockToken: lockToken, Description: set.Description || undefined, RegularExpressionList: list.map((RegexString) => ({ RegexString })) }));
        return { message: `Saved ${list.length} regular expression${list.length === 1 ? "" : "s"}.` };
      },
    },
    tagsAction("regex"),
  ],
  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      const { s, lockToken } = await readRegexSet(ctx, id);
      await wafFor(ctx, s.scope).send(new DeleteRegexPatternSetCommand({ Scope: s.scope, Name: s.Name, Id: s.Id, LockToken: lockToken }));
    },
  },
};
