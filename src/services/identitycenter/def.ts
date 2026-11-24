/**
 * IAM Identity Center: users and groups in the Identity Center directory (identitystore),
 * group memberships, and the instance settings (sso-admin). The emulator's instance is an
 * account instance, for which AWS doesn't offer permission sets or AWS account assignments;
 * that is listed in notSupported after checking the instance's PermissionSetsEnabled flag.
 */

import { secondary, unavailableText } from "../../console/secondary.ts";
import {
  CreateGroupCommand,
  CreateGroupMembershipCommand,
  CreateUserCommand,
  DeleteGroupCommand,
  DeleteGroupMembershipCommand,
  DeleteUserCommand,
  DescribeGroupCommand,
  DescribeUserCommand,
  ListGroupMembershipsCommand,
  ListGroupMembershipsForMemberCommand,
  ListGroupsCommand,
  ListUsersCommand,
  UpdateGroupCommand,
  UpdateUserCommand,
  type AttributeOperation,
  type Group,
  type User,
} from "@aws-sdk/client-identitystore";
import { DescribeInstanceCommand, ListApplicationsCommand, ListInstancesCommand, UpdateInstanceCommand, type InstanceMetadata } from "@aws-sdk/client-sso-admin";
import type { Ctx, Option, ResourceDef, Row, ServiceDef } from "../../console/types.ts";

const s = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : []);

async function instance(ctx: Ctx): Promise<InstanceMetadata> {
  const r = await ctx.clients.ssoadmin.send(new ListInstancesCommand({}));
  const i = r.Instances?.[0];
  if (!i?.IdentityStoreId || !i.InstanceArn) throw new Error("IAM Identity Center is not enabled in this account (ListInstances returned no instance).");
  return i;
}

async function storeId(ctx: Ctx): Promise<string> {
  return (await instance(ctx)).IdentityStoreId as string;
}

async function allUsers(ctx: Ctx, store: string): Promise<User[]> {
  const out: User[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.identitystore.send(new ListUsersCommand({ IdentityStoreId: store, NextToken: token }));
    out.push(...(r.Users ?? []));
    token = r.NextToken;
  } while (token);
  return out;
}

async function allGroups(ctx: Ctx, store: string): Promise<Group[]> {
  const out: Group[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.identitystore.send(new ListGroupsCommand({ IdentityStoreId: store, NextToken: token }));
    out.push(...(r.Groups ?? []));
    token = r.NextToken;
  } while (token);
  return out;
}

async function groupOptions(ctx: Ctx): Promise<Option[]> {
  return (await allGroups(ctx, await storeId(ctx))).map((g) => ({ value: g.GroupId ?? "", label: g.DisplayName ?? g.GroupId ?? "" })).filter((o) => o.value);
}

async function userOptions(ctx: Ctx): Promise<Option[]> {
  return (await allUsers(ctx, await storeId(ctx))).map((u) => ({ value: u.UserId ?? "", label: u.UserName ?? u.UserId ?? "" })).filter((o) => o.value);
}

async function membershipsFor(ctx: Ctx, store: string, userId: string) {
  const out: { MembershipId?: string; GroupId?: string }[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.identitystore.send(new ListGroupMembershipsForMemberCommand({ IdentityStoreId: store, MemberId: { UserId: userId }, NextToken: token }));
    out.push(...(r.GroupMemberships ?? []));
    token = r.NextToken;
  } while (token);
  return out;
}

const primaryEmail = (u: User) => u.Emails?.find((e) => e.Primary)?.Value ?? u.Emails?.[0]?.Value ?? null;

