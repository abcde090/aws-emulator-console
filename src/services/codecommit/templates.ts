/** CodeCommit approval rule templates (the "Approval rule templates" page). */

import {
  AssociateApprovalRuleTemplateWithRepositoryCommand,
  CreateApprovalRuleTemplateCommand,
  DeleteApprovalRuleTemplateCommand,
  GetApprovalRuleTemplateCommand,
  ListApprovalRuleTemplatesCommand,
  ListRepositoriesForApprovalRuleTemplateCommand,
  UpdateApprovalRuleTemplateDescriptionCommand,
  type ApprovalRuleTemplate,
  type CodeCommitClient,
} from "@aws-sdk/client-codecommit";
import type { Ctx, Option, ResourceDef } from "../../console/types.ts";
import { approvalRuleContent, lines } from "./helpers.ts";
import { listRepositoryNames } from "./repo-read.ts";

async function templateNames(cc: CodeCommitClient): Promise<string[]> {
  const names: string[] = [];
  let token: string | undefined;
  do {
    const page = await cc.send(new ListApprovalRuleTemplatesCommand({ nextToken: token }));
    names.push(...(page.approvalRuleTemplateNames ?? []));
    token = page.nextToken;
  } while (token);
  return names;
}

async function getTemplate(cc: CodeCommitClient, name: string): Promise<ApprovalRuleTemplate> {
  const r = await cc.send(new GetApprovalRuleTemplateCommand({ approvalRuleTemplateName: name }));
  if (!r.approvalRuleTemplate) throw new Error(`CodeCommit returned no template ${name}.`);
  return r.approvalRuleTemplate;
}

export async function templateOptions(ctx: Ctx): Promise<Option[]> {
  return (await templateNames(ctx.clients.codecommit)).map((n) => ({ value: n, label: n }));
}

async function repoOptions(ctx: Ctx): Promise<Option[]> {
  return (await listRepositoryNames(ctx.clients.codecommit)).map((n) => ({ value: n, label: n }));
}

function parseContent(text: string | undefined): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export const approvalRuleTemplates: ResourceDef = {
  id: "approval-rule-templates",
  name: "Approval rule templates",
  singular: "approval rule template",
  idField: "name",
  nameField: "name",
  description: "Templates that add approval rules to pull requests in the repositories they are associated with.",
  emptyText: "No approval rule templates.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "description", label: "Description", kind: "text" },
    { key: "lastModified", label: "Last modified", kind: "date" },
    { key: "lastModifiedUser", label: "Last modified by", kind: "arn", hidden: true },
  ],

  async list(ctx) {
    const cc = ctx.clients.codecommit;
    const ts = await Promise.all((await templateNames(cc)).map((n) => getTemplate(cc, n)));
    return ts.map((t) => ({
      name: t.approvalRuleTemplateName ?? "",
      description: t.approvalRuleTemplateDescription ?? null,
      lastModified: t.lastModifiedDate ?? null,
      lastModifiedUser: t.lastModifiedUser ?? null,
    }));
  },

  async get(ctx, name) {
    const cc = ctx.clients.codecommit;
    const t = await getTemplate(cc, name);
    const repos = await cc.send(new ListRepositoriesForApprovalRuleTemplateCommand({ approvalRuleTemplateName: name }));
    return {
      summary: {
        name: t.approvalRuleTemplateName ?? name,
        description: t.approvalRuleTemplateDescription ?? "-",
        id: t.approvalRuleTemplateId ?? null,
        created: t.creationDate ?? null,
        lastModified: t.lastModifiedDate ?? null,
        lastModifiedUser: t.lastModifiedUser ?? null,
      },
      summaryLabels: { name: "Approval rule template name", description: "Description", id: "Template ID", created: "Created", lastModified: "Last modified", lastModifiedUser: "Last modified by" },
      tabs: [
        { id: "content", label: "Approval rule content", kind: "json", data: parseContent(t.approvalRuleTemplateContent) },
        {
          id: "repositories",
          label: "Associated repositories",
          kind: "table",
          columns: [{ key: "name", label: "Repository", kind: "text" }],
          data: (repos.repositoryNames ?? []).map((n) => ({ name: n })),
          emptyText: "This template is not associated with any repository.",
        },
      ],
    };
  },

  create: {
    title: "Create approval rule template",
    description: "Creates a template with CreateApprovalRuleTemplate and associates it with the repositories you choose.",
    fields: [
      { name: "name", label: "Approval rule template name", kind: "text", required: true, section: "Approval rule template", validate: { pattern: "[A-Za-z0-9 ._-]{1,100}", message: "Up to 100 letters, numbers, spaces, periods, underscores or dashes." } },
      { name: "description", label: "Description", kind: "textarea", section: "Approval rule template", validate: { max: 1000, message: "At most 1,000 characters." } },
      { name: "approvals", label: "Number of approvals needed", kind: "number", required: true, default: 1, section: "Approval rule template", validate: { min: 1, max: 100, message: "Between 1 and 100." } },
      { name: "pool", label: "Approval pool members", kind: "textarea", section: "Approval rule template", help: "One IAM user or role ARN per line (wildcards allowed). Leave empty to let anyone approve." },
      { name: "branches", label: "Branch filters", kind: "textarea", section: "Approval rule template", help: "One destination branch per line, e.g. main. Leave empty to apply to every branch." },
      { name: "repositories", label: "Associated repositories", kind: "multiselect", options: repoOptions, section: "Associated repositories" },
    ],
    async run(ctx, v) {
      const cc = ctx.clients.codecommit;
      const name = String(v.name);
      const content = approvalRuleContent(typeof v.approvals === "number" ? v.approvals : 1, lines(v.pool), lines(v.branches));
      await cc.send(
        new CreateApprovalRuleTemplateCommand({
          approvalRuleTemplateName: name,
          approvalRuleTemplateContent: content,
          approvalRuleTemplateDescription: typeof v.description === "string" && v.description !== "" ? v.description : undefined,
        })
      );
      for (const repo of Array.isArray(v.repositories) ? (v.repositories as string[]) : []) {
        await cc.send(new AssociateApprovalRuleTemplateWithRepositoryCommand({ approvalRuleTemplateName: name, repositoryName: repo }));
      }
      return name;
    },
  },

  actions: [
    {
      id: "edit-description",
      label: "Edit description",
      fields: [{ name: "description", label: "Description", kind: "textarea", validate: { max: 1000, message: "At most 1,000 characters." } }],
      async initialValues(ctx, name) {
        return { description: (await getTemplate(ctx.clients.codecommit, name)).approvalRuleTemplateDescription ?? "" };
      },
      async run(ctx, name, v) {
        await ctx.clients.codecommit.send(new UpdateApprovalRuleTemplateDescriptionCommand({ approvalRuleTemplateName: name, approvalRuleTemplateDescription: typeof v.description === "string" ? v.description : "" }));
        return { message: "Description saved." };
      },
    },
    {
      id: "associate",
      label: "Associate with repository",
      fields: [{ name: "repository", label: "Repository", kind: "select", required: true, options: repoOptions }],
      async run(ctx, name, v) {
        await ctx.clients.codecommit.send(new AssociateApprovalRuleTemplateWithRepositoryCommand({ approvalRuleTemplateName: name, repositoryName: String(v.repository) }));
        return { message: `Associated with ${String(v.repository)}.` };
      },
    },
  ],

  delete: {
    confirmText: "delete",
    async run(ctx, name) {
      await ctx.clients.codecommit.send(new DeleteApprovalRuleTemplateCommand({ approvalRuleTemplateName: name }));
    },
  },
};
