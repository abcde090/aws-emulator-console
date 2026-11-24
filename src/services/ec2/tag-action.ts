/**
 * "Manage tags" for EC2 resources (instances, volumes, security groups ...): the dialog
 * opens with the current tags and saving applies only the difference (CreateTags for added
 * or changed tags, DeleteTags for removed ones), so saving unchanged changes nothing.
 */

import { CreateTagsCommand, DeleteTagsCommand } from "@aws-sdk/client-ec2";
import type { ActionDef, Ctx, Tag } from "../../console/types.ts";
import { fieldTags, tagDiff, tagDiffMessage } from "../../console/tags.ts";
import { tagRows, type TagLike } from "./helpers.ts";

export async function saveEc2Tags(ctx: Ctx, id: string, desired: Tag[], current: TagLike[] | undefined): Promise<string> {
  const d = tagDiff(current, desired);
  if (d.remove.length) await ctx.clients.ec2.send(new DeleteTagsCommand({ Resources: [id], Tags: d.remove.map((Key) => ({ Key })) }));
  if (d.set.length) await ctx.clients.ec2.send(new CreateTagsCommand({ Resources: [id], Tags: d.set }));
  return tagDiffMessage(d);
}

export function ec2TagAction(what: string, read: (ctx: Ctx, id: string) => Promise<TagLike[] | undefined>): ActionDef {
  return {
    id: "tags",
    label: "Manage tags",
    fields: [{ name: "tags", label: "Tags", kind: "tags", help: `The ${what}'s tags, including Name. Removing a row deletes that tag.` }],
    async initialValues(ctx, id) {
      return { tags: tagRows(await read(ctx, id)) };
    },
    async run(ctx, id, v) {
      return { message: await saveEc2Tags(ctx, id, fieldTags(v.tags), await read(ctx, id)) };
    },
  };
}
