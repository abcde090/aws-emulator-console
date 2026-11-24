import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRecordSet,
  decodeDnsName,
  EMPTY_RECORD_INPUT,
  fullName,
  healthStatus,
  isZoneDefault,
  recordKey,
  recordRow,
  recordToInput,
  subdomain,
} from "../src/services/route53/records.ts";
import { bareZoneId } from "../src/services/route53/zone-id.ts";

const ZONE = "example.com.";
const input = (p) => ({ ...EMPTY_RECORD_INPUT, ...p });

test("Route 53 names", () => {
  assert.equal(fullName("", ZONE), "example.com.");
  assert.equal(fullName("www", ZONE), "www.example.com.");
  assert.equal(fullName("WWW.example.com", ZONE), "www.example.com.");
  assert.equal(fullName("a.b.", "example.com"), "a.b.example.com.");
  assert.equal(subdomain("www.example.com.", ZONE), "www");
  assert.equal(subdomain("example.com.", ZONE), "");
  assert.equal(decodeDnsName("\\052.example.com."), "*.example.com.");
  assert.equal(bareZoneId("/hostedzone/Z123"), "Z123");
  assert.equal(bareZoneId("Z123"), "Z123");
});

test("Route 53 simple and alias records are built and validated", () => {
  const simple = buildRecordSet(input({ name: "www", values: "192.0.2.1\n\n192.0.2.2 ", ttl: "60" }), ZONE);
  assert.deepEqual(simple, { ok: true, record: { Name: "www.example.com.", Type: "A", TTL: 60, ResourceRecords: [{ Value: "192.0.2.1" }, { Value: "192.0.2.2" }] } });
  assert.equal(buildRecordSet(input({ name: "www", values: "" }), ZONE).ok, false);
  assert.equal(buildRecordSet(input({ name: "www", values: "1.2.3.4", ttl: "x" }), ZONE).ok, false);
  assert.equal(buildRecordSet(input({ name: "c", type: "CNAME", values: "a.com\nb.com" }), ZONE).ok, false);
  assert.equal(buildRecordSet(input({ name: "x", type: "BOGUS", values: "1" }), ZONE).ok, false);
  assert.equal(buildRecordSet(input({ name: "bad name!", values: "1.2.3.4" }), ZONE).ok, false);
  const alias = buildRecordSet(input({ name: "a", alias: true, aliasZoneId: " Z1 ", aliasDnsName: "www.example.com", evaluateTargetHealth: false }), ZONE);
  assert.deepEqual(alias, { ok: true, record: { Name: "a.example.com.", Type: "A", AliasTarget: { HostedZoneId: "Z1", DNSName: "www.example.com", EvaluateTargetHealth: false } } });
  assert.equal(buildRecordSet(input({ alias: true, aliasZoneId: " ", aliasDnsName: "x" }), ZONE).ok, false);
});

test("Route 53 routing policies", () => {
  const base = { name: "w", values: "192.0.2.1", setIdentifier: "one" };
  const w = buildRecordSet(input({ ...base, routing: "weighted", weight: "10", healthCheckId: "hc-1" }), ZONE);
  assert.equal(w.ok && w.record.Weight, 10);
  assert.equal(w.ok && w.record.HealthCheckId, "hc-1");
  assert.equal(buildRecordSet(input({ ...base, routing: "weighted", weight: "300" }), ZONE).ok, false);
  assert.equal(buildRecordSet(input({ ...base, routing: "weighted", weight: "1", setIdentifier: "" }), ZONE).ok, false);
  const l = buildRecordSet(input({ ...base, routing: "latency", region: "eu-west-1" }), ZONE);
  assert.equal(l.ok && l.record.Region, "eu-west-1");
  const f = buildRecordSet(input({ ...base, routing: "failover", failover: "SECONDARY" }), ZONE);
  assert.equal(f.ok && f.record.Failover, "SECONDARY");
  const gDefault = buildRecordSet(input({ ...base, routing: "geolocation", geoContinent: "*" }), ZONE);
  assert.deepEqual(gDefault.ok && gDefault.record.GeoLocation, { CountryCode: "*" });
  const gCountry = buildRecordSet(input({ ...base, routing: "geolocation", geoContinent: "", geoCountry: "us", geoSubdivision: "wa" }), ZONE);
  assert.deepEqual(gCountry.ok && gCountry.record.GeoLocation, { CountryCode: "US", SubdivisionCode: "WA" });
  const gCont = buildRecordSet(input({ ...base, routing: "geolocation", geoContinent: "EU" }), ZONE);
  assert.deepEqual(gCont.ok && gCont.record.GeoLocation, { ContinentCode: "EU" });
  assert.equal(buildRecordSet(input({ ...base, routing: "geolocation", geoContinent: "" }), ZONE).ok, false);
  const mv = buildRecordSet(input({ ...base, routing: "multivalue" }), ZONE);
  assert.equal(mv.ok && mv.record.MultiValueAnswer, true);
});

test("Route 53 record rows round-trip through the editor", () => {
  const rec = { Name: "g.example.com.", Type: "A", SetIdentifier: "eu", GeoLocation: { ContinentCode: "EU" }, TTL: 60, ResourceRecords: [{ Value: "192.0.2.5" }] };
  const row = recordRow(rec);
  assert.equal(row.routing, "Geolocation");
  assert.equal(row.differentiator, "Europe");
  assert.equal(row.key, "g.example.com.|A|eu");
  assert.equal(row.alias, "No");
  const back = buildRecordSet(recordToInput(rec, ZONE), ZONE);
  assert.deepEqual(back, { ok: true, record: rec });
  assert.equal(recordRow({ Name: "x.example.com.", Type: "A", Weight: 0, SetIdentifier: "z", TTL: 1, ResourceRecords: [] }).differentiator, "0");
  assert.equal(recordRow({ Name: "a.example.com.", Type: "A", AliasTarget: { HostedZoneId: "Z", DNSName: "t.", EvaluateTargetHealth: true } }).value, "t.");
  assert.equal(recordKey({ Name: "WWW.Example.com", Type: "A" }), "www.example.com.|A|");
  assert.equal(isZoneDefault({ Name: "example.com.", Type: "NS" }, ZONE), true);
  assert.equal(isZoneDefault({ Name: "sub.example.com.", Type: "NS" }, ZONE), false);
});

test("Route 53 health status follows the 18% rule", () => {
  const obs = (statuses) => statuses.map((s) => ({ StatusReport: { Status: s } }));
  assert.equal(healthStatus(undefined), "Unknown");
  assert.equal(healthStatus(obs(["Success: HTTP 200", "Failure: timeout"])), "Healthy");
  assert.equal(healthStatus(obs(["Failure: a", "Failure: b", "Failure: c", "Failure: d", "Failure: e", "Success: ok"])), "Unhealthy");
});
