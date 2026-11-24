import { test } from "node:test";
import assert from "node:assert/strict";
import {
  approvalRuleContent,
  branchFromRef,
  BRANCH_NAME,
  changeTypeLabel,
  decodeFileText,
  gitDateToIso,
  isCommitId,
  lines,
  normaliseRepoPath,
  parentPath,
  pathCrumbs,
  repoHref,
  REPO_NAME,
  splitRepoBranch,
  repoBranchValue,
} from "../src/services/codecommit/helpers.ts";

const full = (p) => new RegExp(`^(?:${p})$`);

test("CodeCommit git dates and refs", () => {
  assert.equal(gitDateToIso("0 +0000"), "1970-01-01T00:00:00.000Z");
  assert.equal(gitDateToIso("1795416576"), new Date(1795416576000).toISOString());
  assert.equal(gitDateToIso("yesterday"), null);
  assert.equal(gitDateToIso(undefined), null);
  assert.equal(branchFromRef("refs/heads/feature/x"), "feature/x");
  assert.equal(branchFromRef("main"), "main");
  assert.equal(branchFromRef(""), null);
  assert.equal(isCommitId("9b66a64be2375187d63293b3dbbccf3784fe051f"), true);
  assert.equal(isCommitId("main"), false);
});

test("CodeCommit names", () => {
  assert.ok(full(REPO_NAME).test("my-repo_1.x"));
  assert.ok(!full(REPO_NAME).test("repo.git"));
  assert.ok(!full(REPO_NAME).test("bad/name"));
  assert.ok(full(BRANCH_NAME).test("feature/new-thing"));
  assert.ok(!full(BRANCH_NAME).test("a..b"));
  assert.ok(!full(BRANCH_NAME).test("has space"));
  assert.ok(!full(BRANCH_NAME).test("x:y"));
});

test("CodeCommit paths", () => {
  assert.equal(normaliseRepoPath("/src//lib/"), "src/lib");
  assert.equal(normaliseRepoPath("../etc"), null);
  assert.equal(normaliseRepoPath(5), "");
  assert.deepEqual(pathCrumbs("a/b"), [{ label: "a", path: "a" }, { label: "b", path: "a/b" }]);
  assert.equal(parentPath("a/b/c"), "a/b");
  assert.equal(parentPath("a"), "");
  assert.equal(repoHref("r 1", { ref: "main", path: "", file: "a b" }), "/codecommit/repositories/r%201?ref=main&file=a+b");
});

test("CodeCommit file content and choices", () => {
  assert.equal(decodeFileText(new TextEncoder().encode("héllo")), "héllo");
  assert.equal(decodeFileText(new Uint8Array([0x68, 0x00])), null);
  assert.equal(decodeFileText(new Uint8Array([0xff, 0xfe])), null);
  assert.equal(decodeFileText(undefined), "");
  assert.deepEqual(splitRepoBranch(repoBranchValue("repo", "feat/a")), { repo: "repo", branch: "feat/a" });
  assert.equal(splitRepoBranch("nocolon"), null);
  assert.equal(splitRepoBranch(":x"), null);
  assert.equal(changeTypeLabel("A"), "Added");
  assert.equal(changeTypeLabel("X"), "X");
  assert.deepEqual(lines(" a \n\n b\r\n"), ["a", "b"]);
});

test("CodeCommit approval rule content", () => {
  assert.deepEqual(JSON.parse(approvalRuleContent(2, [], [])), { Version: "2018-11-08", Statements: [{ Type: "Approvers", NumberOfApprovalsNeeded: 2 }] });
  const c = JSON.parse(approvalRuleContent(1, ["arn:aws:iam::000000000000:user/*"], ["main", "refs/heads/dev"]));
  assert.deepEqual(c.DestinationReferences, ["refs/heads/main", "refs/heads/dev"]);
  assert.deepEqual(c.Statements[0].ApprovalPoolMembers, ["arn:aws:iam::000000000000:user/*"]);
});
