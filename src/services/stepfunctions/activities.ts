/** Step Functions activities: tasks done by your own workers (GetActivityTask / SendTaskSuccess). */

import {
  CreateActivityCommand,
  DeleteActivityCommand,
  DescribeActivityCommand,
  ListActivitiesCommand,
  ListTagsForResourceCommand,
  TagResourceCommand,
  UntagResourceCommand,
  type ActivityListItem,
} from "@aws-sdk/client-sfn";
import type { Ctx, ResourceDef, Tag } from "../../console/types.ts";
import { manageTagsAction } from "../../console/tags.ts";
import { secondary, unavailableText } from "../../console/secondary.ts";
import { isoOrNull, text } from "./helpers.ts";

async function activityTags(ctx: Ctx, arn: string): Promise<Tag[]> {
  const r = await ctx.clients.sfn.send(new ListTagsForResourceCommand({ resourceArn: arn }));
  return (r.tags ?? []).map((t) => ({ Key: t.key ?? "", Value: t.value ?? "" }));
}

export const activities: ResourceDef = {
  id: "activities",
  name: "Activities",
  singular: "activity",
  idField: "arn",
  nameField: "Name",
  description: "Activities let code running anywhere (a worker) do a task in a state machine.",
  emptyText: "No activities.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "arn", label: "ARN", kind: "arn" },
    { key: "created", label: "Creation date", kind: "date" },
  ],

  async list(ctx) {
    const out: ActivityListItem[] = [];
    let token: string | undefined;
    do {
      const page = await ctx.clients.sfn.send(new ListActivitiesCommand({ nextToken: token }));
      out.push(...(page.activities ?? []));
      token = page.nextToken;
    } while (token);
    return out.map((a) => ({ name: a.name ?? null, arn: a.activityArn ?? null, created: isoOrNull(a.creationDate) }));
  },

  async get(ctx, arn) {
    const [a, tags] = await Promise.all([ctx.clients.sfn.send(new DescribeActivityCommand({ activityArn: arn })), secondary(activityTags(ctx, arn))]);
    return {
      summary: {
        Name: a.name ?? null,
        ARN: a.activityArn ?? arn,
        "Creation date": isoOrNull(a.creationDate),
        Encryption: a.encryptionConfiguration?.type === "CUSTOMER_MANAGED_KMS_KEY" ? `Customer managed key ${a.encryptionConfiguration.kmsKeyId ?? ""}` : "AWS owned key",
      },
      tabs: [
        {
          id: "usage",
          label: "Usage",
          kind: "text",
          data: `Use this ARN as the Resource of a Task state:\n  "Resource": "${a.activityArn ?? arn}"\nWorkers poll with GetActivityTask and report with SendTaskSuccess or SendTaskFailure.`,
        },
        {
          id: "tags",
          label: "Tags",
          kind: "table",
          columns: [
            { key: "Key", label: "Key", kind: "text" },
            { key: "Value", label: "Value", kind: "text" },
          ],
          data: tags.ok ? tags.value : [],
          emptyText: unavailableText(tags, "No tags."),
        },
      ],
    };
  },

  create: {
    title: "Create activity",
    description: "Creates an activity with CreateActivity.",
    fields: [
      { name: "name", label: "Activity name", kind: "text", required: true, validate: { pattern: "[A-Za-z0-9_-]{1,80}", message: "Up to 80 letters, numbers, hyphens or underscores." } },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags - optional" },
    ],
    async run(ctx, v) {
      const tags = Array.isArray(v.tags) ? (v.tags as Tag[]) : [];
      const r = await ctx.clients.sfn.send(new CreateActivityCommand({ name: text(v.name), tags: tags.length ? tags.map((t) => ({ key: t.Key, value: t.Value })) : undefined }));
      if (!r.activityArn) throw new Error("Step Functions returned no activity ARN.");
      return r.activityArn;
    },
  },

  actions: [
    manageTagsAction({
      read: activityTags,
      async tag(ctx, arn, tags) {
        await ctx.clients.sfn.send(new TagResourceCommand({ resourceArn: arn, tags: tags.map((t) => ({ key: t.Key, value: t.Value })) }));
      },
      async untag(ctx, arn, keys) {
        await ctx.clients.sfn.send(new UntagResourceCommand({ resourceArn: arn, tagKeys: keys }));
      },
    }),
  ],

  delete: {
    confirmText: "delete",
    async run(ctx, arn) {
      await ctx.clients.sfn.send(new DeleteActivityCommand({ activityArn: arn }));
    },
  },
};
