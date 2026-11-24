/**
 * The Region chosen in the top bar, read from its cookie on the server. The cookie value is
 * never trusted: parseRegionCookie() accepts only the console's Region codes.
 */

import { cache } from "react";
import { cookies } from "next/headers";
import { DEFAULT_REGION, parseRegionCookie, REGION_COOKIE } from "./regions.ts";

const loadSelectedRegion = cache(async (): Promise<string> => {
  let store: Awaited<ReturnType<typeof cookies>>;
  try {
    store = await cookies();
  } catch {
    // Outside a request (unit tests, build-time code): there is no chosen Region.
    return DEFAULT_REGION;
  }
  return parseRegionCookie(store.get(REGION_COOKIE)?.value);
});

/** The Region the current request works in. Read once per request. */
export async function selectedRegion(): Promise<string> {
  return loadSelectedRegion();
}
