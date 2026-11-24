import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSecretString, secretStringFrom } from "../src/services/secretsmanager/secret-value.ts";

test("secret value from the create form", () => {
  assert.equal(secretStringFrom("kv", [{ Key: "user", Value: "a" }, { Key: " ", Value: "x" }, { Key: "pass", Value: "b" }], ""), '{"user":"a","pass":"b"}');
  assert.throws(() => secretStringFrom("kv", [], ""));
  assert.throws(() => secretStringFrom("kv", [{ Key: "a", Value: "1" }, { Key: "a", Value: "2" }], ""));
  assert.equal(secretStringFrom("plaintext", null, "token"), "token");
  assert.throws(() => secretStringFrom("plaintext", null, ""));
});

test("secret strings are shown as key/value when they are flat JSON", () => {
  assert.deepEqual(parseSecretString('{"a":"1","n":2,"z":null}'), { kind: "kv", pairs: [{ Key: "a", Value: "1" }, { Key: "n", Value: "2" }, { Key: "z", Value: "null" }] });
  assert.equal(parseSecretString('{"a":{"b":1}}').kind, "plaintext");
  assert.equal(parseSecretString("hello").kind, "plaintext");
  assert.equal(parseSecretString("[1]").kind, "plaintext");
});

import { databaseSecretString } from "../src/services/secretsmanager/secret-value.ts";

test("database credential secrets use the rotation-template JSON", () => {
  assert.deepEqual(JSON.parse(databaseSecretString("rds", { username: "admin", password: "p w", engine: "postgres", host: "db.local", port: null, dbname: "app" })), { username: "admin", password: "p w", engine: "postgres", host: "db.local", port: 5432, dbname: "app" });
  assert.deepEqual(JSON.parse(databaseSecretString("docdb", { username: "u", password: "p", engine: "", host: "h", port: 27018, dbname: "" })), { username: "u", password: "p", engine: "mongo", host: "h", port: 27018 });
  assert.equal(JSON.parse(databaseSecretString("redshift", { username: "u", password: "p", engine: null, host: "h", port: null, dbname: null })).port, 5439);
  assert.throws(() => databaseSecretString("rds", { username: "u", password: "", engine: "mysql", host: "h", port: null, dbname: null }));
  assert.throws(() => databaseSecretString("otherdb", { username: "u", password: "p", engine: "", host: "h", port: null, dbname: null }));
});
