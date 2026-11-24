/**
 * Route 53 record helpers (pure, no SDK calls): turn ResourceRecordSets into table rows,
 * build a ResourceRecordSet from the record editor's input, and summarise health checker
 * observations. Shared by the definition, the server actions and the unit tests.
 */

import type { HealthCheckObservation, ResourceRecordSet, RRType } from "@aws-sdk/client-route-53";

export const RECORD_TYPES: RRType[] = ["A", "AAAA", "CAA", "CNAME", "DS", "HTTPS", "MX", "NAPTR", "NS", "PTR", "SOA", "SPF", "SRV", "SSHFP", "SVCB", "TLSA", "TXT"];

export const ALIAS_TYPES: RRType[] = ["A", "AAAA", "CNAME", "HTTPS", "SVCB", "TXT", "MX", "NAPTR", "PTR", "SPF", "SRV", "CAA", "DS", "SSHFP", "TLSA"];

export type RoutingPolicy = "simple" | "weighted" | "latency" | "failover" | "geolocation" | "multivalue";

export const ROUTING_POLICIES: { value: RoutingPolicy; label: string }[] = [
  { value: "simple", label: "Simple routing" },
  { value: "weighted", label: "Weighted" },
  { value: "geolocation", label: "Geolocation" },
  { value: "latency", label: "Latency" },
  { value: "failover", label: "Failover" },
  { value: "multivalue", label: "Multivalue answer" },
];

export const CONTINENTS: { value: string; label: string }[] = [
  { value: "AF", label: "Africa" },
  { value: "AN", label: "Antarctica" },
  { value: "AS", label: "Asia" },
  { value: "EU", label: "Europe" },
  { value: "NA", label: "North America" },
  { value: "OC", label: "Oceania" },
  { value: "SA", label: "South America" },
];

export const LATENCY_REGIONS = [
  "us-east-1", "us-east-2", "us-west-1", "us-west-2", "ca-central-1", "sa-east-1", "eu-west-1", "eu-west-2", "eu-west-3",
  "eu-central-1", "eu-north-1", "eu-south-1", "ap-south-1", "ap-northeast-1", "ap-northeast-2", "ap-northeast-3",
  "ap-southeast-1", "ap-southeast-2", "ap-east-1", "me-south-1", "af-south-1",
];

/** The editor's form state. Every field is a plain value so it can cross to a server action. */
export interface RecordInput {
  /** Subdomain part ("www"), empty for the zone apex, or a full name inside the zone. */
  name: string;
  type: string;
  alias: boolean;
  /** One value per line. */
  values: string;
  ttl: string;
  routing: RoutingPolicy;
  setIdentifier: string;
  weight: string;
  region: string;
  failover: string;
  geoContinent: string;
  geoCountry: string;
  geoSubdivision: string;
  healthCheckId: string;
  aliasZoneId: string;
  aliasDnsName: string;
  evaluateTargetHealth: boolean;
}

export const EMPTY_RECORD_INPUT: RecordInput = {
  name: "",
  type: "A",
  alias: false,
  values: "",
  ttl: "300",
  routing: "simple",
  setIdentifier: "",
  weight: "",
  region: "us-east-1",
  failover: "PRIMARY",
  geoContinent: "",
  geoCountry: "",
  geoSubdivision: "",
  healthCheckId: "",
  aliasZoneId: "",
  aliasDnsName: "",
  evaluateTargetHealth: true,
};

export function withDot(name: string): string {
  return name.endsWith(".") ? name : `${name}.`;
}

/** Route 53 escapes "*" and some characters as \052 etc. in names it returns. */
export function decodeDnsName(name: string): string {
  return name.replace(/\\(\d{3})/g, (_, code: string) => String.fromCharCode(parseInt(code, 8)));
}

/** "www" + "example.com." -> "www.example.com."; "" -> the apex; a full name in the zone is kept. */
export function fullName(sub: string, zoneName: string): string {
  const zone = withDot(zoneName.toLowerCase());
  const s = sub.trim().replace(/\.$/, "").toLowerCase();
  if (s === "") return zone;
  if (`${s}.` === zone || `${s}.`.endsWith(`.${zone}`)) return `${s}.`;
  return `${s}.${zone}`;
}

/** The subdomain part of a record name, for the editor ("" for the apex). */
export function subdomain(name: string, zoneName: string): string {
  const n = withDot(decodeDnsName(name)).toLowerCase();
  const zone = withDot(zoneName).toLowerCase();
  if (n === zone) return "";
  return n.endsWith(`.${zone}`) ? n.slice(0, -(zone.length + 1)) : n.replace(/\.$/, "");
}

