/**
 * Manage tags for EKS resources: the dialog opens with the current tags and only the
 * difference is applied (TagResource for added/changed keys, UntagResource for removed ones).
 */

import { ListTagsForResourceCommand, TagResourceCommand, UntagResourceCommand } from "@aws-sdk/client-eks";
import type { ActionDef, Ctx, FieldValues } from "../../console/types.ts";
import { recordTagDiff, recordToTags, tagDiffMessage } from "../../console/tags.ts";
import { tagsToRecord } from "./helpers.ts";

async function currentTags(ctx: Ctx, arn: string): Promise<Record<string, string>> {
  return (await ctx.clients.eks.send(new ListTagsForResourceCommand({ resourceArn: arn }))).tags ?? {};
}

export async function replaceTags(ctx: Ctx, arn: string, values: FieldValues): Promise<string> {
  const diff = recordTagDiff(await currentTags(ctx, arn), tagsToRecord(values.tags));
  if (diff.remove.length) await ctx.clients.eks.send(new UntagResourceCommand({ resourceArn: arn, tagKeys: diff.remove }));
  if (Object.keys(diff.set).length) await ctx.clients.eks.send(new TagResourceCommand({ resourceArn: arn, tags: diff.set }));
  return tagDiffMessage(diff);
}

/** A "Manage tags" action for a resource whose ARN is found by `arnOf`. */
export function manageTagsAction(arnOf: (ctx: Ctx, id: string) => Promise<string>): ActionDef {
  return {
    id: "tags",
    label: "Manage tags",
    fields: [{ name: "tags", label: "Tags", kind: "tags", help: "Remove a row to delete that tag." }],
    async initialValues(ctx, id) {
      return { tags: recordToTags(await currentTags(ctx, await arnOf(ctx, id))) };
    },
    async run(ctx, id, v) {
      return { message: await replaceTags(ctx, await arnOf(ctx, id), v) };
    },
  };
}
