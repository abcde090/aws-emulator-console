/**
 * AWS CodeCommit: repositories, pull requests and approval rule templates. The repository
 * screen is hand-built (src/app/codecommit/repositories/[repo]) because it holds the code
 * browser and commit history; its other tabs come from get() below.
 */

import {
  AssociateApprovalRuleTemplateWithRepositoryCommand,
  CreateBranchCommand,
  CreateRepositoryCommand,
  DeleteBranchCommand,
  DeleteFileCommand,
  DeleteRepositoryCommand,
  DisassociateApprovalRuleTemplateFromRepositoryCommand,
  GetBranchCommand,
  GetRepositoryCommand,
  GetRepositoryTriggersCommand,
  ListAssociatedApprovalRuleTemplatesForRepositoryCommand,
  ListTagsForResourceCommand,
  PutFileCommand,
  PutRepositoryTriggersCommand,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateDefaultBranchCommand,
  UpdateRepositoryDescriptionCommand,
  type RepositoryTrigger,
  type RepositoryTriggerEventEnum,
} from "@aws-sdk/client-codecommit";
import { ListFunctionsCommand } from "@aws-sdk/client-lambda";
import { ListTopicsCommand } from "@aws-sdk/client-sns";
import type { Ctx, FieldValues, Option, ResourceDef, Row, ServiceDef, Tag } from "../../console/types.ts";
import { BRANCH_NAME, lines, REPO_NAME } from "./helpers.ts";
import { pullRequests } from "./pull-requests.ts";
import { getRepositories, listBranches, listRepositoryNames, resolveCommit } from "./repo-read.ts";
import { secondary } from "../../console/secondary.ts";
import { fieldTags, recordTagDiff, recordToTags, tagDiffMessage, tagsToRecord } from "../../console/tags.ts";
import { approvalRuleTemplates, templateOptions } from "./templates.ts";

const TRIGGER_EVENTS: Option[] = [
  { value: "all", label: "All repository events" },
  { value: "updateReference", label: "Push to existing branch" },
  { value: "createReference", label: "Create branch or tag" },
  { value: "deleteReference", label: "Delete branch or tag" },
];

const text = (v: unknown): string => (typeof v === "string" ? v : "");
const optional = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

async function repositoryArn(ctx: Ctx, repo: string): Promise<string> {
  const r = await ctx.clients.codecommit.send(new GetRepositoryCommand({ repositoryName: repo }));
  const arn = r.repositoryMetadata?.Arn;
  if (!arn) throw new Error(`CodeCommit returned no ARN for ${repo}.`);
  return arn;
}

async function topicOptions(ctx: Ctx): Promise<Option[]> {
  const out: Option[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.sns.send(new ListTopicsCommand({ NextToken: token }));
    for (const t of r.Topics ?? []) if (t.TopicArn) out.push({ value: t.TopicArn, label: `Amazon SNS: ${t.TopicArn.split(":").pop()}` });
    token = r.NextToken;
  } while (token);
  return out;
}

async function functionOptions(ctx: Ctx): Promise<Option[]> {
  const out: Option[] = [];
  let marker: string | undefined;
  do {
    const r = await ctx.clients.lambda.send(new ListFunctionsCommand({ Marker: marker }));
    for (const f of r.Functions ?? []) if (f.FunctionArn) out.push({ value: f.FunctionArn, label: `AWS Lambda: ${f.FunctionName ?? f.FunctionArn}` });
    marker = r.NextMarker;
  } while (marker);
  return out;
}

async function triggerTargets(ctx: Ctx): Promise<Option[]> {
  const [topics, functions] = await Promise.all([topicOptions(ctx), functionOptions(ctx)]);
  return [...topics, ...functions];
}

async function branchOptions(ctx: Ctx, repo?: string): Promise<Option[]> {
  if (!repo) return [];
  return (await listBranches(ctx.clients.codecommit, repo)).map((b) => ({ value: b, label: b }));
}

async function repoMeta(ctx: Ctx, repo: string) {
  return (await ctx.clients.codecommit.send(new GetRepositoryCommand({ repositoryName: repo }))).repositoryMetadata ?? {};
}

async function readTriggers(ctx: Ctx, repo: string): Promise<RepositoryTrigger[]> {
  const r = await ctx.clients.codecommit.send(new GetRepositoryTriggersCommand({ repositoryName: repo }));
  return r.triggers ?? [];
}

