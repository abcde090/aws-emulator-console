/**
 * Hand-built DynamoDB "Explore items" screen. ?table=<name> picks the table; the first
 * page of a scan is loaded on the server.
 */

import { notFound } from "next/navigation";
import { getService } from "@/console/registry";
import { engineList } from "@/console/server";
import { firstParam, ServiceFrame } from "@/console/ui/pages";
import { PageHeader } from "@/console/ui/primitives";
import { isTableName } from "@/services/dynamodb/attr";
import { describeForExplorer, runItemQuery } from "@/services/dynamodb/item-actions";
import { ItemExplorer } from "@/services/dynamodb/ItemExplorer";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ExploreItemsPage({ searchParams }: PageProps) {
  const service = getService("dynamodb");
  if (!service) notFound();
  const table = firstParam((await searchParams).table);
  const tables = await engineList("dynamodb", "explore-items");
  const schema = table && isTableName(table) ? await describeForExplorer(table) : null;
  const first = schema?.ok
    ? await runItemQuery({ table: schema.data.name, mode: "scan", index: null, pkValue: "", skOp: "=", skValue: "", skValue2: "", filters: [], limit: 50, startKey: null })
    : null;
  return (
    <ServiceFrame service={service} activeResource="explore-items" crumbs={[{ label: service.name, href: "/dynamodb" }, { label: "Explore items" }, ...(table ? [{ label: table }] : [])]}>
      <PageHeader title="Explore items" description="Scan or query a table or index, then create, edit or delete items." />
      <ItemExplorer
        key={table ?? ""}
        tables={tables.ok ? tables.data.map((r) => String(r.name)) : []}
        tablesError={tables.ok ? null : tables.error}
        schema={schema?.ok ? schema.data : null}
        schemaError={table && !isTableName(table) ? "That is not a valid table name." : schema && !schema.ok ? schema.error : null}
        initial={first?.ok ? first.data : null}
        initialError={first && !first.ok ? first.error : null}
      />
    </ServiceFrame>
  );
}
