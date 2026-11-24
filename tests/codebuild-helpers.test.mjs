import { test } from "node:test";
import assert from "node:assert/strict";
import { codebuildBasePolicy, codecommitUrl, defaultRoleName, durationSeconds, envVarsFromTags, formatDuration, PROJECT_NAME, sourceLabel, sourceRepository, splitBuildId } from "../src/services/codebuild/helpers.ts";

test("CodeBuild helpers", () => {
  assert.deepEqual(splitBuildId("my-proj:75a2e611-9eaa"), { project: "my-proj", uuid: "75a2e611-9eaa" });
  assert.equal(splitBuildId("nocolon"), null);
  assert.equal(durationSeconds("2026-01-01T00:00:00Z", "2026-01-01T00:01:15Z"), 75);
  assert.equal(durationSeconds(new Date(0), new Date(2000)), 2);
  assert.equal(durationSeconds("2026-01-01T00:00:00Z", null), null);
  assert.equal(durationSeconds("2026-01-02T00:00:00Z", "2026-01-01T00:00:00Z"), null);
  assert.equal(formatDuration(75), "1 minute 15 seconds");
  assert.equal(formatDuration(1), "1 second");
  assert.equal(formatDuration(null), null);
  assert.deepEqual(envVarsFromTags([{ Key: "A", Value: "1" }, { Key: "", Value: "x" }]), [{ name: "A", value: "1", type: "PLAINTEXT" }]);
  assert.deepEqual(envVarsFromTags("nope"), []);
  assert.equal(sourceLabel("CODECOMMIT"), "AWS CodeCommit");
  assert.equal(sourceLabel("OTHER"), "OTHER");
  assert.equal(codecommitUrl("us-east-1", "r"), "https://git-codecommit.us-east-1.amazonaws.com/v1/repos/r");
  assert.equal(sourceRepository("CODECOMMIT", codecommitUrl("us-east-1", "r")), "r");
  assert.equal(sourceRepository("S3", "b/k.zip"), "b/k.zip");
  assert.equal(sourceRepository("NO_SOURCE", undefined), null);
  assert.ok(defaultRoleName("x".repeat(100)).length <= 64);
  assert.ok(new RegExp(`^(?:${PROJECT_NAME})$`).test("my_build-1"));
  assert.ok(!new RegExp(`^(?:${PROJECT_NAME})$`).test("-bad"));
  const policy = JSON.parse(codebuildBasePolicy("us-east-1", "000000000000", "p"));
  assert.ok(policy.Statement[0].Resource[0].endsWith("/aws/codebuild/p"));
});
