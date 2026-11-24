import { test } from "node:test";
import assert from "node:assert/strict";
import { depthFirst, isOuId, isRootId, parentFromPath, unitNodes } from "../src/services/organizations/tree.ts";

const root = { id: "r-ab12", name: "Root", arn: null, type: "Root", parentId: null, depth: 0, hierarchy: "Root" };

test("unitNodes builds child nodes with depth and hierarchy", () => {
  const kids = unitNodes(root, [{ Id: "ou-ab12-11111111", Name: "Prod" }, { Name: "no id" }]);
  assert.equal(kids.length, 1);
  assert.deepEqual(kids[0], { id: "ou-ab12-11111111", name: "Prod", arn: null, type: "Organizational unit", parentId: "r-ab12", depth: 1, hierarchy: "Root / Prod" });
});

test("depthFirst puts parents before children, siblings by name", () => {
  const [b, a] = unitNodes(root, [{ Id: "ou-ab12-bbbbbbbb", Name: "B" }, { Id: "ou-ab12-aaaaaaaa", Name: "A" }]);
  const [a1] = unitNodes(a, [{ Id: "ou-ab12-a1a1a1a1", Name: "A1" }]);
  assert.deepEqual(depthFirst([a1, b, root, a]).map((n) => n.name), ["Root", "A", "A1", "B"]);
  assert.equal(depthFirst([a1]).length, 1, "orphans still shown");
});

test("parentFromPath and id checks", () => {
  assert.equal(parentFromPath("o-x/r-ab12/ou-ab12-11111111/ou-ab12-22222222/", "ou-ab12-22222222"), "ou-ab12-11111111");
  assert.equal(parentFromPath("o-x/r-ab12/ou-ab12-11111111/", "ou-ab12-11111111"), "r-ab12");
  assert.equal(parentFromPath(undefined, "x"), null);
  assert.equal(parentFromPath("o-x/", "ou-zz"), null);
  assert.equal(isOuId("ou-7qygd7aa-y86t7bfa"), true);
  assert.equal(isOuId("r-7qygd7aa"), false);
  assert.equal(isRootId("r-7qygd7aa"), true);
  assert.equal(isRootId("../x"), false);
});
