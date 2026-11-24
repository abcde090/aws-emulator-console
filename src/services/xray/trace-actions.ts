"use server";

/** Server action for the hand-built trace query (permission-checked X-Ray client). */

import { errorMessage } from "../../console/serialize.ts";
import { makeCtx } from "../../console/server.ts";
import type { Result, Row } from "../../console/types.ts";
import { traceSummaries } from "./def.ts";

const MAX_RANGE = 86400;

export async function queryTraces(filter: string, rangeSeconds: number): Promise<Result<Row[]>> {
  try {
    if (typeof filter !== "string" || filter.length > 2000) throw new Error("The filter expression is at most 2,000 characters.");
    if (typeof rangeSeconds !== "number" || rangeSeconds < 60 || rangeSeconds > MAX_RANGE) throw new Error("Choose a time range of up to 24 hours.");
    return { ok: true, data: await traceSummaries(await makeCtx(), rangeSeconds, filter.trim()) };
  } catch (err: unknown) {
    return { ok: false, error: errorMessage(err) };
  }
}
