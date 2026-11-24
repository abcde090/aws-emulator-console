import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIdentityCookie } from "../src/lib/identity-cookie.ts";

test("no cookie means the emulator admin", () => {
  assert.deepEqual(parseIdentityCookie(undefined), { type: "admin" });
});

test("a valid user or role cookie is read", () => {
  assert.deepEqual(parseIdentityCookie(JSON.stringify({ type: "user", name: "alice" })), { type: "user", name: "alice" });
  assert.deepEqual(parseIdentityCookie(JSON.stringify({ type: "role", name: "app-role" })), { type: "role", name: "app-role" });
});

test("an unreadable or odd cookie is invalid, never admin", () => {
  for (const raw of ["{", "null", JSON.stringify({ type: "admin" }), JSON.stringify({ type: "user" }), JSON.stringify({ type: "user", name: "a b/c" })]) {
    assert.equal(parseIdentityCookie(raw).type, "invalid", raw);
  }
});