const users: ResourceDef = {
  id: "users",
  name: "Users",
  singular: "user",
  idField: "id",
  nameField: "Username",
  description: "Users in the Identity Center directory. They sign in through the AWS access portal.",
  emptyText: "No users. Add a user to the Identity Center directory.",
  columns: [
    { key: "username", label: "Username", kind: "link" },
    { key: "displayName", label: "Display name", kind: "text" },
    { key: "email", label: "Primary email", kind: "text" },
    { key: "id", label: "User ID", kind: "code", hidden: true },
  ],
  async list(ctx) {
    return (await allUsers(ctx, await storeId(ctx))).map((u) => ({ id: u.UserId ?? "", username: u.UserName ?? "", displayName: u.DisplayName ?? null, email: primaryEmail(u) }));
  },
  async get(ctx, id) {
    const store = await storeId(ctx);
    const [u, membershipsR, groupsR] = await Promise.all([
      ctx.clients.identitystore.send(new DescribeUserCommand({ IdentityStoreId: store, UserId: id })),
      secondary(membershipsFor(ctx, store, id)),
      secondary(allGroups(ctx, store)),
    ]);
    const groups = groupsR.ok ? groupsR.value : [];
    return {
      summary: {
        Username: u.UserName ?? id,
        "User ID": u.UserId ?? id,
        "Display name": u.DisplayName ?? null,
        "Primary email": primaryEmail(u),
        "First name": u.Name?.GivenName ?? null,
        "Last name": u.Name?.FamilyName ?? null,
        "Job title": u.Title ?? null,
        "Identity store ID": store,
      },
      tabs: [
        {
          id: "groups",
          label: "Groups",
          kind: "table",
          columns: [
            { key: "group", label: "Group name", kind: "text" },
            { key: "membershipId", label: "Membership ID", kind: "code" },
          ],
          data: (membershipsR.ok ? membershipsR.value : []).map((m) => ({ group: groups.find((g) => g.GroupId === m.GroupId)?.DisplayName ?? m.GroupId ?? "", membershipId: m.MembershipId ?? "" })),
          emptyText: unavailableText(membershipsR, "This user isn't in any groups."),
        },
        { id: "attributes", label: "Profile", kind: "json", data: { Emails: u.Emails ?? [], PhoneNumbers: u.PhoneNumbers ?? [], Addresses: u.Addresses ?? [], Locale: u.Locale ?? null, Timezone: u.Timezone ?? null, UserType: u.UserType ?? null } },
      ],
    };
  },
  create: {
    title: "Add user",
    description: "Creates the user in the Identity Center directory (identitystore CreateUser).",
    fields: [
      { name: "username", label: "Username", kind: "text", required: true, section: "Primary information", help: "Up to 128 characters. Users sign in to the AWS access portal with this name.", validate: { pattern: "[\\w+=,.@-]{1,128}", message: "Up to 128 letters, numbers and +=,.@-_." } },
      { name: "email", label: "Email address", kind: "text", required: true, section: "Primary information", validate: { pattern: "[^@\\s]+@[^@\\s]+\\.[^@\\s]+", message: "Enter an email address." } },
      { name: "givenName", label: "First name", kind: "text", required: true, section: "Primary information" },
      { name: "familyName", label: "Last name", kind: "text", required: true, section: "Primary information" },
      { name: "displayName", label: "Display name", kind: "text", required: true, section: "Primary information" },
      { name: "title", label: "Job title", kind: "text", section: "Contact methods - optional" },
      { name: "phone", label: "Phone number", kind: "text", section: "Contact methods - optional" },
      { name: "groups", label: "Add user to groups", kind: "multiselect", options: groupOptions, section: "Add user to groups - optional" },
    ],
    async run(ctx, v) {
      const store = await storeId(ctx);
      const r = await ctx.clients.identitystore.send(
        new CreateUserCommand({
          IdentityStoreId: store,
          UserName: s(v.username),
          DisplayName: s(v.displayName),
          Name: { GivenName: s(v.givenName), FamilyName: s(v.familyName) },
          Emails: [{ Value: s(v.email), Type: "work", Primary: true }],
          Title: s(v.title) || undefined,
          PhoneNumbers: s(v.phone) ? [{ Value: s(v.phone), Type: "work", Primary: true }] : undefined,
        })
      );
      if (!r.UserId) throw new Error("CreateUser returned no user ID.");
      for (const g of strs(v.groups)) await ctx.clients.identitystore.send(new CreateGroupMembershipCommand({ IdentityStoreId: store, GroupId: g, MemberId: { UserId: r.UserId } }));
      return r.UserId;
    },
  },
  actions: [
    {
      id: "edit",
      label: "Edit profile",
      fields: [
        { name: "displayName", label: "Display name", kind: "text", required: true },
        { name: "email", label: "Primary email address", kind: "text", required: true, validate: { pattern: "[^@\\s]+@[^@\\s]+\\.[^@\\s]+", message: "Enter an email address." } },
        { name: "title", label: "Job title", kind: "text" },
      ],
      async initialValues(ctx, id) {
        const u = await ctx.clients.identitystore.send(new DescribeUserCommand({ IdentityStoreId: await storeId(ctx), UserId: id }));
        return { displayName: u.DisplayName ?? "", email: primaryEmail(u) ?? "", title: u.Title ?? "" };
      },
      async run(ctx, id, v) {
        const store = await storeId(ctx);
        const u = await ctx.clients.identitystore.send(new DescribeUserCommand({ IdentityStoreId: store, UserId: id }));
        // Only the fields that changed: an unchanged dialog sends nothing.
        const ops: AttributeOperation[] = [];
        if (s(v.displayName) && s(v.displayName) !== (u.DisplayName ?? "")) ops.push({ AttributePath: "displayName", AttributeValue: s(v.displayName) });
        if (s(v.email) && s(v.email) !== (primaryEmail(u) ?? "")) ops.push({ AttributePath: "emails", AttributeValue: [{ value: s(v.email), type: "work", primary: true }] });
        if (s(v.title) !== (u.Title ?? "")) {
          if (!s(v.title)) throw new Error("Identity Center can't clear a job title from here; enter a new title instead.");
          ops.push({ AttributePath: "title", AttributeValue: s(v.title) });
        }
        if (!ops.length) return { message: "Nothing changed." };
        await ctx.clients.identitystore.send(new UpdateUserCommand({ IdentityStoreId: store, UserId: id, Operations: ops }));
        return { message: "User updated." };
      },
    },
    {
      id: "add-to-groups",
      label: "Add user to groups",
      fields: [{ name: "groups", label: "Groups", kind: "multiselect", required: true, options: groupOptions }],
      async run(ctx, id, v) {
        const store = await storeId(ctx);
        const list = strs(v.groups);
        for (const g of list) await ctx.clients.identitystore.send(new CreateGroupMembershipCommand({ IdentityStoreId: store, GroupId: g, MemberId: { UserId: id } }));
        return { message: `Added the user to ${list.length} group${list.length === 1 ? "" : "s"}.` };
      },
    },
    {
      id: "remove-from-groups",
      label: "Remove user from groups",
      danger: true,
      async run(ctx, id) {
        const store = await storeId(ctx);
        const [memberships, groups] = await Promise.all([membershipsFor(ctx, store, id), allGroups(ctx, store)]);
        return {
          table: {
            rowKey: "membershipId",
            columns: [{ key: "group", label: "Group name", kind: "text" }],
            rows: memberships.map((x) => ({ membershipId: x.MembershipId ?? "", group: groups.find((g) => g.GroupId === x.GroupId)?.DisplayName ?? x.GroupId ?? "" })),
            emptyText: "This user isn't in any groups.",
            selectionAction: { actionId: "delete-memberships", label: "Remove", danger: true, valuesField: "memberships" },
          },
        };
      },
    },
    {
      id: "delete-memberships",
      label: "Remove memberships",
      hidden: true,
      danger: true,
      fields: [{ name: "memberships", label: "Memberships", kind: "multiselect", required: true }],
      async run(ctx, _id, v) {
        const store = await storeId(ctx);
        const list = strs(v.memberships);
        for (const m of list) await ctx.clients.identitystore.send(new DeleteGroupMembershipCommand({ IdentityStoreId: store, MembershipId: m }));
        return { message: `Removed ${list.length} membership${list.length === 1 ? "" : "s"}.` };
      },
    },
  ],
  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      const store = await storeId(ctx);
      for (const x of await membershipsFor(ctx, store, id)) if (x.MembershipId) await ctx.clients.identitystore.send(new DeleteGroupMembershipCommand({ IdentityStoreId: store, MembershipId: x.MembershipId }));
      await ctx.clients.identitystore.send(new DeleteUserCommand({ IdentityStoreId: store, UserId: id }));
    },
  },
};

