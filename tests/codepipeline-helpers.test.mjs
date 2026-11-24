import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStages, defaultArtifactBucket, defaultPipelineRoleName, pipelineTone, statusText } from "../src/services/codepipeline/helpers.ts";

test("CodePipeline stage building", () => {
  const s = buildStages({ sourceProvider: "CodeCommit", repository: "r", branch: "", approval: true, buildProject: "p", deployBucket: "b" });
  assert.deepEqual(s.map((x) => x.name), ["Source", "Build", "Approval", "Deploy"]);
  assert.equal(s[0].actions[0].configuration.BranchName, "main");
  assert.equal(s[3].actions[0].inputArtifacts[0].name, "BuildArtifact");
  const noBuild = buildStages({ sourceProvider: "S3", sourceBucket: "b", sourceKey: "k.zip", approval: false, deployBucket: "d", deployExtract: false });
  assert.equal(noBuild[1].actions[0].inputArtifacts[0].name, "SourceArtifact");
  assert.equal(noBuild[1].actions[0].configuration.Extract, "false");
  assert.throws(() => buildStages({ sourceProvider: "CodeCommit", repository: "r", approval: false }), /at least two stages/);
  assert.throws(() => buildStages({ sourceProvider: "CodeCommit", approval: true }), /repository/);
  assert.throws(() => buildStages({ sourceProvider: "S3", sourceBucket: "b", approval: true }), /object key/);
});

test("CodePipeline wording", () => {
  assert.equal(statusText("InProgress"), "In progress");
  assert.equal(statusText("Failed"), "Failed");
  assert.equal(statusText(null), "-");
  assert.equal(pipelineTone("Succeeded"), "success");
  assert.equal(pipelineTone("InProgress"), "pending");
  assert.equal(pipelineTone("Stopped"), "warning");
  assert.equal(pipelineTone(undefined), "neutral");
  assert.equal(defaultArtifactBucket("us-east-1", "000000000000"), "codepipeline-us-east-1-000000000000");
  assert.ok(defaultPipelineRoleName("us-east-1", "x".repeat(100)).length <= 64);
});
