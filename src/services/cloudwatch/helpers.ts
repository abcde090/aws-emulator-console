/**
 * Pure helpers for the CloudWatch screens: dimension parsing, dashboard widget parsing,
 * time ranges and chart geometry. No AWS calls here, so they are unit tested.
 */

export interface Dimension {
  Name: string;
  Value: string;
}

export interface MetricId {
  namespace: string;
  metricName: string;
  dimensions: Dimension[];
}

/** One query for GetMetricData: either a metric with a statistic, or a math expression. */
export interface ChartQuery {
  id: string;
  label?: string;
  metric?: MetricId;
  stat?: string;
  period?: number;
  expression?: string;
  visible?: boolean;
}

export interface Series {
  id: string;
  label: string;
  points: { t: number; v: number }[];
  status?: string;
  message?: string;
}

export const STATISTICS = ["Average", "Sum", "Minimum", "Maximum", "SampleCount", "p50", "p90", "p99"] as const;
export const PERIODS = [
  { value: 60, label: "1 minute" },
  { value: 300, label: "5 minutes" },
  { value: 900, label: "15 minutes" },
  { value: 3600, label: "1 hour" },
  { value: 21600, label: "6 hours" },
  { value: 86400, label: "1 day" },
] as const;
export const RANGES = [
  { key: "1h", label: "1h", seconds: 3600 },
  { key: "3h", label: "3h", seconds: 3 * 3600 },
  { key: "12h", label: "12h", seconds: 12 * 3600 },
  { key: "1d", label: "1d", seconds: 86400 },
  { key: "3d", label: "3d", seconds: 3 * 86400 },
  { key: "1w", label: "1w", seconds: 7 * 86400 },
] as const;

/** Categorical series colours, in fixed order (validated light palette). */
export const SERIES_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"] as const;

export const QUERY_ID = /^[a-z][a-zA-Z0-9_]{0,254}$/;
const DIM_PART = /^([^=]{1,255})=(.{1,1024})$/;

/** "Host=a, Stage=prod" or one per line -> dimensions. Throws with a readable message. */
export function parseDimensions(text: string): Dimension[] {
  const parts = text
    .split(/[\n,]/)
    .map((p) => p.trim())
    .filter((p) => p !== "");
  if (parts.length > 30) throw new Error("A metric has at most 30 dimensions.");
  return parts.map((p) => {
    const m = DIM_PART.exec(p);
    if (!m) throw new Error(`"${p}" is not Name=Value.`);
    return { Name: m[1].trim(), Value: m[2].trim() };
  });
}

export function dimensionsLabel(dims: readonly Dimension[]): string {
  return dims.length === 0 ? "(no dimensions)" : dims.map((d) => `${d.Name}=${d.Value}`).join(", ");
}

/** The names of a metric's dimensions, sorted: the console groups metrics by this set. */
export function dimensionSetKey(dims: readonly Dimension[]): string {
  return dims.length === 0 ? "Metrics with no dimensions" : [...dims.map((d) => d.Name)].sort().join(", ");
}

export function metricKey(m: MetricId): string {
  return JSON.stringify([m.namespace, m.metricName, [...m.dimensions].sort((a, b) => a.Name.localeCompare(b.Name)).map((d) => [d.Name, d.Value])]);
}

/** Retention in days -> the words the Logs console uses. */
export function retentionLabel(days: number | null | undefined): string {
  if (!days) return "Never expire";
  if (days % 365 === 0 && days >= 365) return `${days / 365} year${days === 365 ? "" : "s"}`;
  if (days % 30 === 0 && days >= 30 && days < 365) return `${days / 30} month${days === 30 ? "" : "s"}`;
  return `${days} day${days === 1 ? "" : "s"}`;
}

export const RETENTION_DAYS = [1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653] as const;

// ---- Dashboard bodies ----

export interface DashboardWidget {
  type: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Metric widgets: the GetMetricData queries. */
  queries: ChartQuery[];
  period: number;
  stat: string;
  view: string;
  markdown?: string;
  /** Widgets the console can't draw here (logs, alarm status …) keep their raw properties. */
  properties: Record<string, unknown>;
}

