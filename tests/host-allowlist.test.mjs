import { test } from "node:test";
import assert from "node:assert/strict";
import { isLocalHostHeader } from "../src/lib/host-allowlist.ts";

test("accepts loopback hosts on any port", () => {
  for (const h of ["127.0.0.1:3000", "localhost:3000", "localhost", "127.0.0.1", "[::1]:3000", "LOCALHOST:3000"]) {
    assert.equal(isLocalHostHeader(h), true, h);
  }
});

test("rejects other hosts, including DNS-rebinding names", () => {
  for (const h of [null, "", "evil.example:3000", "127.0.0.1.evil.example", "localhost.evil.example:3000", "192.168.1.10:3000", "0.0.0.0:3000"]) {
    assert.equal(isLocalHostHeader(h), false, String(h));
  }
});
