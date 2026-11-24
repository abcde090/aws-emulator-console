/**
 * Hand-built CodeCommit repository screen: Code (browser, file and commit views) and
 * Commits first, then the definition's tabs (Branches, Settings, Triggers, ...).
 * /codecommit/repositories/create is still the generic form.
 */

import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { getResource, getService } from "@/console/registry";
import { decodeSegment, firstParam, GenericCreatePage, GenericDetailPage } from "@/console/ui/pages";
import { readHead } from "@/services/codecommit/browse";
import { CodeBrowser, CommitDetail, CommitList } from "@/services/codecommit/CodeBrowser";
import { isCommitId, normaliseRepoPath } from "@/services/codecommit/helpers";
import { ErrorBanner } from "@/console/ui/primitives";

interface PageProps {
  params: Promise<{ repo: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function RepositoryPage({ params, searchParams }: PageProps) {
  const service = getService("codecommit");
  const resource = getResource("codecommit", "repositories");
  if (!service || !resource) notFound();
  const repo = decodeSegment((await params).repo);
  if (repo === "create") return <GenericCreatePage service={service} resource={resource} />;

  const query = await searchParams;
  const created = firstParam(query.created);
  const notice = firstParam(query.notice);
  const head = await readHead(repo);
  const path = normaliseRepoPath(firstParam(query.path) ?? "");
  const file = normaliseRepoPath(firstParam(query.file) ?? "");
  const commit = firstParam(query.commit);

  let tabs: { id: string; label: string; content: ReactNode }[] = [];
  if (!head.ok) {
    tabs = [{ id: "code", label: "Code", content: <ErrorBanner message={head.error} /> }];
  } else if (path === null || file === null) {
    tabs = [{ id: "code", label: "Code", content: <ErrorBanner message="That path is not valid in a repository." /> }];
  } else {
    const ref = firstParam(query.ref) ?? head.data.defaultBranch ?? head.data.branches[0] ?? "";
    const code =
      commit && isCommitId(commit) ? (
        <CommitDetail repo={repo} refName={ref} commitId={commit} />
      ) : (
        <CodeBrowser repo={repo} head={head.data} query={{ ref, path, file: file === "" ? null : file }} />
      );
    tabs = [{ id: "code", label: "Code", content: code }];
    if (head.data.branches.length > 0) tabs.push({ id: "commits", label: "Commits", content: <CommitList repo={repo} refName={ref} /> });
  }

  return (
    <GenericDetailPage
      key={`${firstParam(query.ref) ?? ""}|${path}|${file}|${commit ?? ""}`}
      service={service}
      resource={resource}
      id={repo}
      flash={created ? `Created repository ${created}.` : notice}
      extraTabs={tabs}
    />
  );
}
