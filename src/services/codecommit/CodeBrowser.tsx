/**
 * Hand-built CodeCommit code browser (server component): folder listing, file view and
 * commit view for one branch or commit. Mutations are in RepoControls (client).
 */

import Link from "next/link";
import { formatBytes, formatDate } from "@/console/format";
import { Container, EmptyState, ErrorBanner } from "@/console/ui/primitives";
import { readCommit, readFile, readFolder, readHistory, type RepoHead } from "./browse";
import { isCommitId, parentPath, pathCrumbs, repoHref } from "./helpers";
import { BranchPicker, FileEditor } from "./RepoControls";

export interface BrowseQuery {
  ref: string;
  path: string;
  file: string | null;
}

function Crumbs({ repo, refName, path }: { repo: string; refName: string; path: string }) {
  return (
    <nav aria-label="Folder path" className="flex flex-wrap items-center gap-1">
      <Link href={repoHref(repo, { ref: refName })}>{repo}</Link>
      {pathCrumbs(path).map((c) => (
        <span key={c.path} className="flex items-center gap-1">
          <span className="text-muted">/</span>
          <Link href={repoHref(repo, { ref: refName, path: c.path })}>{c.label}</Link>
        </span>
      ))}
    </nav>
  );
}

export async function CodeBrowser({ repo, head, query }: { repo: string; head: RepoHead; query: BrowseQuery }) {
  if (head.branches.length === 0) {
    return (
      <Container title="Code">
        <EmptyState title="This repository is empty">
          <p>Add a file to create the first commit and the default branch.</p>
          <div className="mt-3 flex justify-center">
            <FileEditor repo={repo} branch="main" parentCommitId={null} mode={{ kind: "create", folder: "" }} label="Create file" primary />
          </div>
        </EmptyState>
      </Container>
    );
  }
  const { ref, path, file } = query;
  const onBranch = head.branches.includes(ref);
  const target = file ?? path;
  const view = file ? await readFile(repo, ref, file) : await readFolder(repo, ref, path);
  const commitId = view.ok ? view.data.commitId : null;

  return (
    <Container
      title="Code"
      description={commitId ? `Commit ${commitId}` : undefined}
      actions={
        <>
          <BranchPicker repo={repo} branches={head.branches} current={ref} />
          {onBranch && commitId && !file && <FileEditor repo={repo} branch={ref} parentCommitId={commitId} mode={{ kind: "create", folder: path }} label="Create file" primary />}
          {onBranch && commitId && file && view.ok && "text" in view.data && view.data.text !== null && (
            <FileEditor repo={repo} branch={ref} parentCommitId={commitId} mode={{ kind: "edit", path: file, content: view.data.text }} label="Edit" />
          )}
          {onBranch && commitId && file && <FileEditor repo={repo} branch={ref} parentCommitId={commitId} mode={{ kind: "delete", path: file }} label="Delete" />}
        </>
      }
    >
      <div className="mb-3">
        <Crumbs repo={repo} refName={ref} path={target} />
      </div>
      {!view.ok && <ErrorBanner message={view.error} />}
      {view.ok && "entries" in view.data && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left" data-testid="code-table">
            <thead>
              <tr className="border-b-2 border-line-soft">
                <th className="px-2 py-2">Name</th>
                <th className="px-2 py-2">Type</th>
              </tr>
            </thead>
            <tbody>
              {path !== "" && (
                <tr className="border-b border-line-soft">
                  <td className="px-2 py-2" colSpan={2}>
                    <Link href={repoHref(repo, { ref, path: parentPath(path) })}>..</Link>
                  </td>
                </tr>
              )}
              {view.data.entries.map((e) => (
                <tr key={`${e.kind}:${e.path}`} className="border-b border-line-soft hover:bg-shade">
                  <td className="px-2 py-2 break-all">
                    {e.kind === "folder" ? (
                      <Link href={repoHref(repo, { ref, path: e.path })}>📁 {e.name}</Link>
                    ) : e.kind === "file" ? (
                      <Link href={repoHref(repo, { ref, file: e.path })}>{e.name}</Link>
                    ) : (
                      e.name
                    )}
                  </td>
                  <td className="px-2 py-2">{e.kind === "folder" ? "Folder" : e.kind === "file" ? "File" : e.kind === "symlink" ? "Symbolic link" : "Submodule"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {view.data.entries.length === 0 && <EmptyState title="This folder is empty" />}
        </div>
      )}
      {view.ok && "text" in view.data && (
        <div className="space-y-2">
          <p className="text-muted">
            {formatBytes(view.data.size)} · blob {view.data.blobId ?? "-"} · mode {view.data.mode ?? "-"}
          </p>
          {view.data.text === null ? (
            <EmptyState title="This file can't be shown because it is not UTF-8 text." />
          ) : (
            <pre className="max-h-[60vh] overflow-auto rounded-lg border border-line-soft bg-shade p-3 font-mono text-[13px] whitespace-pre" data-testid="file-content">
              {view.data.text}
            </pre>
          )}
        </div>
      )}
    </Container>
  );
}

export async function CommitList({ repo, refName }: { repo: string; refName: string }) {
  const r = await readHistory(repo, refName);
  return (
    <Container title="Commits" description={`Commits reachable from ${isCommitId(refName) ? refName.slice(0, 8) : refName}, newest first (up to 25).`}>
      {!r.ok && <ErrorBanner message={r.error} />}
      {r.ok && r.data.length === 0 && <EmptyState title="No commits" />}
      {r.ok && r.data.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left" data-testid="commits-table">
            <thead>
              <tr className="border-b-2 border-line-soft">
                <th className="px-2 py-2">Commit ID</th>
                <th className="px-2 py-2">Commit message</th>
                <th className="px-2 py-2">Commit date</th>
                <th className="px-2 py-2">Author</th>
              </tr>
            </thead>
            <tbody>
              {r.data.map((c) => (
                <tr key={c.commitId} className="border-b border-line-soft">
                  <td className="px-2 py-2 font-mono text-[13px]">
                    <Link href={repoHref(repo, { ref: refName, commit: c.commitId })}>{c.commitId.slice(0, 8)}</Link>
                  </td>
                  <td className="px-2 py-2 whitespace-pre-wrap">{c.message.trim() || "-"}</td>
                  <td className="px-2 py-2">{formatDate(c.date)}</td>
                  <td className="px-2 py-2">{c.author}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Container>
  );
}

export async function CommitDetail({ repo, refName, commitId }: { repo: string; refName: string; commitId: string }) {
  const r = await readCommit(repo, commitId);
  return (
    <Container title={`Commit ${commitId.slice(0, 8)}`} actions={<Link href={repoHref(repo, { ref: refName })}>Back to code</Link>}>
      {!r.ok && <ErrorBanner message={r.error} />}
      {r.ok && (
        <div className="space-y-4" data-testid="commit-detail">
          <dl className="grid gap-x-6 gap-y-2 md:grid-cols-2">
            <div>
              <dt className="text-muted">Commit ID</dt>
              <dd className="font-mono text-[13px] break-all">{r.data.commitId}</dd>
            </div>
            <div>
              <dt className="text-muted">Author</dt>
              <dd>
                {r.data.author}
                {r.data.email ? ` <${r.data.email}>` : ""}
              </dd>
            </div>
            <div>
              <dt className="text-muted">Commit date</dt>
              <dd>{formatDate(r.data.date)}</dd>
            </div>
            <div>
              <dt className="text-muted">Parents</dt>
              <dd className="font-mono text-[13px]">
                {r.data.parents.length === 0
                  ? "None (first commit)"
                  : r.data.parents.map((p) => (
                      <Link key={p} className="mr-2" href={repoHref(repo, { ref: refName, commit: p })}>
                        {p.slice(0, 8)}
                      </Link>
                    ))}
              </dd>
            </div>
          </dl>
          <pre className="rounded-lg bg-shade p-3 whitespace-pre-wrap">{r.data.message || "(no message)"}</pre>
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b-2 border-line-soft">
                <th className="px-2 py-2">Change</th>
                <th className="px-2 py-2">File</th>
              </tr>
            </thead>
            <tbody>
              {r.data.changes.map((c) => (
                <tr key={c.path} className="border-b border-line-soft">
                  <td className="px-2 py-2">{c.change}</td>
                  <td className="px-2 py-2 font-mono text-[13px]">
                    {c.change === "Deleted" ? c.path : <Link href={repoHref(repo, { ref: r.data.commitId, file: c.path })}>{c.path}</Link>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {r.data.changes.length === 0 && <EmptyState title="No file changes in this commit." />}
        </div>
      )}
    </Container>
  );
}
