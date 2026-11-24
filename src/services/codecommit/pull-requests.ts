/** CodeCommit pull requests, across every repository in the emulator. */

import {
  CreatePullRequestApprovalRuleCommand,
  CreatePullRequestCommand,
  DescribePullRequestEventsCommand,
  EvaluatePullRequestApprovalRulesCommand,
  GetCommentsForPullRequestCommand,
  GetDifferencesCommand,
  GetPullRequestCommand,
  ListPullRequestsCommand,
  MergePullRequestByFastForwardCommand,
  MergePullRequestBySquashCommand,
  MergePullRequestByThreeWayCommand,
  PostCommentForPullRequestCommand,
  UpdatePullRequestDescriptionCommand,
  UpdatePullRequestStatusCommand,
  UpdatePullRequestTitleCommand,
  type CodeCommitClient,
  type PullRequest,
  type PullRequestTarget,
} from "@aws-sdk/client-codecommit";
import type { Ctx, Option, ResourceDef, Row } from "../../console/types.ts";
import { approvalRuleContent, branchFromRef, changeTypeLabel, lines, repoBranchValue, splitRepoBranch } from "./helpers.ts";
import { listBranches, listRepositoryNames } from "./repo-read.ts";

const optional = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

async function prIdsForRepo(cc: CodeCommitClient, repo: string): Promise<string[]> {
  const ids: string[] = [];
  let token: string | undefined;
  do {
    const page = await cc.send(new ListPullRequestsCommand({ repositoryName: repo, nextToken: token }));
    ids.push(...(page.pullRequestIds ?? []));
    token = page.nextToken;
  } while (token);
  return ids;
}

async function getPr(cc: CodeCommitClient, id: string): Promise<PullRequest> {
  const r = await cc.send(new GetPullRequestCommand({ pullRequestId: id }));
  if (!r.pullRequest) throw new Error(`CodeCommit returned no pull request ${id}.`);
  return r.pullRequest;
}

function target(pr: PullRequest): PullRequestTarget {
  return pr.pullRequestTargets?.[0] ?? {};
}

function prStatus(pr: PullRequest): string {
  const t = target(pr);
  if (t.mergeMetadata?.isMerged) return "Merged";
  return pr.pullRequestStatus === "OPEN" ? "Open" : pr.pullRequestStatus === "CLOSED" ? "Closed" : pr.pullRequestStatus ?? "-";
}

function prRow(pr: PullRequest): Row {
  const t = target(pr);
  return {
    pullRequestId: pr.pullRequestId ?? "",
    title: pr.title ?? null,
    repository: t.repositoryName ?? null,
    source: branchFromRef(t.sourceReference),
    destination: branchFromRef(t.destinationReference),
    author: pr.authorArn ?? null,
    status: prStatus(pr),
    created: pr.creationDate ?? null,
    lastActivity: pr.lastActivityDate ?? null,
  };
}

async function branchOptions(ctx: Ctx): Promise<Option[]> {
  const cc = ctx.clients.codecommit;
  const repos = await listRepositoryNames(cc);
  const perRepo = await Promise.all(repos.map(async (repo) => (await listBranches(cc, repo)).map((b) => ({ value: repoBranchValue(repo, b), label: `${repo} › ${b}` }))));
  return perRepo.flat();
}

async function openPr(ctx: Ctx, id: string): Promise<{ pr: PullRequest; t: PullRequestTarget; repo: string }> {
  const pr = await getPr(ctx.clients.codecommit, id);
  const t = target(pr);
  if (!t.repositoryName) throw new Error("The pull request has no repository target.");
  return { pr, t, repo: t.repositoryName };
}

