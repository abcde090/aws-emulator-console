/**
 * Reads for the hand-built repository screen (code, file and commit views). Server only;
 * every call uses the permission-checked CodeCommit client, so the IAM simulator sees it.
 */

import { GetDifferencesCommand, GetFileCommand, GetFolderCommand, GetCommitCommand, GetRepositoryCommand } from "@aws-sdk/client-codecommit";
import { clients } from "../../lib/aws.ts";
import { errorMessage } from "../../console/serialize.ts";
import type { Result } from "../../console/types.ts";
import { changeTypeLabel, decodeFileText, gitDateToIso } from "./helpers.ts";
import { commitHistory, listBranches, resolveCommit } from "./repo-read.ts";

export interface RepoHead {
  defaultBranch: string | null;
  branches: string[];
}

export interface FolderEntry {
  name: string;
  path: string;
  kind: "folder" | "file" | "symlink" | "submodule";
}

export interface FolderView {
  commitId: string;
  entries: FolderEntry[];
}

export interface FileView {
  commitId: string;
  blobId: string | null;
  size: number | null;
  mode: string | null;
  text: string | null;
}

export interface CommitSummary {
  commitId: string;
  message: string;
  author: string;
  email: string | null;
  date: string | null;
  parents: string[];
}

export interface CommitView extends CommitSummary {
  changes: { change: string; path: string }[];
}

async function attempt<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err: unknown) {
    return { ok: false, error: errorMessage(err) };
  }
}

const cc = () => clients.codecommit;

export function readHead(repo: string): Promise<Result<RepoHead>> {
  return attempt(async () => {
    const meta = (await cc().send(new GetRepositoryCommand({ repositoryName: repo }))).repositoryMetadata;
    return { defaultBranch: meta?.defaultBranch ?? null, branches: await listBranches(cc(), repo) };
  });
}

export function readFolder(repo: string, ref: string, path: string): Promise<Result<FolderView>> {
  return attempt(async () => {
    const r = await cc().send(new GetFolderCommand({ repositoryName: repo, commitSpecifier: ref, folderPath: path === "" ? "/" : path }));
    const entries: FolderEntry[] = [
      ...(r.subFolders ?? []).map((f) => ({ name: f.relativePath ?? "", path: f.absolutePath ?? "", kind: "folder" as const })),
      ...(r.files ?? []).map((f) => ({ name: f.relativePath ?? "", path: f.absolutePath ?? "", kind: "file" as const })),
      ...(r.symbolicLinks ?? []).map((f) => ({ name: f.relativePath ?? "", path: f.absolutePath ?? "", kind: "symlink" as const })),
      ...(r.subModules ?? []).map((f) => ({ name: f.relativePath ?? "", path: f.absolutePath ?? "", kind: "submodule" as const })),
    ];
    return { commitId: r.commitId ?? "", entries: entries.filter((e) => e.name !== "") };
  });
}

export function readFile(repo: string, ref: string, path: string): Promise<Result<FileView>> {
  return attempt(async () => {
    const r = await cc().send(new GetFileCommand({ repositoryName: repo, commitSpecifier: ref, filePath: path }));
    return { commitId: r.commitId ?? "", blobId: r.blobId ?? null, size: r.fileSize ?? null, mode: r.fileMode ?? null, text: decodeFileText(r.fileContent) };
  });
}

export function readHistory(repo: string, ref: string): Promise<Result<CommitSummary[]>> {
  return attempt(async () => {
    const start = await resolveCommit(cc(), repo, ref);
    return (await commitHistory(cc(), repo, start, 25)).map((c) => ({
      commitId: c.commitId ?? "",
      message: c.message ?? "",
      author: c.author?.name ?? "-",
      email: c.author?.email ?? null,
      date: gitDateToIso(c.author?.date),
      parents: c.parents ?? [],
    }));
  });
}

export function readCommit(repo: string, commitId: string): Promise<Result<CommitView>> {
  return attempt(async () => {
    const c = (await cc().send(new GetCommitCommand({ repositoryName: repo, commitId }))).commit;
    if (!c) throw new Error(`CodeCommit returned no commit ${commitId}.`);
    const parent = c.parents?.[0];
    const diff = await cc().send(new GetDifferencesCommand({ repositoryName: repo, beforeCommitSpecifier: parent, afterCommitSpecifier: commitId }));
    return {
      commitId: c.commitId ?? commitId,
      message: c.message ?? "",
      author: c.author?.name ?? "-",
      email: c.author?.email ?? null,
      date: gitDateToIso(c.author?.date),
      parents: c.parents ?? [],
      changes: (diff.differences ?? []).map((d) => ({ change: changeTypeLabel(d.changeType), path: d.afterBlob?.path ?? d.beforeBlob?.path ?? "" })),
    };
  });
}