/** A record set is identified by name, type and (for non-simple routing) its record ID. */
export function recordKey(r: Pick<ResourceRecordSet, "Name" | "Type" | "SetIdentifier">): string {
  return `${withDot(decodeDnsName(r.Name ?? "")).toLowerCase()}|${r.Type ?? ""}|${r.SetIdentifier ?? ""}`;
}

export function routingPolicy(r: ResourceRecordSet): string {
  if (r.Weight !== undefined) return "Weighted";
  if (r.Region) return "Latency";
  if (r.Failover) return "Failover";
  if (r.GeoLocation) return "Geolocation";
  if (r.GeoProximityLocation) return "Geoproximity";
  if (r.CidrRoutingConfig) return "IP-based";
  if (r.MultiValueAnswer !== undefined) return "Multivalue answer";
  return "Simple";
}

function geoText(g: NonNullable<ResourceRecordSet["GeoLocation"]>): string {
  if (g.CountryCode === "*") return "Default";
  if (g.ContinentCode) return CONTINENTS.find((c) => c.value === g.ContinentCode)?.label ?? g.ContinentCode;
  return [g.CountryCode, g.SubdivisionCode].filter(Boolean).join("-");
}

/** What the console shows in the "Differentiator" column. */
export function differentiator(r: ResourceRecordSet): string | null {
  if (r.Weight !== undefined) return String(r.Weight);
  if (r.Region) return r.Region;
  if (r.Failover) return r.Failover === "PRIMARY" ? "Primary" : "Secondary";
  if (r.GeoLocation) return geoText(r.GeoLocation);
  return null;
}

export interface RecordRow extends Record<string, unknown> {
  key: string;
  name: string;
  type: string;
  routing: string;
  differentiator: string | null;
  alias: string;
  value: string;
  ttl: number | null;
  healthCheckId: string | null;
  setIdentifier: string | null;
}

export function recordRow(r: ResourceRecordSet): RecordRow {
  const value = r.AliasTarget
    ? r.AliasTarget.DNSName ?? ""
    : (r.ResourceRecords ?? []).map((v) => v.Value ?? "").join("\n");
  return {
    key: recordKey(r),
    name: withDot(decodeDnsName(r.Name ?? "")),
    type: r.Type ?? "",
    routing: routingPolicy(r),
    differentiator: differentiator(r),
    alias: r.AliasTarget ? "Yes" : "No",
    value,
    ttl: r.TTL ?? null,
    healthCheckId: r.HealthCheckId ?? null,
    setIdentifier: r.SetIdentifier ?? null,
  };
}

/** The apex NS and SOA records Route 53 creates with the zone; the console doesn't let you delete them. */
export function isZoneDefault(r: Pick<ResourceRecordSet, "Name" | "Type">, zoneName: string): boolean {
  return (r.Type === "NS" || r.Type === "SOA") && withDot(decodeDnsName(r.Name ?? "")).toLowerCase() === withDot(zoneName).toLowerCase();
}

function routingFrom(r: ResourceRecordSet): RoutingPolicy {
  if (r.Weight !== undefined) return "weighted";
  if (r.Region) return "latency";
  if (r.Failover) return "failover";
  if (r.GeoLocation) return "geolocation";
  if (r.MultiValueAnswer !== undefined) return "multivalue";
  return "simple";
}

/** Fills the editor from an existing record set. */
export function recordToInput(r: ResourceRecordSet, zoneName: string): RecordInput {
  const geo = r.GeoLocation;
  return {
    ...EMPTY_RECORD_INPUT,
    name: subdomain(r.Name ?? "", zoneName),
    type: r.Type ?? "A",
    alias: r.AliasTarget !== undefined,
    values: (r.ResourceRecords ?? []).map((v) => v.Value ?? "").join("\n"),
    ttl: r.TTL === undefined ? "" : String(r.TTL),
    routing: routingFrom(r),
    setIdentifier: r.SetIdentifier ?? "",
    weight: r.Weight === undefined ? "" : String(r.Weight),
    region: r.Region ?? "us-east-1",
    failover: r.Failover ?? "PRIMARY",
    geoContinent: geo?.CountryCode === "*" ? "*" : geo?.ContinentCode ?? "",
    geoCountry: geo?.CountryCode && geo.CountryCode !== "*" ? geo.CountryCode : "",
    geoSubdivision: geo?.SubdivisionCode ?? "",
    healthCheckId: r.HealthCheckId ?? "",
    aliasZoneId: r.AliasTarget?.HostedZoneId ?? "",
    aliasDnsName: r.AliasTarget?.DNSName ?? "",
    evaluateTargetHealth: r.AliasTarget?.EvaluateTargetHealth ?? true,
  };
}

