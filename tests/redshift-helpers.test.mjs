import { test } from "node:test";
import assert from "node:assert/strict";
import { endpointText, jdbcUrl, passwordProblem, splitList, storageText, titleCase } from "../src/services/redshift/helpers.ts";

test("Redshift helpers", () => {
  assert.equal(endpointText({ Address: "c.example", Port: 5439 }), "c.example:5439");
  assert.equal(jdbcUrl({ Address: "c.example", Port: 5439 }, "dev"), "jdbc:redshift://c.example:5439/dev");
  assert.equal(jdbcUrl(undefined, "dev"), null);
  assert.equal(storageText(2 * 1024 * 1024), "2.0 TB");
  assert.equal(storageText(512 * 1024), "512 GB");
  assert.equal(storageText(undefined), null);
  assert.equal(titleCase("available"), "Available");
  assert.equal(titleCase(undefined), null);
  assert.deepEqual(splitList("a, b"), ["a", "b"]);
});

test("Redshift admin password rules", () => {
  assert.equal(passwordProblem("Passw0rd1"), null);
  assert.match(passwordProblem("short1A"), /8-64/);
  assert.match(passwordProblem("password1"), /uppercase/);
  assert.match(passwordProblem("Pass word1"), /can't contain/);
  assert.match(passwordProblem("Pass@word1"), /can't contain/);
});
