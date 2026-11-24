import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRule, metricName, nextPriority, parseAddresses, parseCountryCodes, parseRegexList, ruleActionLabel, ruleRows, splitManagedId, statementSummary, statementType } from "../src/services/waf/helpers.ts";

test("WAF: builds rules of every kind", () => {
  const managed = buildRule({ kind: "managed", name: "AWSManagedRulesCommonRuleSet", priority: 0, vendor: "AWS", group: "AWSManagedRulesCommonRuleSet", overrideToCount: false });
  assert.deepEqual(managed.OverrideAction, { None: {} });
  assert.equal(managed.Action, undefined);
  assert.equal(managed.Statement.ManagedRuleGroupStatement.VendorName, "AWS");
  const counted = buildRule({ kind: "managed", name: "m", priority: 0, vendor: "AWS", group: "g", overrideToCount: true });
  assert.deepEqual(counted.OverrideAction, { Count: {} });
  const rate = buildRule({ kind: "rate", name: "rate", priority: 1, action: "Block", limit: 100, windowSec: 60, aggregateKey: "FORWARDED_IP" });
  assert.deepEqual(rate.Action, { Block: {} });
  assert.equal(rate.Statement.RateBasedStatement.Limit, 100);
  assert.equal(rate.Statement.RateBasedStatement.ForwardedIPConfig.HeaderName, "X-Forwarded-For");
  const geo = buildRule({ kind: "geo", name: "geo", priority: 2, action: "CAPTCHA", countryCodes: ["CN"] });
  assert.deepEqual(geo.Action, { Captcha: {} });
  const ip = buildRule({ kind: "ipset", name: "ip", priority: 3, action: "Allow", arn: "arn:aws:wafv2:us-east-1:0:regional/ipset/office/abc" });
  assert.equal(statementSummary(ip.Statement), "Source IP in office");
  const rx = buildRule({ kind: "regex", name: "rx", priority: 4, action: "Count", arn: "arn:x/regexpatternset/admin/1", field: "UriPath" });
  assert.deepEqual(rx.Statement.RegexPatternSetReferenceStatement.FieldToMatch, { UriPath: {} });
  assert.equal(rx.VisibilityConfig.MetricName, "rx");
  assert.throws(() => buildRule({ kind: "geo", name: "bad name!", priority: 0, action: "Block", countryCodes: ["US"] }));
});

test("WAF: rule tables, priorities and labels", () => {
  const rules = [
    { Name: "b", Priority: 5, Statement: { GeoMatchStatement: { CountryCodes: ["US", "CA"] } }, Action: { Block: {} } },
    { Name: "a", Priority: 1, Statement: { RateBasedStatement: { Limit: 10, AggregateKeyType: "IP" } }, Action: { Count: {} } },
  ];
  assert.equal(nextPriority(rules), 6);
  assert.equal(nextPriority([]), 0);
  const rows = ruleRows(rules);
  assert.deepEqual(rows.map((r) => r.name), ["a", "b"]);
  assert.equal(rows[1].statement, "Country in US, CA");
  assert.equal(rows[0].type, "Rate-based rule");
  assert.equal(ruleActionLabel({ OverrideAction: { None: {} } }), "Use rule actions");
  assert.equal(statementType(undefined), "-");
  assert.equal(metricName("a b.c"), "a_b_c");
});

test("WAF: input parsing", () => {
  assert.deepEqual(parseCountryCodes("us, ca  gb us"), ["US", "CA", "GB"]);
  assert.throws(() => parseCountryCodes("USA"));
  assert.throws(() => parseCountryCodes(" "));
  assert.deepEqual(parseAddresses("10.0.0.0/24\n192.0.2.1/32", "IPV4"), ["10.0.0.0/24", "192.0.2.1/32"]);
  assert.throws(() => parseAddresses("10.0.0.0", "IPV4"));
  assert.throws(() => parseAddresses("300.0.0.0/8", "IPV4"));
  assert.deepEqual(parseAddresses("2001:db8::/32", "IPV6"), ["2001:db8::/32"]);
  assert.throws(() => parseAddresses("10.0.0.0/8", "IPV6"));
  assert.deepEqual(parseAddresses("", "IPV4"), []);
  assert.deepEqual(parseRegexList("^/admin\n\n\\.php$"), ["^/admin", "\\.php$"]);
  assert.throws(() => parseRegexList(""));
  assert.deepEqual(splitManagedId("AWS:AWSManagedRulesSQLiRuleSet"), { vendor: "AWS", name: "AWSManagedRulesSQLiRuleSet" });
  assert.throws(() => splitManagedId("nocolon"));
});

test("WAF: console ids encode the scope", async () => {
  const { parseRef, refId, scopeOfArn, scopeLabel } = await import("../src/services/waf/client.ts");
  assert.equal(refId("REGIONAL", "abc"), "abc");
  assert.equal(refId("CLOUDFRONT", "abc"), "global:abc");
  assert.deepEqual(parseRef("global:abc"), { scope: "CLOUDFRONT", id: "abc" });
  assert.deepEqual(parseRef("abc"), { scope: "REGIONAL", id: "abc" });
  assert.equal(scopeOfArn("arn:aws:wafv2:us-east-1:000000000000:global/ipset/x/abc"), "CLOUDFRONT");
  assert.equal(scopeOfArn("arn:aws:wafv2:eu-west-1:000000000000:regional/ipset/x/abc"), "REGIONAL");
  assert.equal(scopeLabel("CLOUDFRONT", "eu-west-1"), "Global (CloudFront)");
  assert.equal(scopeLabel("REGIONAL", "eu-west-1"), "Regional (eu-west-1)");
});