function obj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/**
 * Turns a widget's "metrics" array into queries. Each row is
 * [Namespace, MetricName, DimName, DimValue, ..., {options}] where "." repeats the value in
 * the same position of the previous row and "..." repeats everything before it.
 * A row may also be [{ "expression": "...", "id": "e1" }].
 */
export function widgetQueries(metrics: unknown, defaults: { stat: string; period: number }): ChartQuery[] {
  if (!Array.isArray(metrics)) return [];
  const out: ChartQuery[] = [];
  let previous: string[] = [];
  metrics.forEach((raw, index) => {
    if (!Array.isArray(raw)) return;
    const options = raw.length > 0 && typeof raw[raw.length - 1] === "object" && raw[raw.length - 1] !== null ? obj(raw[raw.length - 1]) : {};
    const values = raw.filter((v): v is string => typeof v === "string");
    const id = typeof options.id === "string" && QUERY_ID.test(options.id) ? options.id : `w${index}`;
    const label = typeof options.label === "string" ? options.label : undefined;
    const visible = options.visible !== false;
    if (typeof options.expression === "string") {
      out.push({ id, label, expression: options.expression, visible });
      return;
    }
    let row: string[] = [];
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v === "...") row = [...previous.slice(0, Math.max(previous.length - (values.length - 1 - i), 0))];
      else if (v === ".") row.push(previous[row.length] ?? "");
      else row.push(v);
    }
    previous = row;
    if (row.length < 2) return;
    const dims: Dimension[] = [];
    for (let i = 2; i + 1 < row.length; i += 2) dims.push({ Name: row[i], Value: row[i + 1] });
    out.push({
      id,
      label,
      metric: { namespace: row[0], metricName: row[1], dimensions: dims },
      stat: typeof options.stat === "string" ? options.stat : defaults.stat,
      period: numOr(options.period, defaults.period),
      visible,
    });
  });
  return out;
}

/** Parses a dashboard body. Throws if it is not JSON with a widgets array. */
export function parseDashboard(body: string): DashboardWidget[] {
  const parsed: unknown = JSON.parse(body);
  const widgets = obj(parsed).widgets;
  if (!Array.isArray(widgets)) throw new Error("The dashboard body has no widgets array.");
  return widgets.map((w) => {
    const widget = obj(w);
    const props = obj(widget.properties);
    const stat = typeof props.stat === "string" ? props.stat : "Average";
    const period = numOr(props.period, 300);
    return {
      type: typeof widget.type === "string" ? widget.type : "unknown",
      title: typeof props.title === "string" ? props.title : "",
      x: numOr(widget.x, 0),
      y: numOr(widget.y, 0),
      width: numOr(widget.width, 6),
      height: numOr(widget.height, 6),
      queries: widget.type === "metric" ? widgetQueries(props.metrics, { stat, period }) : [],
      period,
      stat,
      view: typeof props.view === "string" ? props.view : "timeSeries",
      markdown: typeof props.markdown === "string" ? props.markdown : undefined,
      properties: props,
    };
  });
}

/** A starter body for a new dashboard: one line graph of the given metric. */
export function metricWidgetBody(m: MetricId, stat: string, period: number, region: string, title: string): string {
  const row: (string | Record<string, unknown>)[] = [m.namespace, m.metricName, ...m.dimensions.flatMap((d) => [d.Name, d.Value])];
  return JSON.stringify(
    { widgets: [{ type: "metric", x: 0, y: 0, width: 12, height: 6, properties: { metrics: [row], view: "timeSeries", stat, period, region, title } }] },
    null,
    2
  );
}

// ---- Chart geometry ----

export interface ChartGeometry {
  minT: number;
  maxT: number;
  minV: number;
  maxV: number;
  lines: { id: string; color: string; path: string; points: { x: number; y: number; t: number; v: number }[] }[];
  yTicks: { y: number; value: number }[];
  xTicks: { x: number; t: number }[];
}

