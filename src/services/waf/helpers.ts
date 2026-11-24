/**
 * Pure helpers for AWS WAF: build rules from form values and describe rule statements the
 * way the console's rule tables do. No AWS calls here, so they are unit tested.
 */

import type { CountryCode, Rule, Statement } from "@aws-sdk/client-wafv2";

export type RuleAction = "Allow" | "Block" | "Count" | "CAPTCHA" | "Challenge";

export type RuleSpec =
  | { kind: "managed"; name: string; priority: number; vendor: string; group: string; overrideToCount: boolean }
  | { kind: "rate"; name: string; priority: number; action: RuleAction; limit: number; windowSec: number; aggregateKey: "IP" | "FORWARDED_IP" }
  | { kind: "ipset"; name: string; priority: number; action: RuleAction; arn: string }
  | { kind: "geo"; name: string; priority: number; action: RuleAction; countryCodes: string[] }
  | { kind: "regex"; name: string; priority: number; action: RuleAction; arn: string; field: "UriPath" | "QueryString" };

export const RULE_ACTIONS: RuleAction[] = ["Allow", "Block", "Count", "CAPTCHA", "Challenge"];

const RULE_NAME = /^[\w-]{1,128}$/;

/** CloudWatch metric names allow letters, numbers, hyphens and underscores only. */
export function metricName(name: string): string {
  const cleaned = name.replace(/[^\w-]/g, "_").slice(0, 128);
  return cleaned === "" ? "rule" : cleaned;
}

function actionBlock(action: RuleAction): NonNullable<Rule["Action"]> {
  switch (action) {
    case "Allow":
      return { Allow: {} };
    case "Block":
      return { Block: {} };
    case "Count":
      return { Count: {} };
    case "CAPTCHA":
      return { Captcha: {} };
    case "Challenge":
      return { Challenge: {} };
  }
}

function statementFor(spec: RuleSpec): Statement {
  switch (spec.kind) {
    case "managed":
      return { ManagedRuleGroupStatement: { VendorName: spec.vendor, Name: spec.group } };
    case "rate":
      return { RateBasedStatement: { Limit: spec.limit, EvaluationWindowSec: spec.windowSec, AggregateKeyType: spec.aggregateKey, ...(spec.aggregateKey === "FORWARDED_IP" ? { ForwardedIPConfig: { HeaderName: "X-Forwarded-For", FallbackBehavior: "MATCH" } } : {}) } };
    case "ipset":
      return { IPSetReferenceStatement: { ARN: spec.arn } };
    case "geo":
      return { GeoMatchStatement: { CountryCodes: spec.countryCodes as CountryCode[] } };
    case "regex":
      return {
        RegexPatternSetReferenceStatement: {
          ARN: spec.arn,
          FieldToMatch: spec.field === "UriPath" ? { UriPath: {} } : { QueryString: {} },
          TextTransformations: [{ Priority: 0, Type: "NONE" }],
        },
      };
  }
}

/** One WAF rule from a form. Managed rule groups take an override action, the rest a rule action. */
export function buildRule(spec: RuleSpec): Rule {
  if (!RULE_NAME.test(spec.name)) throw new Error("Rule names use 1-128 letters, numbers, hyphens or underscores.");
  const base: Rule = {
    Name: spec.name,
    Priority: spec.priority,
    Statement: statementFor(spec),
    VisibilityConfig: { SampledRequestsEnabled: true, CloudWatchMetricsEnabled: true, MetricName: metricName(spec.name) },
  };
  if (spec.kind === "managed") return { ...base, OverrideAction: spec.overrideToCount ? { Count: {} } : { None: {} } };
  return { ...base, Action: actionBlock(spec.action) };
}

/** The next free priority after the existing rules (WAF evaluates lowest first). */
export function nextPriority(rules: readonly Rule[]): number {
  return rules.reduce((max, r) => Math.max(max, (r.Priority ?? -1) + 1), 0);
}

/** "US, ca  gb" -> ["US", "CA", "GB"]; throws on anything that isn't a two-letter code. */
export function parseCountryCodes(text: string): string[] {
  const codes = text.split(/[\s,]+/).map((c) => c.trim().toUpperCase()).filter(Boolean);
  if (codes.length === 0) throw new Error("Enter at least one two-letter country code, for example US.");
  const bad = codes.find((c) => !/^[A-Z]{2}$/.test(c));
  if (bad) throw new Error(`"${bad}" is not a two-letter ISO 3166 country code.`);
  return [...new Set(codes)];
}

