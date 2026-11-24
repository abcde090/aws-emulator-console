/** Turns Logs Insights results ([{field, value}] per record) into table columns and rows. */

export interface ResultField {
  field?: string;
  value?: string;
}

export function resultRows(results: readonly (readonly ResultField[])[]): { columns: string[]; rows: Record<string, string>[] } {
  const columns: string[] = [];
  const rows = results.map((record, i) => {
    const row: Record<string, string> = { "#": String(i + 1) };
    for (const f of record) {
      if (!f.field || f.field === "@ptr") continue;
      if (!columns.includes(f.field)) columns.push(f.field);
      row[f.field] = f.value ?? "";
    }
    return row;
  });
  return { columns: ["#", ...columns], rows };
}
