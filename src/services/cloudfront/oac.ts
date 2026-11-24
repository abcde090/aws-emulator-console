/**
 * CloudFront origin access controls (Security › Origin access): list, detail with the
 * distributions that use each OAC, create, edit and delete (both need the ETag).
 */

import { secondary, unavailableText } from "../../console/secondary.ts";
import {
  CreateOriginAccessControlCommand,
  DeleteOriginAccessControlCommand,
  GetOriginAccessControlCommand,
  UpdateOriginAccessControlCommand,
  type OriginAccessControlOriginTypes,
  type OriginAccessControlSigningBehaviors,
} from "@aws-sdk/client-cloudfront";
import type { FieldDef, ResourceDef } from "../../console/types.ts";
import { listDistributions, listOacs } from "./lookups.ts";

const SIGNING = [
  { value: "always", label: "Sign requests (recommended)" },
  { value: "no-override", label: "Sign requests, but do not override the viewer's Authorization header" },
  { value: "never", label: "Do not sign requests" },
];
const ORIGIN_TYPES = [
  { value: "s3", label: "S3" },
  { value: "lambda", label: "Lambda" },
  { value: "mediastore", label: "MediaStore" },
  { value: "mediapackagev2", label: "MediaPackage V2" },
];
const signingLabel = (v: string | undefined) => SIGNING.find((s) => s.value === v)?.label ?? v ?? null;
const typeLabel = (v: string | undefined) => ORIGIN_TYPES.find((s) => s.value === v)?.label ?? v ?? null;

const NAME_RULE = { pattern: "[^\\s][\\s\\S]{0,63}", message: "1-64 characters." };

const editFields: FieldDef[] = [
  { name: "name", label: "Name", kind: "text", required: true, validate: NAME_RULE },
  { name: "description", label: "Description", kind: "text", help: "Clear the box to remove the description.", validate: { max: 256, message: "At most 256 characters." } },
  { name: "signing", label: "Signing behavior", kind: "radio", default: "always", options: SIGNING },
];

export const originAccessControls: ResourceDef = {
  id: "origin-access",
  name: "Origin access",
  singular: "origin access control",
  idField: "id",
  nameField: "name",
  description: "Origin access controls (OAC) let CloudFront sign requests to an origin, so the origin can allow only CloudFront.",
  emptyText: "You don't have any origin access controls.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "id", label: "ID", kind: "code" },
    { key: "description", label: "Description", kind: "text" },
    { key: "signing", label: "Signing behavior", kind: "text" },
    { key: "originType", label: "Origin type", kind: "text" },
  ],
  async list(ctx) {
    return (await listOacs(ctx)).map((o) => ({
      id: o.Id ?? "",
      name: o.Name ?? null,
      description: o.Description || null,
      signing: signingLabel(o.SigningBehavior),
      originType: typeLabel(o.OriginAccessControlOriginType),
    }));
  },
  async get(ctx, id) {
    const [r, distsR] = await Promise.all([ctx.clients.cloudfront.send(new GetOriginAccessControlCommand({ Id: id })), secondary(listDistributions(ctx))]);
    const c = r.OriginAccessControl?.OriginAccessControlConfig;
    const users = (distsR.ok ? distsR.value : []).flatMap((d) =>
      (d.Origins?.Items ?? []).filter((o) => o.OriginAccessControlId === id).map((o) => ({ distribution: d.Id ?? "", origin: o.Id ?? null, domain: o.DomainName ?? null }))
    );
    return {
      summary: { Name: c?.Name ?? id, ID: id, Description: c?.Description || "-", "Signing behavior": signingLabel(c?.SigningBehavior), "Signing protocol": c?.SigningProtocol ?? null, "Origin type": typeLabel(c?.OriginAccessControlOriginType) },
      tabs: [
        {
          id: "distributions",
          label: "Distributions",
          kind: "table",
          columns: [
            { key: "distribution", label: "Distribution ID", kind: "code" },
            { key: "origin", label: "Origin name", kind: "text" },
            { key: "domain", label: "Origin domain", kind: "code" },
          ],
          data: users,
          emptyText: unavailableText(distsR, "No distribution uses this origin access control."),
          description: "An OAC that a distribution uses can't be deleted.",
        },
      ],
    };
  },
  create: {
    title: "Create control setting",
    description: "Creates an origin access control (CreateOriginAccessControl).",
    fields: [
      { name: "name", label: "Name", kind: "text", required: true, section: "Settings", validate: NAME_RULE },
      { name: "description", label: "Description", kind: "text", section: "Settings", validate: { max: 256, message: "At most 256 characters." } },
      { name: "signing", label: "Signing behavior", kind: "radio", default: "always", section: "Settings", options: SIGNING },
      { name: "originType", label: "Origin type", kind: "radio", default: "s3", section: "Settings", options: ORIGIN_TYPES },
    ],
    async run(ctx, v) {
      const r = await ctx.clients.cloudfront.send(
        new CreateOriginAccessControlCommand({
          OriginAccessControlConfig: {
            Name: String(v.name),
            Description: typeof v.description === "string" ? v.description : "",
            SigningProtocol: "sigv4",
            SigningBehavior: String(v.signing || "always") as OriginAccessControlSigningBehaviors,
            OriginAccessControlOriginType: String(v.originType || "s3") as OriginAccessControlOriginTypes,
          },
        })
      );
      const id = r.OriginAccessControl?.Id;
      if (!id) throw new Error("CloudFront returned no ID for the new origin access control.");
      return id;
    },
  },
  actions: [
    {
      id: "edit",
      label: "Edit",
      fields: editFields,
      async initialValues(ctx, id) {
        const c = (await ctx.clients.cloudfront.send(new GetOriginAccessControlCommand({ Id: id }))).OriginAccessControl?.OriginAccessControlConfig;
        return { name: c?.Name ?? "", description: c?.Description ?? "", signing: c?.SigningBehavior ?? "always" };
      },
      async run(ctx, id, v) {
        const r = await ctx.clients.cloudfront.send(new GetOriginAccessControlCommand({ Id: id }));
        const c = r.OriginAccessControl?.OriginAccessControlConfig;
        if (!c || !r.ETag) throw new Error("CloudFront returned no configuration for this origin access control.");
        await ctx.clients.cloudfront.send(
          new UpdateOriginAccessControlCommand({
            Id: id,
            IfMatch: r.ETag,
            OriginAccessControlConfig: {
              ...c,
              Name: typeof v.name === "string" && v.name ? v.name : c.Name,
              Description: typeof v.description === "string" ? v.description : "",
              SigningBehavior: (typeof v.signing === "string" && v.signing ? v.signing : c.SigningBehavior) as OriginAccessControlSigningBehaviors,
            },
          })
        );
        return { message: "Origin access control saved." };
      },
    },
  ],
  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      const r = await ctx.clients.cloudfront.send(new GetOriginAccessControlCommand({ Id: id }));
      if (!r.ETag) throw new Error("CloudFront returned no ETag for this origin access control.");
      await ctx.clients.cloudfront.send(new DeleteOriginAccessControlCommand({ Id: id, IfMatch: r.ETag }));
    },
  },
};
