import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// CQ-4: clients are rebuilt (and the old ones destroyed) when the emulator writes new keys,
// and the key files are not stat'ed on every client property access.
test("a key rotation gives new clients (old ones retired after a grace period); files are checked at most once per TTL", async () => {
  const home = mkdtempSync(join(tmpdir(), "aws-clients-test-"));
  const savedHome = process.env.HOME;
  const savedPort = process.env.EMULATOR_PORT;
  process.env.HOME = home;
  delete process.env.EMULATOR_PORT;
  const dir = join(home, ".aws", "emulator", "9297");
  mkdirSync(dir, { recursive: true });
  const writeKeys = (id) => writeFileSync(join(dir, "emulator_credentials"), `[default]\naws_access_key_id = ${id}\naws_secret_access_key = s${id}\n`);
  writeFileSync(join(dir, "ca.pem"), "");
  writeKeys("AKIA1");
  try {
    const aws = await import("../src/lib/aws.ts");
    aws.resetClientsForTests();
    const first = aws.uncheckedS3();
    assert.equal(aws.uncheckedS3(), first, "cached");
    assert.equal((await first.config.credentials()).accessKeyId, "AKIA1");
    let destroyed = false;
    const origDestroy = first.destroy.bind(first);
    first.destroy = () => {
      destroyed = true;
      origDestroy();
    };
    writeKeys("AKIA22");
    // Within the TTL the old config is still trusted (no stat per access).
    assert.equal(aws.uncheckedS3(), first);
    await new Promise((r) => setTimeout(r, aws.FINGERPRINT_TTL_MS + 50));
    const second = aws.uncheckedS3();
    assert.notEqual(second, first);
    assert.equal((await second.config.credentials()).accessKeyId, "AKIA22");
    // Old clients are destroyed after a grace period for calls in flight; reset forces it now.
    aws.resetClientsForTests();
    assert.equal(destroyed, false, "grace period: not destroyed synchronously");
  } finally {
    process.env.HOME = savedHome;
    if (savedPort !== undefined) process.env.EMULATOR_PORT = savedPort;
    rmSync(home, { recursive: true, force: true });
  }
});
