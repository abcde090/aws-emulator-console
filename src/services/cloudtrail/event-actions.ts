"use server";

/** Server action for the hand-built Event history screen. Uses the permission-checked CloudTrail client. */

import { makeCtx } from "../../console/server.ts";
import { errorMessage } from "../../console/serialize.ts";
import type { Result } from "../../console/types.ts";
import { checkFilter, lookup, type EventRow } from "./events.ts";

export interface EventPage {
  rows: EventRow[];
  nextToken: string | null;
}

export async function lookupEvents(filter: unknown, token?: string | null): Promise<Result<EventPage>> {
  try {
    const checked = checkFilter(filter);
    const t = typeof token === "string" && token.length > 0 && token.length < 4096 ? token : undefined;
    const r = await lookup(await makeCtx(), checked, t);
    return { ok: true, data: { rows: r.rows, nextToken: r.nextToken } };
  } catch (err: unknown) {
    return { ok: false, error: errorMessage(err) };
  }
}