async function groupMemberships(ctx: Ctx, store: string, groupId: string) {
  const out: { MembershipId?: string; MemberId?: { UserId?: string } }[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.identitystore.send(new ListGroupMembershipsCommand({ IdentityStoreId: store, GroupId: groupId, NextToken: token }));
    out.push(...((r.GroupMemberships ?? []) as { MembershipId?: string; MemberId?: { UserId?: string } }[]));
    token = r.NextToken;
  } while (token);
  return out;
}

async function memberRows(ctx: Ctx, store: string, groupId: string): Promise<Row[]> {
  const [m, us] = await Promise.all([groupMemberships(ctx, store, groupId), allUsers(ctx, store)]);
  return m.map((x) => {
    const u = us.find((y) => y.UserId === x.MemberId?.UserId);
    return { membershipId: x.MembershipId ?? "", username: u?.UserName ?? x.MemberId?.UserId ?? "", displayName: u?.DisplayName ?? null };
  });
}

const groups: ResourceDef = {
  id: "groups",
  name: "Groups",
  singular: "group",
  idField: "id",
  nameField: "Group name",
  description: "Groups of users in the Identity Center directory.",
  emptyText: "No groups. Create a group to manage access for several users at once.",
  columns: [
    { key: "name", label: "Group name", kind: "link" },
    { key: "description", label: "Description", kind: "text" },
    { key: "id", label: "Group ID", kind: "code", hidden: true },
  ],
  async list(ctx) {
    return (await allGroups(ctx, await storeId(ctx))).map((g) => ({ id: g.GroupId ?? "", name: g.DisplayName ?? "", description: g.Description ?? null }));
  },
  async get(ctx, id) {
    const store = await storeId(ctx);
    const [g, membersR] = await Promise.all([ctx.clients.identitystore.send(new DescribeGroupCommand({ IdentityStoreId: store, GroupId: id })), secondary(memberRows(ctx, store, id))]);
    return {
      summary: { "Group name": g.DisplayName ?? id, "Group ID": g.GroupId ?? id, Description: g.Description ?? null, "Identity store ID": store },
      tabs: [
        {
          id: "members",
          label: "Users",
          kind: "table",
          columns: [
            { key: "username", label: "Username", kind: "text" },
            { key: "displayName", label: "Display name", kind: "text" },
          ],
          data: membersR.ok ? membersR.value : [],
          emptyText: unavailableText(membersR, "No users in this group."),
        },
      ],
    };
  },
  create: {
    title: "Create group",
    fields: [
      { name: "name", label: "Group name", kind: "text", required: true, section: "Group details", validate: { max: 1024, message: "At most 1024 characters." } },
      { name: "description", label: "Description", kind: "textarea", section: "Group details", validate: { max: 1024, message: "At most 1024 characters." } },
      { name: "users", label: "Add users to group", kind: "multiselect", options: userOptions, section: "Add users to group - optional" },
    ],
    async run(ctx, v) {
      const store = await storeId(ctx);
      const r = await ctx.clients.identitystore.send(new CreateGroupCommand({ IdentityStoreId: store, DisplayName: s(v.name), Description: s(v.description) || undefined }));
      if (!r.GroupId) throw new Error("CreateGroup returned no group ID.");
      for (const u of strs(v.users)) await ctx.clients.identitystore.send(new CreateGroupMembershipCommand({ IdentityStoreId: store, GroupId: r.GroupId, MemberId: { UserId: u } }));
      return r.GroupId;
    },
  },
  actions: [
    {
      id: "add-users",
      label: "Add users to group",
      fields: [{ name: "users", label: "Users", kind: "multiselect", required: true, options: userOptions }],
      async run(ctx, id, v) {
        const store = await storeId(ctx);
        const list = strs(v.users);
        for (const u of list) await ctx.clients.identitystore.send(new CreateGroupMembershipCommand({ IdentityStoreId: store, GroupId: id, MemberId: { UserId: u } }));
        return { message: `Added ${list.length} user${list.length === 1 ? "" : "s"}.` };
      },
    },
    {
      id: "remove-users",
      label: "Remove users from group",
      danger: true,
      async run(ctx, id) {
        return {
          table: {
            rowKey: "membershipId",
            columns: [
              { key: "username", label: "Username", kind: "text" },
              { key: "displayName", label: "Display name", kind: "text" },
            ],
            rows: await memberRows(ctx, await storeId(ctx), id),
            emptyText: "No users in this group.",
            selectionAction: { actionId: "delete-memberships", label: "Remove", danger: true, valuesField: "memberships" },
          },
        };
      },
    },
    {
      id: "delete-memberships",
      label: "Remove memberships",
      hidden: true,
      danger: true,
      fields: [{ name: "memberships", label: "Memberships", kind: "multiselect", required: true }],
      async run(ctx, _id, v) {
        const store = await storeId(ctx);
        const list = strs(v.memberships);
        for (const m of list) await ctx.clients.identitystore.send(new DeleteGroupMembershipCommand({ IdentityStoreId: store, MembershipId: m }));
        return { message: `Removed ${list.length} user${list.length === 1 ? "" : "s"} from the group.` };
      },
    },
    {
      id: "edit-description",
      label: "Edit description",
      fields: [{ name: "description", label: "Description", kind: "textarea", required: true, validate: { max: 1024, message: "At most 1024 characters." } }],
      async initialValues(ctx, id) {
        const g = await ctx.clients.identitystore.send(new DescribeGroupCommand({ IdentityStoreId: await storeId(ctx), GroupId: id }));
        return { description: g.Description ?? "" };
      },
      async run(ctx, id, v) {
        const store = await storeId(ctx);
        const g = await ctx.clients.identitystore.send(new DescribeGroupCommand({ IdentityStoreId: store, GroupId: id }));
        if (s(v.description) === (g.Description ?? "")) return { message: "Nothing changed." };
        await ctx.clients.identitystore.send(new UpdateGroupCommand({ IdentityStoreId: store, GroupId: id, Operations: [{ AttributePath: "description", AttributeValue: s(v.description) }] }));
        return { message: "Description updated." };
      },
    },
  ],
  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      const store = await storeId(ctx);
      for (const m of await memberRows(ctx, store, id)) await ctx.clients.identitystore.send(new DeleteGroupMembershipCommand({ IdentityStoreId: store, MembershipId: String(m.membershipId) }));
      await ctx.clients.identitystore.send(new DeleteGroupCommand({ IdentityStoreId: store, GroupId: id }));
    },
  },
};

