import { test } from "node:test";
import assert from "node:assert/strict";
import { emulatorEndpoint, emulatorFiles, emulatorPort, parseCredentialsIni } from "../src/lib/emulator-files.ts";

test("EMULATOR_PORT defaults to 9297 and must be a plain port number", () => {
  assert.equal(emulatorPort({}), 9297);
  assert.equal(emulatorPort({ EMULATOR_PORT: "9300" }), 9300);
  for (const bad of ["0", "70000", "9297@evil.com", "abc", "-1"]) assert.throws(() => emulatorPort({ EMULATOR_PORT: bad }), /port number/);
  assert.equal(emulatorEndpoint(9297), "https://127.0.0.1:9297");
});

test("emulator files live in ~/.aws/emulator/<port>/", () => {
  assert.deepEqual(emulatorFiles(9297, "/home/x"), {
    dir: "/home/x/.aws/emulator/9297",
    config: "/home/x/.aws/emulator/9297/config",
    credentials: "/home/x/.aws/emulator/9297/emulator_credentials",
    ca: "/home/x/.aws/emulator/9297/ca.pem",
  });
});

test("reads the default profile's keys only", () => {
  const ini = "[other]\naws_access_key_id = O\naws_secret_access_key = OS\n\n[default]\n# comment\naws_access_key_id = AKID\naws_secret_access_key = SECRET=with=equals\n"; // gitleaks:allow (fake test values)
  assert.deepEqual(parseCredentialsIni(ini), { accessKeyId: "AKID", secretAccessKey: "SECRET=with=equals" }); // gitleaks:allow
  assert.equal(parseCredentialsIni("[default]\naws_access_key_id = A\n"), null);
  assert.equal(parseCredentialsIni(""), null);
});
