import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { buildChildEnv, buildSandboxProfile, capOutput, rewriteCliConfig } from "../src/lib/cloudshell-sandbox.ts";

const W = "/private/var/folders/x/T/cloudshell-abc";
const WP = { dir: W, home: `${W}/home` };

test("the sandbox profile denies files by default, other networks and programs outside the system folders", () => {
  const p = buildSandboxProfile(WP, 9297);
  assert.match(p, /\(deny file-read\* file-write\*\)\n\(allow file-read-metadata\)/);
  assert.match(p, /\(deny file-read\* file-write\* \(subpath "\/Users"\) \(subpath "\/Volumes"\) \(subpath "\/private\/var\/root"\)\)/);
  assert.match(p, /\(allow file-read\* \(subpath "\/private\/var\/folders\/x\/T\/cloudshell-abc"\)\)/);
  assert.match(p, /\(allow file-write\* \(subpath "\/private\/var\/folders\/x\/T\/cloudshell-abc\/home"\)\)/);
  // Writes only into home/ and the output devices; no broad write allowance anywhere.
  const writeRules = p.split("\n").filter((l) => /^\(allow file-write/.test(l));
  assert.equal(writeRules.length, 2, writeRules.join("\n"));
  assert.match(writeRules[0], /^\(allow file-write-data \(literal "\/dev\/null"\)/);
  assert.doesNotMatch(p, /\(allow default\)[\s\S]*\(allow file-write\* \(subpath "\/(opt|usr|private\/tmp)/);
  assert.doesNotMatch(p, /unix-socket/);
  assert.match(p, /\(deny network\*\)\n\(allow network-outbound \(remote ip "localhost:9297"\)\)/);
  assert.match(p, /\(deny process-exec\)\n\(allow process-exec \(subpath "\/opt\/homebrew\/bin"\)/);
  // Later rules win: the /Users denial comes after the read allow list, the work folder after that.
  assert.ok(p.indexOf('(subpath "/Users")') > p.indexOf('(subpath "/System")'));
  assert.ok(p.indexOf(`(allow file-read* (subpath "${W}"))`) > p.indexOf('(subpath "/Users")'));
});

test("the profile refuses paths and ports that could break its syntax", () => {
  assert.throws(() => buildSandboxProfile({ dir: '/tmp/x") (allow default', home: '/tmp/x") (allow default/home' }, 9297), /unsafe path/);
  assert.throws(() => buildSandboxProfile({ dir: "relative/dir", home: "relative/dir/home" }, 9297), /unsafe path/);
  assert.throws(() => buildSandboxProfile({ dir: "/tmp/x", home: "/tmp/y" }, 9297), /inside the work folder/);
  assert.throws(() => buildSandboxProfile({ dir: "/tmp/x", home: "/tmp/x/home" }, 0), /port/);
});

test("the child environment is complete and inherits nothing", () => {
  const paths = { dir: "/w", home: "/w/home", bin: "/w/bin", config: "/w/conf/config", credentials: "/w/conf/emulator_credentials", ca: "/w/conf/ca.pem" };
  const env = buildChildEnv(paths, 9297);
  assert.equal(env.HOME, "/w/home");
  assert.equal(env.TMPDIR, "/w/home");
  assert.equal(env.PATH, "/w/bin");
  assert.equal(env.AWS_SHARED_CREDENTIALS_FILE, "/w/conf/emulator_credentials");
  assert.equal(env.AWS_PAGER, "");
  assert.equal(env.AWS_ENDPOINT_URL, "https://127.0.0.1:9297");
  for (const k of ["AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "NODE_OPTIONS", "USER"]) assert.equal(k in env, false, k);
});

test("the CLI config copy points ca_bundle at the work folder", () => {
  const cfg = "[default]\nregion = us-east-1\nendpoint_url = https://127.0.0.1:9297\nca_bundle = /Users/me/.aws/emulator/9297/ca.pem\ns3 =\n  signature_version = s3v4\n";
  const out = rewriteCliConfig(cfg, "/w/ca.pem");
  assert.doesNotMatch(out, /\/Users\//);
  assert.match(out, /^\[default\]\nca_bundle = \/w\/ca.pem\nregion = us-east-1/);
  assert.match(rewriteCliConfig("region = x", "/w/ca.pem"), /^\[default\]\nca_bundle = \/w\/ca.pem/);
});

test("output is capped", () => {
  assert.equal(capOutput("abc", 10), "abc");
  assert.match(capOutput("x".repeat(20), 10), /^x{10}\n\[output cut at 10 bytes\]$/);
});

test("on macOS the profile really blocks host files, outside networks, and allows only home/ for writes", { skip: process.platform !== "darwin" }, () => {
  const work = realpathSync(mkdtempSync(join(tmpdir(), "sbx-test-")));
  const home = join(work, "home");
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "sbx-outside-")));
  try {
    mkdirSync(home);
    const profile = join(work, "p.sb");
    writeFileSync(profile, buildSandboxProfile({ dir: work, home }, 9297));
    writeFileSync(join(work, "ok.txt"), "inside");
    const sbx = (cmd, args) => execFileSync("/usr/bin/sandbox-exec", ["-f", profile, cmd, ...args], { encoding: "utf8", stdio: "pipe" });
    assert.equal(sbx("/bin/cat", [join(work, "ok.txt")]), "inside");
    sbx("/usr/bin/touch", [join(home, "written")]);
    assert.ok(existsSync(join(home, "written")));
    // Not writable: the config folder, another temp folder, /private/tmp.
    assert.throws(() => sbx("/usr/bin/touch", [join(work, "conf-write")]));
    assert.throws(() => sbx("/usr/bin/touch", [join(outside, "pwn")]));
    assert.equal(existsSync(join(outside, "pwn")), false);
    // Not readable: the home folder, /etc, other temp folders.
    writeFileSync(join(outside, "secret"), "s");
    assert.throws(() => sbx("/bin/cat", [join(outside, "secret")]));
    assert.throws(() => sbx("/bin/cat", ["/etc/hosts"]));
    assert.throws(() => sbx("/bin/ls", [homedir()]));
    assert.throws(() => sbx("/usr/bin/curl", ["-sS", "-m", "3", "http://1.1.1.1"]));
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
