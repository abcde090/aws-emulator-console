/** IAM user groups: list, create (users + permissions), members, permissions and delete. */

import { AddUserToGroupCommand, CreateGroupCommand, DeleteGroupCommand, GetGroupCommand, RemoveUserFromGroupCommand, UpdateGroupCommand } from "@aws-sdk/client-iam";
import type { Ctx, ResourceDef } from "../../console/types.ts";
import { secondary } from "../../console/secondary.ts";
import { allGroups, orDenied, PATH_PATTERN, plural, policyOptions, strings, text, userOptions } from "./common.ts";
import { attach, attachedPolicies, clearPermissions, inlineDocuments, PERMISSION_COLUMNS, permissionActions, permissionRows } from "./permissions.ts";

const GROUP_NAME = "[\\w+=,.@-]{1,128}";

async function members(ctx: Ctx, group: string): Promise<string[]> {
  const out: string[] = [];
  let marker: string | undefined;
  do {
    const r = await ctx.clients.iam.send(new GetGroupCommand({ GroupName: group, Marker: marker }));
    out.push(...(r.Users ?? []).map((u) => u.UserName ?? "").filter(Boolean));
    marker = r.IsTruncated ? r.Marker : undefined;
  } while (marker);
  return out;
}

export const groups: ResourceDef = {
  id: "groups",
  name: "User groups",
  singular: "user group",
  idField: "name",
  nameField: "User group name",
  description: "A user group is a collection of IAM users. Use groups to specify permissions for a collection of users.",
  emptyText: "No user groups to display.",
  columns: [
    { key: "name", label: "Group name", kind: "link" },
    { key: "users", label: "Users", kind: "count" },
    { key: "permissions", label: "Permissions", kind: "text" },
    { key: "created", label: "Creation time", kind: "date" },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],

  async list(ctx) {
    const list = await allGroups(ctx);
    return Promise.all(
      list.map(async (g) => {
        const name = g.GroupName ?? "";
        // Secondary reads: a denied one marks its cell unavailable instead of failing the list.
        const [users, policies] = await Promise.all([orDenied(() => members(ctx, name), null), orDenied(() => attachedPolicies(ctx, "group", name), null)]);
        return { name, users: users ? users.length : null, permissions: policies === null ? "Unavailable" : policies.length ? "Defined" : "Not defined", created: g.CreateDate ?? null, arn: g.Arn ?? null };
      })
    );
  },

  async get(ctx, name) {
    const [r, perms, inline] = await Promise.all([ctx.clients.iam.send(new GetGroupCommand({ GroupName: name })), secondary(() => permissionRows(ctx, "group", name)), secondary(() => inlineDocuments(ctx, "group", name))]);
    const userList = [...(r.Users ?? [])];
    for (let marker = r.IsTruncated ? r.Marker : undefined; marker; ) {
      const next = await ctx.clients.iam.send(new GetGroupCommand({ GroupName: name, Marker: marker }));
      userList.push(...(next.Users ?? []));
      marker = next.IsTruncated ? next.Marker : undefined;
    }
    return {
      summary: { "User group name": r.Group?.GroupName ?? name, ARN: r.Group?.Arn ?? null, "Creation time": r.Group?.CreateDate ?? null, Path: r.Group?.Path ?? "/" },
      tabs: [
        {
          id: "users",
          label: "Users",
          kind: "table",
          columns: [
            { key: "name", label: "User name", kind: "text", href: "/iam/users/{name}" },
            { key: "created", label: "Creation time", kind: "date" },
            { key: "arn", label: "ARN", kind: "arn" },
          ],
          data: userList.map((u) => ({ name: u.UserName ?? "", created: u.CreateDate ?? null, arn: u.Arn ?? null })),
          description: "An IAM user can be a member of up to 10 groups.",
          emptyText: "No users in this group.",
        },
        { id: "permissions", label: "Permissions", kind: "table", columns: PERMISSION_COLUMNS.filter((c) => c.key !== "attachedVia"), data: perms.ok ? perms.value : [], emptyText: perms.ok ? "No permissions policies attached." : `Unavailable: ${perms.error}` },
        { id: "inline", label: "Inline policies", kind: "json", data: inline.ok ? inline.value : null, emptyText: inline.ok ? "No inline policies." : `Unavailable: ${inline.error}` },
      ],
    };
  },

  create: {
    title: "Create user group",
    description: "Creates the group with CreateGroup, adds users and attaches permissions policies.",
    fields: [
      { name: "name", label: "User group name", kind: "text", required: true, section: "Name the group", help: "Maximum 128 characters. Use alphanumeric and '+=,.@-_' characters.", validate: { pattern: GROUP_NAME, message: "Use up to 128 letters, numbers and +=,.@-_ characters." } },
      { name: "path", label: "Path", kind: "text", default: "/", section: "Name the group", validate: { pattern: PATH_PATTERN, message: "A path starts and ends with /." } },
      { name: "users", label: "Add users to the group", kind: "multiselect", options: userOptions, section: "Add users to the group - optional" },
      { name: "policies", label: "Attach permissions policies", kind: "multiselect", options: policyOptions, section: "Attach permissions policies - optional", help: "You can attach up to 10 policies to this user group." },
    ],
    async run(ctx, v) {
      const name = text(v.name);
      await ctx.clients.iam.send(new CreateGroupCommand({ GroupName: name, Path: text(v.path) || "/" }));
      for (const u of strings(v.users)) await ctx.clients.iam.send(new AddUserToGroupCommand({ GroupName: name, UserName: u }));
      for (const p of strings(v.policies)) await attach(ctx, "group", name, p);
      return name;
    },
  },

  actions: [
    {
      id: "add-users",
      label: "Add users",
      fields: [{ name: "users", label: "Users", kind: "multiselect", required: true, options: userOptions }],
      async run(ctx, name, v) {
        const list = strings(v.users);
        for (const u of list) await ctx.clients.iam.send(new AddUserToGroupCommand({ GroupName: name, UserName: u }));
        return { message: `Added ${plural(list.length, "user")} to ${name}.` };
      },
    },
    {
      id: "remove-users",
      label: "Remove users",
      async run(ctx, name) {
        return {
          table: {
            rowKey: "user",
            columns: [{ key: "user", label: "User name", kind: "text" }],
            rows: (await members(ctx, name)).map((user) => ({ user })),
            emptyText: "No users in this group.",
            selectionAction: { actionId: "remove-members", label: "Remove", danger: true, valuesField: "users" },
          },
        };
      },
    },
    {
      id: "remove-members",
      label: "Remove members",
      hidden: true,
      danger: true,
      fields: [{ name: "users", label: "Users", kind: "multiselect", required: true }],
      async run(ctx, name, v) {
        const list = strings(v.users);
        for (const u of list) await ctx.clients.iam.send(new RemoveUserFromGroupCommand({ GroupName: name, UserName: u }));
        return { message: `Removed ${plural(list.length, "user")} from ${name}.` };
      },
    },
    ...permissionActions("group"),
    {
      id: "rename",
      label: "Edit name",
      fields: [{ name: "newName", label: "User group name", kind: "text", required: true, validate: { pattern: GROUP_NAME, message: "Use up to 128 letters, numbers and +=,.@-_ characters." } }],
      async initialValues(_ctx, name) {
        return { newName: name };
      },
      async run(ctx, name, v) {
        if (text(v.newName) === name) return { message: `No changes to ${name}.` };
        await ctx.clients.iam.send(new UpdateGroupCommand({ GroupName: name, NewGroupName: text(v.newName) }));
        return { message: `Renamed ${name} to ${text(v.newName)}. Open it from the User groups list.` };
      },
    },
  ],

  delete: {
    confirmText: "name",
    async run(ctx, name) {
      for (const u of await members(ctx, name)) await ctx.clients.iam.send(new RemoveUserFromGroupCommand({ GroupName: name, UserName: u }));
      await clearPermissions(ctx, "group", name);
      await ctx.clients.iam.send(new DeleteGroupCommand({ GroupName: name }));
    },
  },
};
