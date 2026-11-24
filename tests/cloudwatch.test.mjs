import { test } from "node:test";
import assert from "node:assert/strict";
import { alarmWidgetNames, autoPeriod, chartGeometry, logWidgetQuery, dimensionSetKey, metricKey, parseDashboard, parseDimensions, retentionLabel, shortNumber, widgetQueries } from "../src/services/cloudwatch/helpers.ts";
import { resultRows } from "../src/services/cloudwatch/query-results.ts";

test("CloudWatch dimensions parse and group", () => {
  assert.deepEqual(parseDimensions("Host=a, Stage = prod\nQ=x=y"), [{ Name: "Host", Value: "a" }, { Name: "Stage", Value: "prod" }, { Name: "Q", Value: "x=y" }]);
  assert.deepEqual(parseDimensions("  "), []);
  assert.throws(() => parseDimensions("nope"), /Name=Value/);
  assert.equal(dimensionSetKey([{ Name: "B", Value: "1" }, { Name: "A", Value: "2" }]), "A, B");
  assert.equal(dimensionSetKey([]), "Metrics with no dimensions");
  const a = metricKey({ namespace: "N", metricName: "M", dimensions: [{ Name: "B", Value: "1" }, { Name: "A", Value: "2" }] });
  const b = metricKey({ namespace: "N", metricName: "M", dimensions: [{ Name: "A", Value: "2" }, { Name: "B", Value: "1" }] });
  assert.equal(a, b);
});

test("CloudWatch dashboard widget metrics with . and ... shorthand", () => {
  const q = widgetQueries(
    [
      ["AWS/EC2", "CPUUtilization", "InstanceId", "i-1"],
      ["...", "i-2", { stat: "Maximum", id: "m2" }],
      [".", "NetworkIn", ".", "i-3"],
      [{ expression: "m2 * 2", id: "e1", label: "double" }],
    ],
    { stat: "Average", period: 300 }
  );
  assert.equal(q.length, 4);
  assert.deepEqual(q[0].metric, { namespace: "AWS/EC2", metricName: "CPUUtilization", dimensions: [{ Name: "InstanceId", Value: "i-1" }] });
  assert.deepEqual(q[1].metric?.dimensions, [{ Name: "InstanceId", Value: "i-2" }]);
  assert.equal(q[1].stat, "Maximum");
  assert.equal(q[1].id, "m2");
  assert.equal(q[2].metric?.metricName, "NetworkIn");
  assert.equal(q[2].metric?.namespace, "AWS/EC2");
  assert.deepEqual(q[3], { id: "e1", label: "double", expression: "m2 * 2", visible: true });
  const w = parseDashboard(JSON.stringify({ widgets: [{ type: "text", x: 0, y: 0, width: 6, height: 3, properties: { markdown: "# hi" } }] }));
  assert.equal(w[0].markdown, "# hi");
  assert.throws(() => parseDashboard("{}"), /widgets/);
});

test("CloudWatch chart geometry and labels", () => {
  const g = chartGeometry([{ id: "m1", label: "x", points: [{ t: 2000, v: 10 }, { t: 1000, v: 5 }] }], { width: 100, height: 100, left: 0, right: 0, top: 0, bottom: 0 }, { start: 1000, end: 2000 });
  assert.equal(g.minV, 0);
  assert.ok(g.maxV >= 10);
  assert.equal(g.lines[0].points[0].x, 0);
  assert.equal(g.lines[0].points[1].x, 100);
  assert.match(g.lines[0].path, /^M0\.0,/);
  assert.equal(shortNumber(1500), "1.5k");
  assert.equal(shortNumber(0), "0");
  assert.equal(autoPeriod(3600), 60);
  assert.equal(autoPeriod(7 * 86400), 900);
  assert.equal(retentionLabel(undefined), "Never expire");
  assert.equal(retentionLabel(30), "1 month");
  assert.equal(retentionLabel(731), "731 days");
  assert.equal(retentionLabel(3653), "3653 days");
  assert.equal(retentionLabel(365), "1 year");
});

test("Logs Insights results become table rows without @ptr", () => {
  const r = resultRows([[{ field: "@timestamp", value: "t1" }, { field: "@message", value: "m" }, { field: "@ptr", value: "p" }], [{ field: "count", value: "3" }]]);
  assert.deepEqual(r.columns, ["#", "@timestamp", "@message", "count"]);
  assert.deepEqual(r.rows[0], { "#": "1", "@timestamp": "t1", "@message": "m" });
  assert.equal(r.rows[1].count, "3");
});

test("dashboard log widgets: SOURCE clauses name the log groups, the rest is the query", () => {
  assert.deepEqual(logWidgetQuery({ query: "SOURCE '/aws/lambda/a' | SOURCE \"b\" | fields @timestamp, @message\n| sort @timestamp desc | limit 20" }), {
    groups: ["/aws/lambda/a", "b"],
    query: "fields @timestamp, @message\n| sort @timestamp desc | limit 20",
  });
  assert.deepEqual(logWidgetQuery({ query: "fields @message", logGroupNames: ["g"] }), { groups: ["g"], query: "fields @message" });
  assert.deepEqual(logWidgetQuery({}), { groups: [], query: "" });
});

test("dashboard alarm widgets: alarm ARNs become names", () => {
  assert.deepEqual(alarmWidgetNames({ alarms: ["arn:aws:cloudwatch:us-east-1:000000000000:alarm:High CPU", "plain", "plain", 3] }), ["High CPU", "plain"]);
  assert.deepEqual(alarmWidgetNames({}), []);
});
