/** Small, pure helpers for CodeCommit values (git dates, refs, paths, file content). */

/** Repository names: letters, numbers, periods, underscores and dashes, up to 100 characters. */
export const REPO_NAME = "(?!.*\\.git$)[A-Za-z0-9._-]{1,100}";

/** Branch names as git accepts them, without the characters git forbids. */
export const BRANCH_NAME = "(?!/)(?!.*//)(?!.*\\.\\.)(?!.*/$)(?!.*\\.lock$)[^\\s~^:?*\\[\\\\]{1,256}";

/** CodeCommit returns git dates as "<epoch seconds> <zone offset>", e.g. "1795416576 +0000". */
export function gitDateToIso(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = /^(\d+)(?:\s+[+-]\d{4})?$/.exec(v.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]) * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** "refs/heads/feature/x" -> "feature/x"; other values are returned as is. */
export function branchFromRef(ref: unknown): string | null {
  if (typeof ref !== "string" || ref === "") return null;
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

export function isCommitId(v: string): boolean {
  return /^[0-9a-f]{40}$/.test(v);
}

/** A folder path inside the repository: no leading/trailing slashes, no "." or ".." parts. */
export function normaliseRepoPath(v: unknown): string | null {
  if (typeof v !== "string") return "";
  const parts = v.split("/").filter((p) => p !== "");
  if (parts.some((p) => p === "." || p === "..")) return null;
  return parts.join("/");
}

/** Breadcrumbs for a folder path: [{label:"src", path:"src"}, {label:"lib", path:"src/lib"}]. */
export function pathCrumbs(path: string): { label: string; path: string }[] {
  const parts = path.split("/").filter((p) => p !== "");
  return parts.map((label, i) => ({ label, path: parts.slice(0, i + 1).join("/") }));
}

export function parentPath(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** File content as text, or null when it is not valid UTF-8 text (shown as binary). */
export function decodeFileText(bytes: Uint8Array | undefined): string | null {
  if (!bytes) return "";
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Branch choices across repositories are sent as "<repository>:<branch>". Repository
 * names and git branch names can't contain ":", so the first ":" splits them.
 */
export function repoBranchValue(repo: string, branch: string): string {
  return `${repo}:${branch}`;
}

export function splitRepoBranch(v: unknown): { repo: string; branch: string } | null {
  if (typeof v !== "string") return null;
  const i = v.indexOf(":");
  if (i <= 0 || i === v.length - 1) return null;
  return { repo: v.slice(0, i), branch: v.slice(i + 1) };
}

const CHANGE_TYPES: Record<string, string> = { A: "Added", M: "Modified", D: "Deleted" };

export function changeTypeLabel(v: unknown): string {
  return typeof v === "string" ? CHANGE_TYPES[v] ?? v : "-";
}

/** One line per value, blank lines dropped. */
export function lines(v: unknown): string[] {
  return typeof v === "string" ? v.split(/\r?\n/).map((s) => s.trim()).filter((s) => s !== "") : [];
}

/** The approval rule content JSON the console builds from its form. */
export function approvalRuleContent(approvals: number, poolMembers: string[], branches: string[]): string {
  const statement: Record<string, unknown> = { Type: "Approvers", NumberOfApprovalsNeeded: approvals };
  if (poolMembers.length) statement.ApprovalPoolMembers = poolMembers;
  const content: Record<string, unknown> = { Version: "2018-11-08" };
  if (branches.length) content.DestinationReferences = branches.map((b) => (b.startsWith("refs/heads/") ? b : `refs/heads/${b}`));
  content.Statements = [statement];
  return JSON.stringify(content);
}

/** Link to the hand-built repository screen with the given query parameters. */
export function repoHref(repo: string, params: Record<string, string | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const s = q.toString();
  return `/codecommit/repositories/${encodeURIComponent(repo)}${s ? `?${s}` : ""}`;
}
