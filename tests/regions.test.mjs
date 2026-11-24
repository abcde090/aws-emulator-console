import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONSOLE_REGIONS,
  DEFAULT_REGION,
  GLOBAL_CLIENT_KEYS,
  GLOBAL_HOME_REGION,
  GLOBAL_SERVICE_IDS,
  isConsoleRegion,
  isGlobalPage,
  pageRegion,
  parseRegionCookie,
  pathSegments,
  regionName,
  regionSwitchTarget,
} from "../src/lib/regions.ts";
import { consoleClientRegion, consoleClients, clientsIn, SERVICE_KEYS } from "../src/lib/aws.ts";
import { buildChildEnv } from "../src/lib/cloudshell-sandbox.ts";
import { emulatorFiles } from "../src/lib/emulator-files.ts";
import { existsSync } from "node:fs";

// Building a client reads the emulator's CA and keys (nothing is sent).
const noEmulatorFiles = !existsSync(emulatorFiles().credentials) && "the emulator's key files are not present";

test("the Region cookie is validated against the allowlist, never trusted", () => {
  assert.equal(parseRegionCookie("us-west-2"), "us-west-2");
  assert.equal(parseRegionCookie("eu-north-1"), "eu-north-1");
  for (const bad of [undefined, "", " us-west-2", "us-west-2 ", "US-WEST-2", "us-west-9", "af-south-1", "us-gov-west-1", "cn-north-1", "xx-fake-9", "us-west-2;x", '"us-west-2"', "us-west-2/../x", "evil.com"]) {
    assert.equal(parseRegionCookie(bad), DEFAULT_REGION, String(bad));
  }
  assert.equal(isConsoleRegion("us-east-1"), true);
  assert.equal(isConsoleRegion(42), false);
  assert.equal(isConsoleRegion("ap-east-1"), false, "opt-in Regions are not offered");
});

test("the offered Regions: 17 default-enabled ones, unique, with AWS names", () => {
  assert.equal(CONSOLE_REGIONS.length, 17);
  assert.equal(new Set(CONSOLE_REGIONS.map((r) => r.code)).size, 17);
  assert.equal(CONSOLE_REGIONS[0].code, DEFAULT_REGION);
  assert.equal(regionName("us-west-2"), "US West (Oregon)");
  assert.equal(regionName("us-east-1"), "US East (N. Virginia)");
  assert.equal(regionName("zz-none-1"), "zz-none-1");
  assert.throws(() => CONSOLE_REGIONS.push({ code: "x", name: "x" }), TypeError);
});

test("global services show Global and use us-east-1; their Regional pages and other services use the chosen Region", () => {
  for (const id of ["iam", "organizations", "route53", "cloudfront", "cost", "s3", "identitycenter"]) {
    assert.equal(isGlobalPage(id), true, id);
    assert.equal(pageRegion(id, undefined, "us-west-2"), GLOBAL_HOME_REGION, id);
  }
  assert.equal(isGlobalPage("iam", "users"), true);
  assert.equal(isGlobalPage("iam", "access-analyzer"), false, "Access Analyzer is Regional");
  assert.equal(pageRegion("iam", "access-analyzer-findings", "eu-west-1"), "eu-west-1");
  for (const id of ["dynamodb", "sqs", "waf", "ec2", "lambda", undefined]) assert.equal(pageRegion(id, undefined, "us-west-2"), "us-west-2", String(id));
  assert.equal(GLOBAL_SERVICE_IDS.has("waf"), false, "WAF is Regional (its CloudFront scope uses us-east-1 itself)");
});

test("global SDK clients always sign for us-east-1; Regional ones for the page's Region", { skip: noEmulatorFiles }, async () => {
  for (const key of GLOBAL_CLIENT_KEYS) assert.ok(SERVICE_KEYS.includes(key), key);
  assert.equal(consoleClientRegion("iam", "us-west-2"), "us-east-1");
  assert.equal(consoleClientRegion("s3", "eu-west-1"), "us-east-1");
  assert.equal(consoleClientRegion("dynamodb", "us-west-2"), "us-west-2");
  assert.equal(consoleClientRegion("wafv2", "us-west-2"), "us-west-2");
  const west = consoleClients("us-west-2");
  assert.equal(consoleClients("us-west-2"), west, "cached");
  assert.deepEqual(Object.keys(west).sort(), [...SERVICE_KEYS].sort());
  assert.equal(await west.dynamodb.config.region(), "us-west-2");
  assert.equal(await west.sqs.config.region(), "us-west-2");
  assert.equal(await west.iam.config.region(), "us-east-1");
  assert.equal(await west.route53.config.region(), "us-east-1");
  // clientsIn() is explicit: every client signs for the Region asked for.
  assert.equal(await clientsIn("us-west-2").s3.config.region(), "us-west-2");
  assert.throws(() => consoleClients("evil.com"), /not a valid AWS Region/);
});

test("switching Region keeps the service; a detail page goes to its list", () => {
  assert.equal(regionSwitchTarget("/"), "/");
  assert.equal(regionSwitchTarget(""), "/");
  assert.equal(regionSwitchTarget("/dynamodb"), "/dynamodb");
  assert.equal(regionSwitchTarget("/dynamodb/tables"), "/dynamodb/tables");
  assert.equal(regionSwitchTarget("/dynamodb/tables/Orders"), "/dynamodb/tables");
  assert.equal(regionSwitchTarget("/dynamodb/tables/Orders/items?x=1"), "/dynamodb/tables");
  assert.equal(regionSwitchTarget("/sqs/queues/create"), "/sqs/queues");
  assert.deepEqual(pathSegments("/iam/access-analyzer/a1"), { serviceId: "iam", resourceId: "access-analyzer" });
  assert.deepEqual(pathSegments("/"), { serviceId: undefined, resourceId: undefined });
});

test("CloudShell's environment carries the chosen Region and refuses anything else", () => {
  const paths = { dir: "/w", home: "/w/home", bin: "/w/bin", config: "/w/conf/config", credentials: "/w/conf/emulator_credentials", ca: "/w/conf/ca.pem" };
  const env = buildChildEnv(paths, 9297, "us-west-2");
  assert.equal(env.AWS_REGION, "us-west-2");
  assert.equal(env.AWS_DEFAULT_REGION, "us-west-2");
  assert.equal(buildChildEnv(paths, 9297).AWS_REGION, "us-east-1");
  for (const bad of ["us-gov-west-1", "us-west-2\nAWS_PROFILE=x", "", "af-south-1"]) {
    assert.throws(() => buildChildEnv(paths, 9297, bad), /not a Region this console offers/, bad);
  }
});