export const pullRequests: ResourceDef = {
  id: "pull-requests",
  name: "Pull requests",
  singular: "pull request",
  idField: "pullRequestId",
  nameField: "title",
  description: "Propose, review and merge changes between branches.",
  emptyText: "No pull requests. Create a pull request to review changes between two branches.",
  columns: [
    { key: "pullRequestId", label: "Pull request", kind: "link" },
    { key: "title", label: "Title", kind: "text" },
    { key: "repository", label: "Repository", kind: "text" },
    { key: "source", label: "Source", kind: "text" },
    { key: "destination", label: "Destination", kind: "text" },
    { key: "author", label: "Author", kind: "arn" },
    { key: "status", label: "Status", kind: "status" },
    { key: "lastActivity", label: "Last activity", kind: "date" },
    { key: "created", label: "Created", kind: "date", hidden: true },
  ],

  async list(ctx) {
    const cc = ctx.clients.codecommit;
    const repos = await listRepositoryNames(cc);
    const ids = [...new Set((await Promise.all(repos.map((r) => prIdsForRepo(cc, r)))).flat())];
    const prs = await Promise.all(ids.map((id) => getPr(cc, id)));
    return prs.map(prRow).sort((a, b) => Number(b.pullRequestId) - Number(a.pullRequestId));
  },

  async get(ctx, id) {
    const cc = ctx.clients.codecommit;
    const pr = await getPr(cc, id);
    const t = target(pr);
    const repo = t.repositoryName ?? "";
    const [diff, events, comments, evaluation] = await Promise.all([
      t.mergeBase && t.sourceCommit ? cc.send(new GetDifferencesCommand({ repositoryName: repo, beforeCommitSpecifier: t.mergeBase, afterCommitSpecifier: t.sourceCommit })) : Promise.resolve({ differences: [] }),
      cc.send(new DescribePullRequestEventsCommand({ pullRequestId: id })),
      cc.send(new GetCommentsForPullRequestCommand({ pullRequestId: id })),
      pr.revisionId ? cc.send(new EvaluatePullRequestApprovalRulesCommand({ pullRequestId: id, revisionId: pr.revisionId })) : Promise.resolve({ evaluation: undefined }),
    ]);
    const row = prRow(pr);
    const satisfied = new Set(evaluation.evaluation?.approvalRulesSatisfied ?? []);
    return {
      summary: {
        title: pr.title ?? null,
        pullRequestId: pr.pullRequestId ?? id,
        status: row.status,
        repository: repo,
        destination: row.destination,
        source: row.source,
        author: pr.authorArn ?? null,
        created: pr.creationDate ?? null,
      },
      summaryLabels: { title: "Title", pullRequestId: "Pull request ID", status: "Status", repository: "Repository", destination: "Destination", source: "Source", author: "Author", created: "Created" },
      tabs: [
        {
          id: "details",
          label: "Details",
          kind: "keyvalue",
          data: {
            Description: pr.description ?? "-",
            "Source commit": t.sourceCommit ?? null,
            "Destination commit": t.destinationCommit ?? null,
            "Merge base": t.mergeBase ?? null,
            Merged: t.mergeMetadata?.isMerged ? "Yes" : "No",
            "Merge option": t.mergeMetadata?.mergeOption ?? null,
            "Merge commit": t.mergeMetadata?.mergeCommitId ?? null,
            "Merged by": t.mergeMetadata?.mergedBy ?? null,
            "Revision ID": pr.revisionId ?? null,
            "Approval rules": evaluation.evaluation ? (evaluation.evaluation.approved ? "Approved" : "Not approved") : null,
            "Last activity": pr.lastActivityDate ?? null,
          },
        },
        {
          id: "changes",
          label: "Changes",
          kind: "table",
          columns: [
            { key: "change", label: "Change", kind: "text" },
            { key: "path", label: "File", kind: "code" },
            { key: "before", label: "Before blob", kind: "code" },
            { key: "after", label: "After blob", kind: "code" },
          ],
          data: (diff.differences ?? []).map((d) => ({
            change: changeTypeLabel(d.changeType),
            path: d.afterBlob?.path ?? d.beforeBlob?.path ?? null,
            before: d.beforeBlob?.blobId ?? null,
            after: d.afterBlob?.blobId ?? null,
          })),
          description: "Files that differ between the merge base and the source branch (GetDifferences).",
          emptyText: "No changes between the source and destination.",
        },
        {
          id: "approvals",
          label: "Approvals",
          kind: "table",
          columns: [
            { key: "name", label: "Approval rule", kind: "text" },
            { key: "state", label: "Status", kind: "status" },
            { key: "origin", label: "Origin", kind: "text" },
            { key: "content", label: "Rule content", kind: "code" },
          ],
          data: (pr.approvalRules ?? []).map((r) => ({
            name: r.approvalRuleName ?? "",
            state: satisfied.has(r.approvalRuleName ?? "") ? "Satisfied" : "Not satisfied",
            origin: r.originApprovalRuleTemplate?.approvalRuleTemplateName ? `Template ${r.originApprovalRuleTemplate.approvalRuleTemplateName}` : "Pull request",
            content: r.approvalRuleContent ?? null,
          })),
          emptyText: "No approval rules apply to this pull request.",
        },
        {
          id: "activity",
          label: "Activity",
          kind: "table",
          columns: [
            { key: "date", label: "Date", kind: "date" },
            { key: "type", label: "Event", kind: "text" },
            { key: "actor", label: "Actor", kind: "arn" },
          ],
          data: (events.pullRequestEvents ?? []).map((e) => ({ date: e.eventDate ?? null, type: e.pullRequestEventType ?? null, actor: e.actorArn ?? null })),
          emptyText: "No activity.",
        },
        {
          id: "comments",
          label: "Comments",
          kind: "table",
          columns: [
            { key: "date", label: "Date", kind: "date" },
            { key: "author", label: "Author", kind: "arn" },
            { key: "file", label: "File", kind: "code" },
            { key: "content", label: "Comment", kind: "text" },
          ],
          data: (comments.commentsForPullRequestData ?? []).flatMap((c) =>
            (c.comments ?? []).map((m) => ({ date: m.creationDate ?? null, author: m.authorArn ?? null, file: c.location?.filePath ?? null, content: m.deleted ? "(deleted)" : m.content ?? "" }))
          ),
          emptyText: "No comments yet.",
        },
      ],
    };
  },

  create: {
    title: "Create pull request",
    description: "Creates a pull request with CreatePullRequest. Both branches must be in the same repository.",
    fields: [
      { name: "destination", label: "Destination", kind: "select", required: true, options: branchOptions, section: "Branches", help: "The branch you want to merge into." },
      { name: "source", label: "Source", kind: "select", required: true, options: branchOptions, section: "Branches", help: "The branch with the changes." },
      { name: "title", label: "Title", kind: "text", required: true, section: "Details", validate: { max: 150, message: "At most 150 characters." } },
      { name: "description", label: "Description", kind: "textarea", section: "Details", validate: { max: 10240, message: "At most 10,240 characters." } },
    ],
    async run(ctx, v) {
      const src = splitRepoBranch(v.source);
      const dst = splitRepoBranch(v.destination);
      if (!src || !dst) throw new Error("Choose a source and a destination branch.");
      if (src.repo !== dst.repo) throw new Error("The source and destination branches must be in the same repository.");
      if (src.branch === dst.branch) throw new Error("The source and destination must be different branches.");
      const r = await ctx.clients.codecommit.send(
        new CreatePullRequestCommand({
          title: String(v.title),
          description: optional(v.description),
          targets: [{ repositoryName: src.repo, sourceReference: src.branch, destinationReference: dst.branch }],
        })
      );
      const id = r.pullRequest?.pullRequestId;
      if (!id) throw new Error("CodeCommit returned no pull request ID.");
      return id;
    },
  },

  actions: [
    {
      id: "merge",
      label: "Merge",
      availableFor: (row) => row.status === undefined || row.status === "Open",
      fields: [
        {
          name: "strategy", label: "Merge strategy", kind: "radio", required: true, default: "FAST_FORWARD_MERGE",
          options: [
            { value: "FAST_FORWARD_MERGE", label: "Fast forward merge" },
            { value: "SQUASH_MERGE", label: "Squash and merge" },
            { value: "THREE_WAY_MERGE", label: "3-way merge" },
          ],
        },
        { name: "authorName", label: "Author name", kind: "text", help: "Squash and 3-way merges create a commit." },
        { name: "email", label: "Email address", kind: "text" },
        { name: "message", label: "Commit message", kind: "textarea" },
      ],
      async run(ctx, id, v) {
        const { t, repo } = await openPr(ctx, id);
        const cc = ctx.clients.codecommit;
        const common = { pullRequestId: id, repositoryName: repo, sourceCommitId: t.sourceCommit };
        const commit = { authorName: optional(v.authorName), email: optional(v.email), commitMessage: optional(v.message) };
        const r =
          v.strategy === "SQUASH_MERGE"
            ? await cc.send(new MergePullRequestBySquashCommand({ ...common, ...commit }))
            : v.strategy === "THREE_WAY_MERGE"
              ? await cc.send(new MergePullRequestByThreeWayCommand({ ...common, ...commit }))
              : await cc.send(new MergePullRequestByFastForwardCommand(common));
        const merged = r.pullRequest?.pullRequestTargets?.[0]?.mergeMetadata;
        return { message: merged?.isMerged ? `Merged with ${merged.mergeOption ?? "the chosen strategy"}. Merge commit: ${merged.mergeCommitId ?? "-"}` : "CodeCommit did not report the pull request as merged." };
      },
    },
    {
      id: "close",
      label: "Close pull request",
      danger: true,
      availableFor: (row) => row.status === undefined || row.status === "Open",
      confirm: "Closing the pull request stops the review without merging. You can't reopen it.",
      async run(ctx, id) {
        await ctx.clients.codecommit.send(new UpdatePullRequestStatusCommand({ pullRequestId: id, pullRequestStatus: "CLOSED" }));
        return { message: `Closed pull request ${id}.` };
      },
    },
    {
      id: "comment",
      label: "Add comment",
      fields: [{ name: "content", label: "Comment", kind: "textarea", required: true, validate: { max: 10240, message: "At most 10,240 characters." } }],
      async run(ctx, id, v) {
        const { t, repo } = await openPr(ctx, id);
        if (!t.destinationCommit || !t.sourceCommit) throw new Error("The pull request has no commits to comment on.");
        await ctx.clients.codecommit.send(
          new PostCommentForPullRequestCommand({ pullRequestId: id, repositoryName: repo, beforeCommitId: t.destinationCommit, afterCommitId: t.sourceCommit, content: String(v.content) })
        );
        return { message: "Comment posted." };
      },
    },
    {
      id: "edit",
      label: "Edit title and description",
      fields: [
        { name: "title", label: "Title", kind: "text", required: true, validate: { max: 150, message: "At most 150 characters." } },
        { name: "description", label: "Description", kind: "textarea", validate: { max: 10240, message: "At most 10,240 characters." } },
      ],
      async initialValues(ctx, id) {
        const pr = await getPr(ctx.clients.codecommit, id);
        return { title: pr.title ?? "", description: pr.description ?? "" };
      },
      async run(ctx, id, v) {
        const cc = ctx.clients.codecommit;
        const pr = await getPr(cc, id);
        const title = String(v.title);
        const description = typeof v.description === "string" ? v.description : "";
        if (title !== (pr.title ?? "")) await cc.send(new UpdatePullRequestTitleCommand({ pullRequestId: id, title }));
        if (description !== (pr.description ?? "")) await cc.send(new UpdatePullRequestDescriptionCommand({ pullRequestId: id, description }));
        return { message: "Pull request updated." };
      },
    },
    {
      id: "approval-rule",
      label: "Create approval rule",
      fields: [
        { name: "name", label: "Approval rule name", kind: "text", required: true, validate: { max: 100, message: "At most 100 characters." } },
        { name: "approvals", label: "Number of approvals needed", kind: "number", required: true, default: 1, validate: { min: 1, max: 100, message: "Between 1 and 100." } },
        { name: "pool", label: "Approval pool members", kind: "textarea", help: "One IAM user or role ARN per line (wildcards allowed). Leave empty to let anyone approve." },
      ],
      async run(ctx, id, v) {
        const content = approvalRuleContent(typeof v.approvals === "number" ? v.approvals : 1, lines(v.pool), []);
        await ctx.clients.codecommit.send(new CreatePullRequestApprovalRuleCommand({ pullRequestId: id, approvalRuleName: String(v.name), approvalRuleContent: content }));
        return { message: `Created approval rule ${String(v.name)}.` };
      },
    },
  ],
};