const settings: ResourceDef = {
  id: "settings",
  name: "Settings",
  singular: "instance",
  idField: "id",
  nameField: "Instance name",
  description: "Your IAM Identity Center instance: identity source, Region and ARNs.",
  columns: [
    { key: "name", label: "Instance name", kind: "link" },
    { key: "id", label: "Instance ID", kind: "code" },
    { key: "status", label: "Status", kind: "status" },
    { key: "identityStore", label: "Identity store ID", kind: "code" },
    { key: "created", label: "Created", kind: "date" },
  ],
  async list(ctx) {
    const r = await ctx.clients.ssoadmin.send(new ListInstancesCommand({}));
    return (r.Instances ?? []).map((i) => ({ id: (i.InstanceArn ?? "").replace(/^.*instance\//, ""), arn: i.InstanceArn ?? "", name: i.Name ?? "-", status: i.Status ?? null, identityStore: i.IdentityStoreId ?? null, created: i.CreatedDate ?? null }));
  },
  async get(ctx, id) {
    const arn = `arn:aws:sso:::instance/${id}`;
    const [d, appsR] = await Promise.all([ctx.clients.ssoadmin.send(new DescribeInstanceCommand({ InstanceArn: arn })), secondary(ctx.clients.ssoadmin.send(new ListApplicationsCommand({ InstanceArn: arn })))]);
    const apps = { Applications: appsR.ok ? appsR.value.Applications : [] };
    const extra = d as unknown as { PermissionSetsEnabled?: boolean; PrimaryRegion?: string };
    return {
      summary: {
        "Instance name": d.Name ?? id,
        "Instance ARN": d.InstanceArn ?? arn,
        Status: d.Status ?? null,
        "Identity source": "Identity Center directory",
        "Identity store ID": d.IdentityStoreId ?? null,
        "Owner account": d.OwnerAccountId ?? null,
        "Primary Region": extra.PrimaryRegion ?? ctx.region,
        "Instance type": extra.PermissionSetsEnabled === false ? "Account instance (no permission sets)" : "Organization instance",
        Created: d.CreatedDate ?? null,
        "AWS access portal URL": d.IdentityStoreId ? `https://${d.IdentityStoreId}.awsapps.com/start` : null,
      },
      tabs: [
        {
          id: "applications",
          label: "Applications",
          kind: "table",
          columns: [
            { key: "name", label: "Application", kind: "text" },
            { key: "status", label: "Status", kind: "status" },
            { key: "arn", label: "ARN", kind: "arn" },
          ],
          data: (apps.Applications ?? []).map((a) => ({ name: a.Name ?? "", status: a.Status ?? null, arn: a.ApplicationArn ?? null })),
          emptyText: unavailableText(appsR, "No applications."),
        },
      ],
    };
  },
  actions: [
    {
      id: "rename",
      label: "Edit instance name",
      fields: [{ name: "name", label: "Instance name", kind: "text", required: true, validate: { max: 255, message: "At most 255 characters." } }],
      async initialValues(ctx, id) {
        const d = await ctx.clients.ssoadmin.send(new DescribeInstanceCommand({ InstanceArn: `arn:aws:sso:::instance/${id}` }));
        return { name: d.Name ?? "" };
      },
      async run(ctx, id, v) {
        await ctx.clients.ssoadmin.send(new UpdateInstanceCommand({ InstanceArn: `arn:aws:sso:::instance/${id}`, Name: s(v.name) }));
        return { message: "Instance name updated." };
      },
    },
  ],
};

export const identitycenterService: ServiceDef = {
  id: "identitycenter",
  name: "IAM Identity Center",
  category: "Security, Identity, & Compliance",
  description: "Manage workforce users and groups and their access to AWS accounts and applications.",
  resources: [users, groups, settings],
  notSupported: [
    "Permission sets and AWS account assignments: the emulator's Identity Center is an account instance, and sso-admin rejects these APIs for it",
    "Attributes for access control",
  ],
};
