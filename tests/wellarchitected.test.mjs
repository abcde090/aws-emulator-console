import { test } from "node:test";
import assert from "node:assert/strict";
import {
  answeredText,
  checkSelection,
  environmentLabel,
  isNoneChoice,
  LENS_ALIAS,
  parseMilestone,
  reportFileName,
  riskCount,
  splitList,
  tagMap,
  toggleChoice,
  totalQuestions,
  WORKLOAD_ID,
} from "../src/services/wellarchitected/helpers.ts";

const choices = [
  { ChoiceId: "sec_a", Title: "A" },
  { ChoiceId: "sec_b", Title: "B" },
  { ChoiceId: "sec_no", Title: "None of these" },
];

test("risk counts", () => {
  const counts = { HIGH: 2, MEDIUM: 1, NONE: 3, NOT_APPLICABLE: 1, UNANSWERED: 50 };
  assert.equal(riskCount(counts, "HIGH"), 2);
  assert.equal(riskCount(counts, "MISSING"), 0);
  assert.equal(riskCount(null, "HIGH"), 0);
  assert.equal(totalQuestions(counts), 57);
  assert.equal(answeredText(counts), "7/57");
  assert.equal(answeredText({}), null);
  assert.equal(answeredText(undefined), null);
});

test("lists, labels and tags", () => {
  assert.deepEqual(splitList("us-east-1, eu-west-1\nus-east-1 "), ["us-east-1", "eu-west-1"]);
  assert.deepEqual(splitList(["a", " b ", "", 3]), ["a", "b"]);
  assert.deepEqual(splitList(null), []);
  assert.equal(environmentLabel("PREPRODUCTION"), "Pre-production");
  assert.equal(environmentLabel(undefined), null);
  assert.deepEqual(tagMap([{ Key: "team", Value: "a" }, { Key: "", Value: "x" }]), { team: "a" });
  assert.equal(tagMap([]), undefined);
});

test("choice selection rules", () => {
  assert.equal(isNoneChoice({ ChoiceId: "x_no" }), true);
  assert.equal(isNoneChoice({ ChoiceId: "x", Title: "None of these" }), true);
  assert.equal(isNoneChoice({ ChoiceId: "x", Title: "Y" }), false);
  assert.deepEqual(checkSelection(choices, ["sec_b", "sec_a"]), { ok: true, value: ["sec_a", "sec_b"] });
  assert.deepEqual(checkSelection(choices, []), { ok: true, value: [] });
  assert.equal(checkSelection(choices, ["sec_no", "sec_a"]).ok, false);
  assert.equal(checkSelection(choices, ["bogus"]).ok, false);
  assert.equal(checkSelection(choices, "sec_a").ok, false);
  assert.deepEqual(toggleChoice(choices, ["sec_a"], "sec_no", true), ["sec_no"]);
  assert.deepEqual(toggleChoice(choices, ["sec_no"], "sec_b", true), ["sec_b"]);
  assert.deepEqual(toggleChoice(choices, ["sec_a", "sec_b"], "sec_a", false), ["sec_b"]);
  assert.deepEqual(toggleChoice(choices, ["sec_a"], "unknown", true), ["sec_a"]);
});

test("ids, milestones and report names", () => {
  assert.equal(WORKLOAD_ID.test("32eb128b085e1a79e8b6b9ed0ab58b09"), true);
  assert.equal(WORKLOAD_ID.test("../x"), false);
  assert.equal(LENS_ALIAS.test("wellarchitected"), true);
  assert.equal(LENS_ALIAS.test("arn:aws:wellarchitected:us-east-1:000000000000:lens/abc"), true);
  assert.equal(LENS_ALIAS.test("bad alias"), false);
  assert.equal(parseMilestone(null), null);
  assert.equal(parseMilestone("3"), 3);
  assert.equal(parseMilestone("0"), "invalid");
  assert.equal(parseMilestone("101"), "invalid");
  assert.equal(parseMilestone("1e2"), "invalid");
  assert.equal(reportFileName('my "wl"/x', "wellarchitected", null), "my_wl_x-wellarchitected.pdf");
  assert.equal(reportFileName("w", "arn:aws:wellarchitected::aws:lens/serverless", 2), "w-serverless-milestone-2.pdf");
});

test("SEC-9: lens links render only for http(s) URLs", async () => {
  const { safeExternalUrl } = await import("../src/services/wellarchitected/helpers.ts");
  assert.equal(safeExternalUrl("https://docs.aws.amazon.com/wellarchitected/x"), "https://docs.aws.amazon.com/wellarchitected/x");
  assert.equal(safeExternalUrl("http://example.com/a"), "http://example.com/a");
  for (const bad of ["javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html,<b>x</b>", "file:///etc/passwd", "vbscript:x", "/relative", "", null, undefined, "not a url"]) {
    assert.equal(safeExternalUrl(bad), null, String(bad));
  }
});