function commitFields(v: FieldValues) {
  return { name: optional(v.authorName), email: optional(v.email), commitMessage: optional(v.message) };
}

const authorFields = [
  { name: "authorName", label: "Author name", kind: "text" as const, help: "Shown as the commit's author." },
  { name: "email", label: "Email address", kind: "text" as const },
  { name: "message", label: "Commit message", kind: "textarea" as const },
];

const repositories: ResourceDef = {
  id: "repositories",
  name: "Repositories",
  singular: "repository",
  idField: "name",
  nameField: "name",
  description: "Private Git repositories hosted by CodeCommit.",
  emptyText: "No repositories. Create a repository to get started.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "description", label: "Description", kind: "text" },
    { key: "lastModified", label: "Last modified", kind: "date" },
    { key: "cloneUrlHttp", label: "Clone URL (HTTPS)", kind: "code" },
    { key: "cloneUrlSsh", label: "Clone URL (SSH)", kind: "code", hidden: true },
    { key: "defaultBranch", label: "Default branch", kind: "text", hidden: true },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],

  async list(ctx) {
    const repos = await getRepositories(ctx.clients.codecommit, await listRepositoryNames(ctx.clients.codecommit));
    return repos.map(
      (r): Row => ({
        name: r.repositoryName ?? "",
        description: r.repositoryDescription ?? null,
        lastModified: r.lastModifiedDate ?? null,
        cloneUrlHttp: r.cloneUrlHttp ?? null,
        cloneUrlSsh: r.cloneUrlSsh ?? null,
        defaultBranch: r.defaultBranch ?? null,
        arn: r.Arn ?? null,
      })
    );
  },

  async get(ctx, repo) {
    const cc = ctx.clients.codecommit;
    const meta = (await cc.send(new GetRepositoryCommand({ repositoryName: repo }))).repositoryMetadata ?? {};
    const [branches, triggersR, templatesR, tagsR] = await Promise.all([
      listBranches(cc, repo),
      secondary(readTriggers(ctx, repo)),
      secondary(cc.send(new ListAssociatedApprovalRuleTemplatesForRepositoryCommand({ repositoryName: repo })).then((r) => r.approvalRuleTemplateNames ?? [])),
      secondary(meta.Arn ? cc.send(new ListTagsForResourceCommand({ resourceArn: meta.Arn })).then((r) => r.tags ?? {}) : Promise.resolve({} as Record<string, string>)),
    ]);
    const triggers = triggersR.ok ? triggersR.value : [];
    const templateNames = templatesR.ok ? templatesR.value : [];
    const tags = tagsR.ok ? tagsR.value : {};
    const unavailable = (r: { ok: boolean; error?: string }) => (r.ok ? undefined : `Unavailable: ${r.error}`);
    const branchRows = await Promise.all(
      branches.map(async (b) => {
        const r = await cc.send(new GetBranchCommand({ repositoryName: repo, branchName: b }));
        return { name: b, commitId: r.branch?.commitId ?? null, isDefault: b === meta.defaultBranch ? "Default" : "" };
      })
    );
    return {
      summary: {
        name: meta.repositoryName ?? repo,
        description: meta.repositoryDescription ?? null,
        arn: meta.Arn ?? null,
        defaultBranch: meta.defaultBranch ?? "No branches yet",
        cloneUrlHttp: meta.cloneUrlHttp ?? null,
        cloneUrlSsh: meta.cloneUrlSsh ?? null,
      },
      summaryLabels: { name: "Repository name", description: "Description", arn: "ARN", defaultBranch: "Default branch", cloneUrlHttp: "Clone URL (HTTPS)", cloneUrlSsh: "Clone URL (SSH)" },
      tabs: [
        {
          id: "branches",
          label: "Branches",
          kind: "table",
          columns: [
            { key: "name", label: "Branch name", kind: "text" },
            { key: "isDefault", label: "Default", kind: "text" },
            { key: "commitId", label: "Last commit", kind: "code" },
          ],
          data: branchRows,
          emptyText: "This repository has no branches. Add a file to create the first commit and branch.",
        },
        {
          id: "settings",
          label: "Settings",
          kind: "keyvalue",
          data: {
            "Repository name": meta.repositoryName ?? repo,
            "Repository ID": meta.repositoryId ?? null,
            Description: meta.repositoryDescription ?? "-",
            "Default branch": meta.defaultBranch ?? "-",
            "AWS KMS key": meta.kmsKeyId ?? null,
            "Creation date": meta.creationDate ?? null,
            "Last modified": meta.lastModifiedDate ?? null,
          },
        },
        {
          id: "triggers",
          label: "Triggers",
          kind: "table",
          columns: [
            { key: "name", label: "Trigger name", kind: "text" },
            { key: "events", label: "Events", kind: "text" },
            { key: "branches", label: "Branches", kind: "text" },
            { key: "destinationArn", label: "Destination", kind: "arn" },
            { key: "customData", label: "Custom data", kind: "text" },
          ],
          data: triggers.map((t) => ({
            name: t.name ?? "",
            events: (t.events ?? []).join(", "),
            branches: (t.branches ?? []).length ? (t.branches ?? []).join(", ") : "All branches",
            destinationArn: t.destinationArn ?? null,
            customData: t.customData ?? null,
          })),
          emptyText: "No triggers. Create a trigger to notify Amazon SNS or AWS Lambda about repository events.",
          description: unavailable(triggersR),
        },
        {
          id: "approval-templates",
          label: "Approval rule templates",
          kind: "table",
          columns: [{ key: "name", label: "Associated approval rule template", kind: "text" }],
          data: templateNames.map((name) => ({ name })),
          emptyText: "No approval rule templates are associated with this repository.",
          description: unavailable(templatesR),
        },
        {
          id: "tags",
          label: "Repository tags",
          kind: "table",
          columns: [
            { key: "Key", label: "Key", kind: "text" },
            { key: "Value", label: "Value", kind: "text" },
          ],
          data: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
          emptyText: "No tags.",
          description: unavailable(tagsR),
        },
      ],
    };
  },

  create: {
    title: "Create repository",
    description: "Creates a CodeCommit repository in the emulator with CreateRepository.",
    fields: [
      {
        name: "name", label: "Repository name", kind: "text", required: true, section: "Repository settings", placeholder: "my-repo",
        help: "Up to 100 letters, numbers, periods, underscores and dashes. Can't end with .git.",
        validate: { pattern: REPO_NAME, message: "Use up to 100 letters, numbers, periods, underscores or dashes (not ending in .git)." },
      },
      { name: "description", label: "Description", kind: "textarea", section: "Repository settings", validate: { max: 1000, message: "At most 1,000 characters." } },
      { name: "tags", label: "Tags", kind: "tags", section: "Repository settings" },
      { name: "kmsKeyId", label: "AWS KMS key", kind: "text", section: "Additional configuration", help: "A KMS key ID, alias or ARN. Leave empty to use the AWS managed key (aws/codecommit)." },
    ],
    async run(ctx, v) {
      const name = String(v.name);
      const tags = Array.isArray(v.tags) ? Object.fromEntries((v.tags as Tag[]).map((t) => [t.Key, t.Value])) : {};
      await ctx.clients.codecommit.send(
        new CreateRepositoryCommand({
          repositoryName: name,
          repositoryDescription: optional(v.description),
          tags: Object.keys(tags).length ? tags : undefined,
          kmsKeyId: optional(v.kmsKeyId),
        })
      );
      return name;
    },
  },

  actions: [
    {
      id: "create-branch",
      label: "Create branch",
      fields: [
        { name: "branchName", label: "Branch name", kind: "text", required: true, validate: { pattern: BRANCH_NAME, message: "Not a valid Git branch name." } },
        { name: "from", label: "Branch from", kind: "text", help: "A branch name or a full commit ID. Leave empty for the default branch." },
      ],
      async run(ctx, repo, v) {
        const cc = ctx.clients.codecommit;
        let from = text(v.from);
        if (from === "") {
          from = (await cc.send(new GetRepositoryCommand({ repositoryName: repo }))).repositoryMetadata?.defaultBranch ?? "";
          if (from === "") throw new Error("The repository has no commits yet, so there is nothing to branch from. Add a file first.");
        }
        const commitId = await resolveCommit(cc, repo, from);
        await cc.send(new CreateBranchCommand({ repositoryName: repo, branchName: String(v.branchName), commitId }));
        return { message: `Created branch ${String(v.branchName)} from ${from} (${commitId.slice(0, 8)}).` };
      },
    },
    {
      id: "delete-branch",
      label: "Delete branch",
      danger: true,
      fields: [{ name: "branchName", label: "Branch name", kind: "select", required: true, options: branchOptions, help: "You can't delete the default branch." }],
      async run(ctx, repo, v) {
        const r = await ctx.clients.codecommit.send(new DeleteBranchCommand({ repositoryName: repo, branchName: String(v.branchName) }));
        if (!r.deletedBranch) throw new Error(`CodeCommit found no branch named ${String(v.branchName)}.`);
        return { message: `Deleted branch ${r.deletedBranch.branchName ?? String(v.branchName)} (was ${r.deletedBranch.commitId?.slice(0, 8) ?? "?"}).` };
      },
    },
    {
      id: "default-branch",
      label: "Change default branch",
      fields: [{ name: "branchName", label: "Default branch", kind: "select", required: true, options: branchOptions }],
      async initialValues(ctx, repo) {
        const b = (await repoMeta(ctx, repo)).defaultBranch;
        const values: FieldValues = b ? { branchName: b } : {};
        return values;
      },
      async run(ctx, repo, v) {
        await ctx.clients.codecommit.send(new UpdateDefaultBranchCommand({ repositoryName: repo, defaultBranchName: String(v.branchName) }));
        return { message: `The default branch is now ${String(v.branchName)}.` };
      },
    },
    {
      id: "edit-description",
      label: "Edit description",
      fields: [{ name: "description", label: "Description", kind: "textarea", validate: { max: 1000, message: "At most 1,000 characters." } }],
      async initialValues(ctx, repo) {
        return { description: (await repoMeta(ctx, repo)).repositoryDescription ?? "" };
      },
      async run(ctx, repo, v) {
        await ctx.clients.codecommit.send(new UpdateRepositoryDescriptionCommand({ repositoryName: repo, repositoryDescription: text(v.description) }));
        return { message: "Description saved." };
      },
    },
    {
      id: "create-trigger",
      label: "Create trigger",
      fields: [
        { name: "name", label: "Trigger name", kind: "text", required: true, validate: { max: 100, message: "At most 100 characters." } },
        { name: "events", label: "Events", kind: "multiselect", required: true, options: TRIGGER_EVENTS },
        { name: "branches", label: "Branch names", kind: "textarea", help: "One branch per line. Leave empty for all branches." },
        { name: "destinationArn", label: "Service details", kind: "select", required: true, options: triggerTargets, help: "The Amazon SNS topic or AWS Lambda function to notify." },
        { name: "customData", label: "Custom data", kind: "text" },
      ],
      async run(ctx, repo, v) {
        const existing = await readTriggers(ctx, repo);
        const name = String(v.name);
        if (existing.some((t) => t.name === name)) throw new Error(`A trigger named ${name} already exists.`);
        const events = (Array.isArray(v.events) ? v.events : []) as RepositoryTriggerEventEnum[];
        const trigger: RepositoryTrigger = { name, destinationArn: String(v.destinationArn), events, branches: lines(v.branches), customData: optional(v.customData) };
        await ctx.clients.codecommit.send(new PutRepositoryTriggersCommand({ repositoryName: repo, triggers: [...existing, trigger] }));
        return { message: `Created trigger ${name}.` };
      },
    },
    {
      id: "delete-trigger",
      label: "Delete trigger",
      danger: true,
      fields: [{ name: "name", label: "Trigger name", kind: "text", required: true }],
      async run(ctx, repo, v) {
        const existing = await readTriggers(ctx, repo);
        const name = String(v.name);
        if (!existing.some((t) => t.name === name)) throw new Error(`This repository has no trigger named ${name}.`);
        await ctx.clients.codecommit.send(new PutRepositoryTriggersCommand({ repositoryName: repo, triggers: existing.filter((t) => t.name !== name) }));
        return { message: `Deleted trigger ${name}.` };
      },
    },
    {
      id: "associate-template",
      label: "Associate approval rule template",
      fields: [{ name: "template", label: "Approval rule template", kind: "select", required: true, options: templateOptions }],
      async run(ctx, repo, v) {
        await ctx.clients.codecommit.send(new AssociateApprovalRuleTemplateWithRepositoryCommand({ repositoryName: repo, approvalRuleTemplateName: String(v.template) }));
        return { message: `Associated ${String(v.template)}. New pull requests in this repository get its approval rule.` };
      },
    },
    {
      id: "disassociate-template",
      label: "Disassociate approval rule template",
      fields: [{ name: "template", label: "Approval rule template", kind: "select", required: true, options: templateOptions }],
      async run(ctx, repo, v) {
        await ctx.clients.codecommit.send(new DisassociateApprovalRuleTemplateFromRepositoryCommand({ repositoryName: repo, approvalRuleTemplateName: String(v.template) }));
        return { message: `Disassociated ${String(v.template)}.` };
      },
    },
    {
      id: "tags",
      label: "Manage tags",
      fields: [{ name: "tags", label: "Tags", kind: "tags" }],
      async initialValues(ctx, repo) {
        const arn = await repositoryArn(ctx, repo);
        return { tags: recordToTags((await ctx.clients.codecommit.send(new ListTagsForResourceCommand({ resourceArn: arn }))).tags) };
      },
      async run(ctx, repo, v) {
        const cc = ctx.clients.codecommit;
        const arn = await repositoryArn(ctx, repo);
        const current = (await cc.send(new ListTagsForResourceCommand({ resourceArn: arn }))).tags;
        const d = recordTagDiff(current, tagsToRecord(fieldTags(v.tags)));
        if (d.remove.length) await cc.send(new UntagResourceCommand({ resourceArn: arn, tagKeys: d.remove }));
        if (Object.keys(d.set).length) await cc.send(new TagResourceCommand({ resourceArn: arn, tags: d.set }));
        return { message: tagDiffMessage(d) };
      },
    },
    {
      id: "put-file",
      label: "Commit file",
      hidden: true,
      fields: [
        { name: "branch", label: "Branch name", kind: "text", required: true, validate: { pattern: BRANCH_NAME, message: "Not a valid Git branch name." } },
        { name: "filePath", label: "File name", kind: "text", required: true, validate: { max: 4096, message: "At most 4096 characters." } },
        { name: "content", label: "File content", kind: "textarea" },
        { name: "parentCommitId", label: "Parent commit", kind: "text", help: "Empty only for the first commit in an empty repository." },
        ...authorFields,
      ],
      async run(ctx, repo, v) {
        const path = text(v.filePath).replace(/^\/+/, "");
        if (path === "" || path.endsWith("/") || path.split("/").some((p) => p === "." || p === "..")) throw new Error("Enter a file name such as docs/readme.md.");
        const r = await ctx.clients.codecommit.send(
          new PutFileCommand({
            repositoryName: repo,
            branchName: String(v.branch),
            filePath: path,
            fileContent: Buffer.from(text(v.content), "utf8"),
            parentCommitId: optional(v.parentCommitId),
            ...commitFields(v),
          })
        );
        return { message: `Committed ${path} to ${String(v.branch)}. Commit ID: ${r.commitId ?? "(none returned)"}` };
      },
    },
    {
      id: "delete-file",
      label: "Delete file",
      hidden: true,
      danger: true,
      fields: [
        { name: "branch", label: "Branch name", kind: "text", required: true },
        { name: "filePath", label: "File name", kind: "text", required: true },
        { name: "parentCommitId", label: "Parent commit", kind: "text", required: true },
        ...authorFields,
      ],
      async run(ctx, repo, v) {
        const r = await ctx.clients.codecommit.send(
          new DeleteFileCommand({ repositoryName: repo, branchName: String(v.branch), filePath: String(v.filePath), parentCommitId: String(v.parentCommitId), ...commitFields(v) })
        );
        return { message: `Deleted ${r.filePath ?? String(v.filePath)}. Commit ID: ${r.commitId ?? "(none returned)"}` };
      },
    },
  ],

  delete: {
    confirmText: "delete",
    async run(ctx, repo) {
      const r = await ctx.clients.codecommit.send(new DeleteRepositoryCommand({ repositoryName: repo }));
      if (!r.repositoryId) throw new Error(`CodeCommit found no repository named ${repo}.`);
    },
  },
  detailHref: "repositories/{id}",
};

export const codecommitService: ServiceDef = {
  id: "codecommit",
  name: "AWS CodeCommit",
  category: "Developer Tools",
  description: "Securely host highly scalable private Git repositories and collaborate on code.",
  resources: [repositories, pullRequests, approvalRuleTemplates],
  notSupported: [
    "Viewing several commits at once (BatchGetCommits)",
    "Approving your own pull requests: the emulator's single identity is always the author",
  ],
};
