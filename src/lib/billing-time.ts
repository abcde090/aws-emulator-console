/**
 * Hours a resource has existed this month, counted from when it was created or launched and
 * capped at the 1st of the month. With no timestamp it counts as just created (0 hours), so
 * the cost is never inflated by guessing.
 */
export function runningHoursThisMonth(since: Date | undefined, now: Date): number {
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const start = Math.max(monthStart, since ? new Date(since).getTime() : now.getTime());
  return Math.max(0, (now.getTime() - start) / 3_600_000);
}