/** One address per line (or comma separated), each in CIDR notation. */
export function parseAddresses(text: string, version: "IPV4" | "IPV6"): string[] {
  const items = text.split(/[\s,]+/).map((a) => a.trim()).filter(Boolean);
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;
  const v6 = /^[0-9a-fA-F:]+\/\d{1,3}$/;
  for (const a of items) {
    if (version === "IPV4") {
      const m = v4.exec(a);
      if (!m || m.slice(1, 5).some((o) => Number(o) > 255) || Number(m[5]) > 32) throw new Error(`"${a}" is not an IPv4 address in CIDR notation, for example 192.0.2.0/24.`);
    } else if (!v6.test(a) || !a.includes(":") || Number(a.split("/")[1]) > 128) {
      throw new Error(`"${a}" is not an IPv6 address in CIDR notation, for example 2001:db8::/32.`);
    }
  }
  return [...new Set(items)];
}

/** Regular expressions, one per line. */
export function parseRegexList(text: string): string[] {
  const items = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (items.length === 0) throw new Error("Enter at least one regular expression.");
  for (const r of items) {
    if (r.length > 200) throw new Error(`"${r.slice(0, 40)}…" is longer than 200 characters.`);
  }
  return items;
}

/** The console's "Type" column for a rule. */
export function statementType(s: Statement | undefined): string {
  if (!s) return "-";
  if (s.ManagedRuleGroupStatement) return "Managed rule group";
  if (s.RuleGroupReferenceStatement) return "Rule group";
  if (s.RateBasedStatement) return "Rate-based rule";
  if (s.IPSetReferenceStatement) return "IP set";
  if (s.GeoMatchStatement) return "Geo match";
  if (s.RegexPatternSetReferenceStatement) return "Regex pattern set";
  if (s.ByteMatchStatement) return "String match";
  if (s.SqliMatchStatement) return "SQL injection";
  if (s.XssMatchStatement) return "Cross-site scripting";
  if (s.SizeConstraintStatement) return "Size constraint";
  if (s.LabelMatchStatement) return "Label match";
  if (s.AndStatement) return "AND";
  if (s.OrStatement) return "OR";
  if (s.NotStatement) return "NOT";
  return "Custom";
}

const arnName = (arn: string | undefined): string => (arn ? arn.split("/").slice(-2, -1)[0] ?? arn : "-");

/** A one-line summary of what the statement inspects. */
export function statementSummary(s: Statement | undefined): string {
  if (!s) return "-";
  if (s.ManagedRuleGroupStatement) return `${s.ManagedRuleGroupStatement.VendorName ?? "?"} / ${s.ManagedRuleGroupStatement.Name ?? "?"}${s.ManagedRuleGroupStatement.Version ? ` (${s.ManagedRuleGroupStatement.Version})` : ""}`;
  if (s.RuleGroupReferenceStatement) return arnName(s.RuleGroupReferenceStatement.ARN);
  if (s.RateBasedStatement) {
    const r = s.RateBasedStatement;
    return `${r.Limit ?? "?"} requests per ${r.EvaluationWindowSec ?? 300} seconds per ${r.AggregateKeyType ?? "IP"}`;
  }
  if (s.IPSetReferenceStatement) return `Source IP in ${arnName(s.IPSetReferenceStatement.ARN)}`;
  if (s.GeoMatchStatement) return `Country in ${(s.GeoMatchStatement.CountryCodes ?? []).join(", ")}`;
  if (s.RegexPatternSetReferenceStatement) {
    const field = Object.keys(s.RegexPatternSetReferenceStatement.FieldToMatch ?? {})[0] ?? "?";
    return `${field} matches ${arnName(s.RegexPatternSetReferenceStatement.ARN)}`;
  }
  return statementType(s);
}

/** The console's "Action" column: a rule action, or the override for a rule group. */
export function ruleActionLabel(rule: Rule): string {
  if (rule.OverrideAction) return rule.OverrideAction.Count ? "Override to count" : "Use rule actions";
  const a = rule.Action ?? {};
  if (a.Allow) return "Allow";
  if (a.Block) return "Block";
  if (a.Count) return "Count";
  if (a.Captcha) return "CAPTCHA";
  if (a.Challenge) return "Challenge";
  return "-";
}

export function ruleRows(rules: readonly Rule[] | undefined): Record<string, unknown>[] {
  return [...(rules ?? [])]
    .sort((a, b) => (a.Priority ?? 0) - (b.Priority ?? 0))
    .map((r) => ({ name: r.Name ?? "", priority: r.Priority ?? null, type: statementType(r.Statement), action: ruleActionLabel(r), statement: statementSummary(r.Statement) }));
}

/** "managed-rule-group" ids are vendor:name. */
export function splitManagedId(id: string): { vendor: string; name: string } {
  const i = id.indexOf(":");
  if (i <= 0 || i === id.length - 1) throw new Error(`"${id}" is not a managed rule group id (vendor:name).`);
  return { vendor: id.slice(0, i), name: id.slice(i + 1) };
}

