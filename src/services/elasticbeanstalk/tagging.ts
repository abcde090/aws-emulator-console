/**
 * Tags for Elastic Beanstalk resources (ListTagsForResource / UpdateTagsForResource), and
 * tolerant secondary tabs so one denied lookup doesn't take a whole page down.
 */

import { fieldTags, noTagChanges, tagDiff, tagDiffMessage } from "../../console/tags.ts";
import { ListTagsForResourceCommand, UpdateTagsForResourceCommand } from "@aws-sdk/client-elastic-beanstalk";
import type { ActionDef, Ctx, DetailTab, Tag } from "../../console/types.ts";

export async function readTags(ctx: Ctx, arn: string | undefined): Promise<Tag[]> {
  if (!arn) return [];
  const r = await ctx.clients.elasticbeanstalk.send(new ListTagsForResourceCommand({ ResourceArn: arn }));
  return (r.ResourceTags ?? []).map((t) => ({ Key: t.Key ?? "", Value: t.Value ?? "" }));
}

/** Runs a secondary tab's lookup; when it fails (e.g. AccessDenied) the tab shows the error instead. */
export async function tolerantTab(load: () => Promise<DetailTab>, fallback: Pick<DetailTab, "id" | "label">): Promise<DetailTab> {
  try {
    return await load();
  } catch (err: unknown) {
    return { ...fallback, kind: "text", data: `Unavailable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Tags the user manages: Beanstalk's own elasticbeanstalk: and aws: tags are left alone. */
function userTags(tags: Tag[]): Tag[] {
  return tags.filter((t) => !t.Key.startsWith("elasticbeanstalk:") && !t.Key.startsWith("aws:"));
}

export function tagsTab(tags: Tag[], emptyText: string): DetailTab {
  return {
    id: "tags",
    label: "Tags",
    kind: "table",
    columns: [
      { key: "Key", label: "Key", kind: "text" },
      { key: "Value", label: "Value", kind: "text" },
    ],
    data: tags,
    emptyText,
  };
}

/** A "Manage tags" action: opens with the current tags and applies only the difference. */
export function manageTagsAction(arnOf: (ctx: Ctx, id: string) => Promise<string>): ActionDef {
  return {
    id: "tags",
    label: "Manage tags",
    fields: [{ name: "tags", label: "Tags", kind: "tags", help: "Remove a row to delete that tag. The elasticbeanstalk: tags Beanstalk adds itself aren't shown and stay." }],
    async initialValues(ctx, id) {
      return { tags: userTags(await readTags(ctx, await arnOf(ctx, id))) };
    },
    async run(ctx, id, v) {
      const arn = await arnOf(ctx, id);
      const diff = tagDiff(userTags(await readTags(ctx, arn)), fieldTags(v.tags));
      if (noTagChanges(diff)) return { message: tagDiffMessage(diff) };
      await ctx.clients.elasticbeanstalk.send(
        new UpdateTagsForResourceCommand({ ResourceArn: arn, TagsToAdd: diff.set.length ? diff.set : undefined, TagsToRemove: diff.remove.length ? diff.remove : undefined })
      );
      return { message: tagDiffMessage(diff) };
    },
  };
}
