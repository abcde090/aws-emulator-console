/** One value, drawn the way the console draws its column kind. */

import Link from "next/link";
import { formatValue } from "../format.ts";
import type { ColumnKind } from "../types.ts";
import { StatusBadge } from "./primitives.tsx";

interface CellValueProps {
  kind: ColumnKind;
  value: unknown;
  /** A filled-in link: drawn for any kind with a value (not only "link"). */
  href?: string | null;
}

export function CellValue({ kind, value, href }: CellValueProps) {
  const text = formatValue(kind, value);
  if (kind === "status") {
    return href && text !== "-" ? (
      <Link href={href}>
        <StatusBadge value={value} />
      </Link>
    ) : (
      <StatusBadge value={value} />
    );
  }
  if (href && text !== "-") {
    return (
      <Link href={href} className="font-normal">
        {text}
      </Link>
    );
  }
  if (kind === "arn" || kind === "code") return <span className="font-mono text-[13px] break-all">{text}</span>;
  return <span className="break-words">{text}</span>;
}