export interface ChartBox {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function niceStep(span: number, count: number): number {
  const raw = span / Math.max(count, 1);
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

/** Scales series into an SVG box. Time range comes from the request, values start at 0 when all are positive. */
export function chartGeometry(series: Series[], box: ChartBox, range: { start: number; end: number }): ChartGeometry {
  const all = series.flatMap((s) => s.points);
  let minV = all.length ? Math.min(...all.map((p) => p.v)) : 0;
  let maxV = all.length ? Math.max(...all.map((p) => p.v)) : 1;
  if (minV > 0) minV = 0;
  if (maxV === minV) maxV = minV + 1;
  const step = niceStep(maxV - minV, 4);
  minV = Math.floor(minV / step) * step;
  maxV = Math.ceil(maxV / step) * step;
  const minT = range.start;
  const maxT = range.end > range.start ? range.end : range.start + 1;
  const plotW = box.width - box.left - box.right;
  const plotH = box.height - box.top - box.bottom;
  const x = (t: number) => box.left + ((t - minT) / (maxT - minT)) * plotW;
  const y = (v: number) => box.top + plotH - ((v - minV) / (maxV - minV)) * plotH;
  const lines = series.map((s, i) => {
    const points = [...s.points].sort((a, b) => a.t - b.t).map((p) => ({ x: x(p.t), y: y(p.v), t: p.t, v: p.v }));
    const path = points.map((p, j) => `${j === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
    return { id: s.id, color: SERIES_COLORS[i % SERIES_COLORS.length], path, points };
  });
  const yTicks: { y: number; value: number }[] = [];
  for (let v = minV; v <= maxV + step / 2; v += step) yTicks.push({ y: y(v), value: Number(v.toPrecision(12)) });
  const xTicks: { x: number; t: number }[] = [];
  const tickCount = 6;
  for (let i = 0; i <= tickCount; i++) {
    const t = minT + ((maxT - minT) * i) / tickCount;
    xTicks.push({ x: x(t), t });
  }
  return { minT, maxT, minV, maxV, lines, yTicks, xTicks };
}

/** Compact number for axis labels: 1200 -> "1.2k". */
export function shortNumber(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(1).replace(/\.0$/, "")}G`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1).replace(/\.0$/, "")}k`;
  if (a === 0 || a >= 1) return String(Number(v.toFixed(2)));
  return v.toPrecision(2);
}

/** Picks a period that keeps a range under the GetMetricData-friendly 1,440 points. */
export function autoPeriod(rangeSeconds: number): number {
  for (const p of [60, 300, 900, 3600, 21600, 86400]) if (rangeSeconds / p <= 1440) return p;
  return 86400;
}

/** Name of a SNS topic from its ARN. */
export function arnTail(arn: string): string {
  const parts = arn.split(":");
  return parts[parts.length - 1] ?? arn;
}

// ---- Log and alarm widgets ----

/**
 * A dashboard log widget's query: "SOURCE 'group-a' | SOURCE 'group-b' | fields … | limit 20".
 * The SOURCE clauses name the log groups; the rest is the Logs Insights query.
 */
export function logWidgetQuery(properties: Record<string, unknown>): { groups: string[]; query: string } {
  const raw = typeof properties.query === "string" ? properties.query : "";
  const parts = raw.split("|");
  const groups: string[] = [];
  let i = 0;
  for (; i < parts.length; i++) {
    const m = /^\s*SOURCE\s+(?:'([^']+)'|"([^"]+)"|(\S+))\s*$/i.exec(parts[i]);
    if (!m) break;
    groups.push(m[1] ?? m[2] ?? m[3]);
  }
  const extra = Array.isArray(properties.logGroupNames) ? properties.logGroupNames.filter((g): g is string => typeof g === "string") : [];
  return { groups: [...new Set([...groups, ...extra])], query: parts.slice(i).join("|").trim() };
}

/** Alarm names from an alarm widget's "alarms" list (alarm ARNs; a bare name is kept as is). */
export function alarmWidgetNames(properties: Record<string, unknown>): string[] {
  const alarms = Array.isArray(properties.alarms) ? properties.alarms : [];
  const names = alarms
    .filter((a): a is string => typeof a === "string" && a !== "")
    .map((a) => {
      const m = /^arn:aws[a-z-]*:cloudwatch:[^:]*:\d*:alarm:(.+)$/.exec(a);
      return m ? m[1] : a;
    });
  return [...new Set(names)];
}
