/** Amazon SNS mobile push: platform applications and their endpoints. */

import {
  CreatePlatformApplicationCommand,
  CreatePlatformEndpointCommand,
  DeletePlatformApplicationCommand,
  GetPlatformApplicationAttributesCommand,
  ListEndpointsByPlatformApplicationCommand,
  ListPlatformApplicationsCommand,
  type PlatformApplication,
} from "@aws-sdk/client-sns";
import type { ResourceDef } from "../../console/types.ts";
import { text } from "./helpers.ts";

/** arn:aws:sns:region:account:app/PLATFORM/name */
function appParts(arn: string): { platform: string; name: string } {
  const m = /:app\/([^/]+)\/(.+)$/.exec(arn);
  return m ? { platform: m[1], name: m[2] } : { platform: "-", name: arn };
}

export const platformApplications: ResourceDef = {
  id: "platform-applications",
  name: "Mobile push notifications",
  singular: "platform application",
  idField: "arn",
  nameField: "Name",
  description: "Platform applications send push notifications to apps on mobile devices.",
  emptyText: "No platform applications.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "platform", label: "Push notification platform", kind: "text" },
    { key: "enabled", label: "Enabled", kind: "text" },
    { key: "arn", label: "ARN", kind: "arn" },
  ],

  async list(ctx) {
    const apps: PlatformApplication[] = [];
    let token: string | undefined;
    do {
      const page = await ctx.clients.sns.send(new ListPlatformApplicationsCommand({ NextToken: token }));
      apps.push(...(page.PlatformApplications ?? []));
      token = page.NextToken;
    } while (token);
    return apps
      .filter((a) => a.PlatformApplicationArn)
      .map((a) => {
        const arn = a.PlatformApplicationArn as string;
        return { ...appParts(arn), arn, enabled: a.Attributes?.Enabled ?? null };
      });
  },

  async get(ctx, arn) {
    const [attrs, endpoints] = await Promise.all([
      ctx.clients.sns.send(new GetPlatformApplicationAttributesCommand({ PlatformApplicationArn: arn })),
      ctx.clients.sns.send(new ListEndpointsByPlatformApplicationCommand({ PlatformApplicationArn: arn })),
    ]);
    const a = attrs.Attributes ?? {};
    const p = appParts(arn);
    return {
      summary: { Name: p.name, Platform: p.platform, ARN: arn, Enabled: a.Enabled ?? null },
      tabs: [
        {
          id: "endpoints",
          label: "Endpoints",
          kind: "table",
          columns: [
            { key: "arn", label: "Endpoint ARN", kind: "arn" },
            { key: "token", label: "Device token", kind: "code" },
            { key: "enabled", label: "Enabled", kind: "text" },
            { key: "userData", label: "User data", kind: "text" },
          ],
          data: (endpoints.Endpoints ?? []).map((e) => ({ arn: e.EndpointArn ?? null, token: e.Attributes?.Token ?? null, enabled: e.Attributes?.Enabled ?? null, userData: e.Attributes?.CustomUserData ?? null })),
          emptyText: "No endpoints. Use Actions > Create application endpoint.",
        },
        {
          id: "attributes",
          label: "Attributes",
          kind: "table",
          columns: [
            { key: "name", label: "Attribute", kind: "text" },
            { key: "value", label: "Value", kind: "code" },
          ],
          data: Object.entries(a).map(([name, value]) => ({ name, value })),
          emptyText: "No attributes returned.",
        },
      ],
    };
  },

  create: {
    title: "Create platform application",
    description: "Creates a platform application with CreatePlatformApplication. The emulator checks that the credentials have the right form for the platform.",
    fields: [
      { name: "name", label: "Application name", kind: "text", required: true, section: "Application details", validate: { pattern: "[A-Za-z0-9_.-]{1,256}", message: "Letters, numbers, periods, hyphens and underscores, up to 256." } },
      {
        name: "platform", label: "Push notification platform", kind: "select", required: true, default: "GCM", section: "Application details",
        options: [
          { value: "ADM", label: "Amazon Device Messaging (ADM)" },
          { value: "APNS", label: "Apple iOS/VoIP/macOS (APNS)" },
          { value: "APNS_SANDBOX", label: "Apple sandbox (APNS_SANDBOX)" },
          { value: "BAIDU", label: "Baidu Cloud Push" },
          { value: "GCM", label: "Firebase Cloud Messaging (FCM)" },
          { value: "MPNS", label: "Microsoft MPNS" },
          { value: "WNS", label: "Windows (WNS)" },
        ],
      },
      { name: "principal", label: "Platform principal", kind: "text", section: "Credentials", help: "ADM client ID, APNS certificate, Baidu API key or WNS package SID. Not used for FCM." },
      { name: "credential", label: "Platform credential", kind: "textarea", required: true, section: "Credentials", help: "ADM client secret, APNS private key, FCM API key or service account JSON, Baidu secret key, or WNS secret key." },
    ],
    async run(ctx, v) {
      const attributes: Record<string, string> = { PlatformCredential: String(v.credential ?? "") };
      const principal = text(v.principal);
      if (principal) attributes.PlatformPrincipal = principal;
      const r = await ctx.clients.sns.send(new CreatePlatformApplicationCommand({ Name: text(v.name), Platform: text(v.platform), Attributes: attributes }));
      if (!r.PlatformApplicationArn) throw new Error("SNS returned no platform application ARN.");
      return r.PlatformApplicationArn;
    },
  },

  actions: [
    {
      id: "create-endpoint",
      label: "Create application endpoint",
      fields: [
        { name: "token", label: "Device token", kind: "text", required: true, help: "The token the device's push service gave the app." },
        { name: "userData", label: "User data", kind: "text" },
      ],
      async run(ctx, arn, v) {
        const r = await ctx.clients.sns.send(new CreatePlatformEndpointCommand({ PlatformApplicationArn: arn, Token: text(v.token), CustomUserData: text(v.userData) || undefined }));
        return { message: `Endpoint created: ${r.EndpointArn ?? "(no ARN returned)"}` };
      },
    },
  ],

  delete: {
    confirmText: "delete",
    async run(ctx, arn) {
      await ctx.clients.sns.send(new DeletePlatformApplicationCommand({ PlatformApplicationArn: arn }));
    },
  },
};
