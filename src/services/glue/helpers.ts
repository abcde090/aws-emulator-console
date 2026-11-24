/** Pure AWS Glue helpers: schema text <-> columns, and table formats. */

import type { Option } from "../../console/types.ts";

export interface ColumnSpec {
  Name: string;
  Type: string;
  Comment?: string;
}

const COLUMN_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,254}$/;
const TYPE = /^[a-z][a-z0-9_]*([(<].*[)>])?$/i;

/**
 * Parses a schema written one column per line: "name type [comment]", e.g.
 *   id int
 *   name string customer name
 *   tags array<string>
 * Types can't contain spaces (write map<string,int>). Blank lines and lines starting with # are ignored.
 */
export function parseColumns(textValue: string | undefined, what = "Schema"): ColumnSpec[] {
  const out: ColumnSpec[] = [];
  const seen = new Set<string>();
  for (const [i, raw] of (textValue ?? "").split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = /^(\S+)\s+(\S+)(?:\s+(.*))?$/.exec(line);
    if (!m) throw new Error(`${what}, line ${i + 1}: write "column_name type", e.g. "id int".`);
    const [, name, type, comment] = m;
    if (!COLUMN_NAME.test(name)) throw new Error(`${what}, line ${i + 1}: "${name}" is not a valid column name.`);
    if (!TYPE.test(type)) throw new Error(`${what}, line ${i + 1}: "${type}" is not a valid data type.`);
    const key = name.toLowerCase();
    if (seen.has(key)) throw new Error(`${what}: column "${name}" appears twice.`);
    seen.add(key);
    out.push({ Name: name, Type: type.toLowerCase(), ...(comment ? { Comment: comment } : {}) });
  }
  return out;
}

export const FORMATS: Option[] = [
  { value: "csv", label: "CSV" },
  { value: "json", label: "JSON" },
  { value: "parquet", label: "Parquet" },
  { value: "orc", label: "ORC" },
  { value: "avro", label: "Avro" },
];

export interface StorageFormat {
  InputFormat: string;
  OutputFormat: string;
  SerdeInfo: { SerializationLibrary: string; Parameters?: Record<string, string> };
}

/** The Hive input/output formats and SerDe the Glue console sets for each data format. */
export function storageFormat(format: string, delimiter = ","): StorageFormat {
  const text = { InputFormat: "org.apache.hadoop.mapred.TextInputFormat", OutputFormat: "org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat" };
  switch (format) {
    case "csv":
      return { ...text, SerdeInfo: { SerializationLibrary: "org.apache.hadoop.hive.serde2.lazy.LazySimpleSerDe", Parameters: { "field.delim": delimiter } } };
    case "json":
      return { ...text, SerdeInfo: { SerializationLibrary: "org.openx.data.jsonserde.JsonSerDe" } };
    case "parquet":
      return {
        InputFormat: "org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat",
        OutputFormat: "org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat",
        SerdeInfo: { SerializationLibrary: "org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe" },
      };
    case "orc":
      return { InputFormat: "org.apache.hadoop.hive.ql.io.orc.OrcInputFormat", OutputFormat: "org.apache.hadoop.hive.ql.io.orc.OrcOutputFormat", SerdeInfo: { SerializationLibrary: "org.apache.hadoop.hive.ql.io.orc.OrcSerde" } };
    case "avro":
      return { InputFormat: "org.apache.hadoop.hive.ql.io.avro.AvroContainerInputFormat", OutputFormat: "org.apache.hadoop.hive.ql.io.avro.AvroContainerOutputFormat", SerdeInfo: { SerializationLibrary: "org.apache.hadoop.hive.serde2.avro.AvroSerDe" } };
    default:
      throw new Error(`Unknown data format "${format}".`);
  }
}

/** Crawler and job schedules: the console's choices -> a Glue cron expression ("" = on demand). */
export function glueSchedule(choice: string, custom?: string): string | undefined {
  switch (choice) {
    case "on-demand":
      return undefined;
    case "hourly":
      return "cron(0 * * * ? *)";
    case "daily":
      return "cron(0 0 * * ? *)";
    case "weekly":
      return "cron(0 0 ? * MON *)";
    case "monthly":
      return "cron(0 0 1 * ? *)";
    case "custom": {
      const c = (custom ?? "").trim();
      if (!/^cron\(.+\)$/.test(c)) throw new Error("Enter a cron expression such as cron(15 12 * * ? *).");
      return c;
    }
    default:
      throw new Error(`Unknown schedule "${choice}".`);
  }
}

export const SCHEDULES: Option[] = [
  { value: "on-demand", label: "On demand" },
  { value: "hourly", label: "Hourly" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "custom", label: "Custom" },
];

/** A crawler's cron expression -> the Edit schedule form ({ frequency, cron }); none means on demand. */
export function scheduleChoice(expression: string | undefined): { frequency: string; cron: string } {
  if (!expression) return { frequency: "on-demand", cron: "" };
  for (const o of SCHEDULES) {
    if (o.value !== "on-demand" && o.value !== "custom" && glueSchedule(o.value) === expression) return { frequency: o.value, cron: "" };
  }
  return { frequency: "custom", cron: expression };
}
