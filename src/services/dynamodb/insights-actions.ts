"use server";

/**
 * Server action for the table's Contributor Insights graphs: DescribeContributorInsights
 * for the table's managed rules, then GetInsightRuleReport for each (the same reader the
 * CloudWatch Contributor Insights page uses), through the permission-checked clients.
 */

import { DescribeContributorInsightsCommand } from "@aws-sdk/client-dynamodb";
import { makeCtx } from "../../console/server.ts";
import { errorMessage } from "../../console/serialize.ts";
import type { Result } from "../../console/types.ts";
import { insightRuleReport, type RuleReport } from "../cloudwatch/insights.ts";
import { insightsRuleKind, sortInsightsRules } from "./contributor-insights.ts";

const TABLE = /^[A-Za-z0-9_.-]{3,255}$/;
const MAX_RANGE = 7 * 86400;

export interface InsightsGraph {
  rule: string;
  title: string;
  index: string | null;
  report: RuleReport | null;
  error: string | null;
}

export interface TableInsights {
  status: string;
  mode: string | null;
  failure: string | null;
  start: number;
  end: number;
  graphs: InsightsGraph[];
}

function periodFor(rangeSeconds: number): number {
  if (rangeSeconds <= 3 * 3600) return 60;
  if (rangeSeconds <= 86400) return 300;
  return 3600;
}

export async function tableContributorInsights(table: string, rangeSeconds: number): Promise<Result<TableInsights>> {
  try {
    if (typeof table !== "string" || !TABLE.test(table)) throw new Error("That is not a valid table name.");
    if (typeof rangeSeconds !== "number" || rangeSeconds < 60 || rangeSeconds > MAX_RANGE) throw new Error("Choose a time range of up to a week.");
    const ctx = await makeCtx();
    const d = await ctx.clients.dynamodb.send(new DescribeContributorInsightsCommand({ TableName: table }));
    const end = new Date();
    const start = new Date(end.getTime() - rangeSeconds * 1000);
    const status = d.ContributorInsightsStatus ?? "DISABLED";
    const rules = status === "ENABLED" ? sortInsightsRules(d.ContributorInsightsRuleList ?? []) : [];
    const graphs = await Promise.all(
      rules.map(async (rule): Promise<InsightsGraph> => {
        const kind = insightsRuleKind(rule);
        try {
          return { rule, title: kind?.title ?? rule, index: kind?.index ?? null, report: await insightRuleReport(ctx, rule, start, end, periodFor(rangeSeconds)), error: null };
        } catch (err: unknown) {
          return { rule, title: kind?.title ?? rule, index: kind?.index ?? null, report: null, error: errorMessage(err) };
        }
      })
    );
    return {
      ok: true,
      data: { status, mode: d.ContributorInsightsMode ?? null, failure: d.FailureException ? `${d.FailureException.ExceptionName ?? ""}: ${d.FailureException.ExceptionDescription ?? ""}` : null, start: start.getTime(), end: end.getTime(), graphs },
    };
  } catch (err: unknown) {
    return { ok: false, error: errorMessage(err) };
  }
}