export type Built = { ok: true; record: ResourceRecordSet } | { ok: false; error: string };

const fail = (error: string): Built => ({ ok: false, error });

function intIn(text: string, min: number, max: number): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= min && n <= max ? n : null;
}

/** Validates the editor input and builds the ResourceRecordSet to send to ChangeResourceRecordSets. */
export function buildRecordSet(input: RecordInput, zoneName: string): Built {
  const name = fullName(input.name, zoneName);
  if (!/^[a-z0-9_*.-]+$/i.test(name) || name.length > 255) return fail("Record name: use letters, numbers, hyphens, underscores, dots or a leading *.");
  const zone = withDot(zoneName).toLowerCase();
  if (name !== zone && !name.endsWith(`.${zone}`)) return fail(`Record name must be inside ${zone}`);
  if (!RECORD_TYPES.includes(input.type as RRType)) return fail(`Record type ${input.type} is not supported.`);
  const type = input.type as RRType;
  const record: ResourceRecordSet = { Name: name, Type: type };

  if (input.alias) {
    if (!ALIAS_TYPES.includes(type)) return fail(`An alias record can't have type ${type}.`);
    const zoneId = input.aliasZoneId.trim();
    const dns = input.aliasDnsName.trim();
    if (!zoneId) return fail("Choose the hosted zone ID of the alias target.");
    if (!dns) return fail("Enter the DNS name of the alias target.");
    record.AliasTarget = { HostedZoneId: zoneId, DNSName: dns, EvaluateTargetHealth: input.evaluateTargetHealth };
  } else {
    const values = input.values.split("\n").map((v) => v.trim()).filter((v) => v !== "");
    if (values.length === 0) return fail("Enter at least one value.");
    if (type === "CNAME" && values.length > 1) return fail("A CNAME record can have only one value.");
    const ttl = intIn(input.ttl, 0, 2147483647);
    if (ttl === null) return fail("TTL must be a whole number of seconds (0 to 2147483647).");
    record.TTL = ttl;
    record.ResourceRecords = values.map((Value) => ({ Value }));
  }

  if (input.routing !== "simple") {
    const id = input.setIdentifier.trim();
    if (!id || id.length > 128) return fail("Record ID is required for this routing policy (1-128 characters).");
    record.SetIdentifier = id;
  }
  switch (input.routing) {
    case "simple":
      break;
    case "weighted": {
      const w = intIn(input.weight, 0, 255);
      if (w === null) return fail("Weight must be a whole number from 0 to 255.");
      record.Weight = w;
      break;
    }
    case "latency":
      if (!LATENCY_REGIONS.includes(input.region)) return fail("Choose a Region for the latency record.");
      record.Region = input.region as ResourceRecordSet["Region"];
      break;
    case "failover":
      if (input.failover !== "PRIMARY" && input.failover !== "SECONDARY") return fail("Failover record type must be Primary or Secondary.");
      record.Failover = input.failover;
      break;
    case "geolocation": {
      const country = input.geoCountry.trim().toUpperCase();
      const sub = input.geoSubdivision.trim().toUpperCase();
      if (input.geoContinent === "*") record.GeoLocation = { CountryCode: "*" };
      else if (country) {
        if (!/^[A-Z]{2}$/.test(country)) return fail("Country must be a two-letter country code, such as US.");
        record.GeoLocation = sub ? { CountryCode: country, SubdivisionCode: sub } : { CountryCode: country };
      } else if (CONTINENTS.some((c) => c.value === input.geoContinent)) record.GeoLocation = { ContinentCode: input.geoContinent };
      else return fail("Choose a location: Default, a continent, or a country code.");
      break;
    }
    case "multivalue":
      if (input.alias) return fail("Multivalue answer records can't be alias records.");
      record.MultiValueAnswer = true;
      break;
    default:
      return fail("Unknown routing policy.");
  }
  const hc = input.healthCheckId.trim();
  if (hc) record.HealthCheckId = hc;
  return { ok: true, record };
}

/** Route 53 counts a health check healthy when more than 18% of its checkers report success. */
export function healthStatus(observations: HealthCheckObservation[] | undefined): "Healthy" | "Unhealthy" | "Unknown" {
  const all = observations ?? [];
  if (all.length === 0) return "Unknown";
  const ok = all.filter((o) => (o.StatusReport?.Status ?? "").startsWith("Success")).length;
  return ok / all.length > 0.18 ? "Healthy" : "Unhealthy";
}
