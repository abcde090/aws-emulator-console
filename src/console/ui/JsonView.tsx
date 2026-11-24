/** Read-only JSON, pretty-printed. */

export function JsonView({ value }: { value: unknown }) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return <pre className="max-h-[32rem] overflow-auto rounded-lg border border-line-soft bg-shade p-3 font-mono text-[13px] leading-5">{text}</pre>;
}
