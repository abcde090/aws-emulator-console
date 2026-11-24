/**
 * Refuses any request whose Host is not this machine. Binding to 127.0.0.1 keeps out the
 * network, and this keeps out web pages that use DNS rebinding to reach the dashboard.
 */

import { NextResponse, type NextRequest } from "next/server";
import { isLocalHostHeader } from "@/lib/host-allowlist";

export function proxy(request: NextRequest) {
  if (!isLocalHostHeader(request.headers.get("host"))) {
    return new NextResponse("Forbidden: open this dashboard at http://127.0.0.1:3001", { status: 403 });
  }
  return NextResponse.next();
}
