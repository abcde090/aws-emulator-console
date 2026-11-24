/**
 * Pure helpers for the DynamoDB Contributor Insights graphs: which managed rule is which
 * graph, and a rule report's contributors as chart series.
 */

export type InsightsGraphKind = "PKC" | "SKC" | "PKT" | "SKT";

export const GRAPH_TITLES: Record<InsightsGraphKind, string> = {
  PKC: "Most accessed items (partition key)",
  SKC: "Most accessed items (partition and sort keys)",
  PKT: "Most throttled items (partition key)",
  SKT: "Most throttled items (partition and sort keys)",
};

const ORDER: InsightsGraphKind[] = ["PKC", "SKC", "PKT", "SKT"];

/**
 * "DynamoDBContributorInsights-PKC-<table>-<timestamp>" -> { kind: "PKC", title, index }.
 * Rules for a global secondary index name the index after the table ("<table>/index/<gsi>").
 */
export function insightsRuleKind(rule: string): { kind: InsightsGraphKind; title: string; index: string | null } | null {
  const m = /^DynamoDBContributorInsights-(PKC|SKC|PKT|SKT)-(.+)-\d+$/.exec(rule);
  if (!m) return null;
  const kind = m[1] as InsightsGraphKind;
  const target = m[2];
  const i = target.indexOf("/index/");
  return { kind, title: GRAPH_TITLES[kind], index: i >= 0 ? target.slice(i + "/index/".length) : null };
}

/** Rules in the console's order: accessed before throttled, partition key before both keys. */
export function sortInsightsRules(rules: string[]): string[] {
  const rank = (r: string) => {
    const k = insightsRuleKind(r);
    return k ? ORDER.indexOf(k.kind) : ORDER.length;
  };
  return [...rules].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

export interface ContributorLike {
  keys: string[];
  value: number | null;
  points: { t: number; v: number }[];
}

/** One chart series per contributor, labelled with its key values ("user#1 | 2024-01-01"). */
export function contributorSeries(contributors: ContributorLike[]): { id: string; label: string; points: { t: number; v: number }[] }[] {
  return contributors.map((c, i) => ({ id: `c${i}`, label: c.keys.join(" | ") || "(no key)", points: c.points }));
}
