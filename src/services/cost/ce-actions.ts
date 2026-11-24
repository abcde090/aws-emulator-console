"use server";

/**
 * Server action for the Cost Explorer report builder. It validates the query, calls
 * GetCostAndUsage through the permission-checked client, and returns the emulator's
 * rows or its error text unchanged.
 */

import { GetCostAndUsageCommand, type Expression, type GroupDefinition, type Dimension, type Granularity } from "@aws-sdk/client-cost-explorer";
import { clients } from "../../lib/aws.ts";
import { errorMessage } from "../../console/serialize.ts";
import type { Result } from "../../console/types.ts";
import { checkDateRange, flattenCostResults, splitList, type CostRow } from "./helpers.ts";
import { COST_METRICS, FILTER_DIMENSIONS, GROUP_BY } from "./ce-options.ts";

export interface CostQuery {
  start: string;
  end: string;
  granularity: string;
  metric: string;
  groupBy: string;
  tagKey: string;
  filterDimension: string;
  filterValues: string;
}

export interface CostReport {
  rows: CostRow[];
  request: unknown;
}

function buildRequest(q: CostQuery) {
  const rangeError = checkDateRange(q.start, q.end);
  if (rangeError) throw new Error(rangeError);
  if (!["DAILY", "MONTHLY", "HOURLY"].includes(q.granularity)) throw new Error("Choose a granularity.");
  if (!COST_METRICS.some((m) => m.value === q.metric)) throw new Error("Choose a metric.");
  let groupBy: GroupDefinition[] | undefined;
  if (q.groupBy === "TAG") {
    const key = typeof q.tagKey === "string" ? q.tagKey.trim() : "";
    if (!/^[\w\s.:+=@/-]{1,128}$/.test(key)) throw new Error("Enter a tag key to group by.");
    groupBy = [{ Type: "TAG", Key: key }];
  } else if (q.groupBy !== "") {
    if (!GROUP_BY.some((g) => g.value === q.groupBy)) throw new Error("Choose a valid grouping.");
    groupBy = [{ Type: "DIMENSION", Key: q.groupBy }];
  }
  let filter: Expression | undefined;
  if (q.filterDimension !== "") {
    if (!FILTER_DIMENSIONS.some((d) => d.value === q.filterDimension)) throw new Error("Choose a valid filter dimension.");
    const values = splitList(q.filterValues);
    if (values.length === 0) throw new Error("Enter at least one filter value, or remove the filter.");
    filter = { Dimensions: { Key: q.filterDimension as Dimension, Values: values } };
  }
  return { TimePeriod: { Start: q.start, End: q.end }, Granularity: q.granularity as Granularity, Metrics: [q.metric], GroupBy: groupBy, Filter: filter };
}

export async function runCostQuery(raw: CostQuery): Promise<Result<CostReport>> {
  try {
    if (raw === null || typeof raw !== "object") throw new Error("Query is missing.");
    const q: CostQuery = {
      start: String(raw.start ?? ""),
      end: String(raw.end ?? ""),
      granularity: String(raw.granularity ?? ""),
      metric: String(raw.metric ?? ""),
      groupBy: String(raw.groupBy ?? ""),
      tagKey: String(raw.tagKey ?? ""),
      filterDimension: String(raw.filterDimension ?? ""),
      filterValues: String(raw.filterValues ?? ""),
    };
    const request = buildRequest(q);
    const r = await clients.costexplorer.send(new GetCostAndUsageCommand(request));
    return { ok: true, data: { rows: flattenCostResults(r.ResultsByTime ?? [], q.metric), request } };
  } catch (err: unknown) {
    return { ok: false, error: errorMessage(err) };
  }
}
