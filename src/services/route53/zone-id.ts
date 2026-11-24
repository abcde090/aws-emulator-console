/** Route 53 returns ids as "/hostedzone/Z123" and "/change/C123"; the console shows the bare id. */
export function bareZoneId(id: string): string {
  return id.replace(/^\/?(hostedzone|change|delegationset)\//, "");
}
