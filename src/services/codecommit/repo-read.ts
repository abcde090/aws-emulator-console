/**
 * CodeCommit reads shared by the definition and the hand-built code browser. Every
 * function takes the permission-checked client it is given (ctx.clients.codecommit).
 */

import {
  BatchGetRepositoriesCommand,
  GetBranchCommand,
  GetCommitCommand,
  ListBranchesCommand,
  ListRepositoriesCommand,
  type CodeCommitClient,
  type Commit,
  type RepositoryMetadata,
} from "@aws-sdk/client-codecommit";
import { isCommitId } from "./helpers.ts";

export async function listRepositoryNames(client: CodeCommitClient): Promise<string[]> {
  const names: string[] = [];
  let token: string | undefined;
  do {
    const page = await client.send(new ListRepositoriesCommand({ nextToken: token, sortBy: "repositoryName", order: "ascending" }));
    for (const r of page.repositories ?? []) if (r.repositoryName) names.push(r.repositoryName);
    token = page.nextToken;
  } while (token);
  return names;
}

export async function getRepositories(client: CodeCommitClient, names: string[]): Promise<RepositoryMetadata[]> {
  const out: RepositoryMetadata[] = [];
  for (let i = 0; i < names.length; i += 25) {
    const r = await client.send(new BatchGetRepositoriesCommand({ repositoryNames: names.slice(i, i + 25) }));
    out.push(...(r.repositories ?? []));
  }
  return out;
}

export async function listBranches(client: CodeCommitClient, repo: string): Promise<string[]> {
  const names: string[] = [];
  let token: string | undefined;
  do {
    const page = await client.send(new ListBranchesCommand({ repositoryName: repo, nextToken: token }));
    names.push(...(page.branches ?? []));
    token = page.nextToken;
  } while (token);
  return names.sort((a, b) => a.localeCompare(b));
}

/** A branch name or a full commit ID -> the commit ID it points at. */
export async function resolveCommit(client: CodeCommitClient, repo: string, ref: string): Promise<string> {
  if (isCommitId(ref)) return ref;
  const r = await client.send(new GetBranchCommand({ repositoryName: repo, branchName: ref }));
  const id = r.branch?.commitId;
  if (!id) throw new Error(`Branch ${ref} has no commit.`);
  return id;
}

/** Commits reachable from `start`, newest first (first parents, then merge parents), at most `max`. */
export async function commitHistory(client: CodeCommitClient, repo: string, start: string, max = 25): Promise<Commit[]> {
  const seen = new Set<string>();
  const queue = [start];
  const commits: Commit[] = [];
  while (queue.length > 0 && commits.length < max) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const r = await client.send(new GetCommitCommand({ repositoryName: repo, commitId: id }));
    if (!r.commit) continue;
    commits.push(r.commit);
    for (const p of r.commit.parents ?? []) if (!seen.has(p)) queue.push(p);
  }
  return commits;
}
