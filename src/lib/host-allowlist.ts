/**
 * True only for loopback Host headers. A DNS-rebinding page arrives with its own
 * hostname in Host, so rejecting everything else keeps other websites out.
 */

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isLocalHostHeader(host: string | null | undefined): boolean {
  if (!host) return false;
  const lower = host.trim().toLowerCase();
  const hostname = lower.startsWith("[") ? lower.slice(0, lower.indexOf("]") + 1) : lower.split(":")[0];
  return LOCAL_HOSTNAMES.has(hostname);
}
