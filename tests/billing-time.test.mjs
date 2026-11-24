import { test } from "node:test";
import assert from "node:assert/strict";
import { runningHoursThisMonth } from "../src/lib/billing-time.ts";

const now = new Date(2026, 10, 20, 12, 0, 0);

test("counts from the launch time, not the start of the month", () => {
  assert.equal(runningHoursThisMonth(new Date(2026, 10, 20, 9, 0, 0), now), 3);
});

test("a resource from an earlier month counts from the 1st", () => {
  assert.equal(runningHoursThisMonth(new Date(2026, 8, 1), now), 19 * 24 + 12);
});

test("no timestamp or a future one counts as zero hours", () => {
  assert.equal(runningHoursThisMonth(undefined, now), 0);
  assert.equal(runningHoursThisMonth(new Date(2026, 10, 21), now), 0);
});
