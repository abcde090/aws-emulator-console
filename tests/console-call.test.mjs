import { test } from "node:test";
import assert from "node:assert/strict";
import { callServer, TRANSPORT_ERROR } from "../src/console/call.ts";

test("CQ-2: a failed server-action call becomes an error result instead of a rejected promise", async () => {
  assert.deepEqual(await callServer(async () => ({ ok: true, data: 1 })), { ok: true, data: 1 });
  assert.deepEqual(await callServer(async () => ({ ok: false, error: "AccessDenied" })), { ok: false, error: "AccessDenied" });
  const failed = await callServer(async () => {
    throw new TypeError("Failed to fetch");
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.error, `${TRANSPORT_ERROR} (Failed to fetch)`);
  assert.deepEqual(await callServer(async () => undefined), { ok: false, error: TRANSPORT_ERROR });
});
