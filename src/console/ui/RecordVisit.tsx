"use client";

import { useEffect } from "react";
import { recordRecent } from "../recent.ts";

/** Remembers a visited service in localStorage for Console Home's "Recently visited". */
export function RecordVisit({ serviceId, name }: { serviceId: string; name: string }) {
  useEffect(() => {
    recordRecent(serviceId, name);
  }, [serviceId, name]);
  return null;
}
