/** Hand-built DynamoDB "PartiQL editor" screen. ?table=<name> starts a SELECT for that table. */

import { notFound } from "next/navigation";
import { getService } from "@/console/registry";
import { engineList } from "@/console/server";
import { firstParam, ServiceFrame } from "@/console/ui/pages";
import { PageHeader } from "@/console/ui/primitives";
import { isTableName } from "@/services/dynamodb/attr";
import { PartiqlEditor } from "@/services/dynamodb/PartiqlEditor";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function PartiqlPage({ searchParams }: PageProps) {
  const service = getService("dynamodb");
  if (!service) notFound();
  const table = firstParam((await searchParams).table);
  const tables = await engineList("dynamodb", "partiql-editor");
  return (
    <ServiceFrame service={service} activeResource="partiql-editor" crumbs={[{ label: service.name, href: "/dynamodb" }, { label: "PartiQL editor" }]}>
      <PageHeader title="PartiQL editor" />
      <PartiqlEditor
        tables={tables.ok ? tables.data.map((r) => String(r.name)) : []}
        tablesError={tables.ok ? null : tables.error}
        initialTable={table && isTableName(table) ? table : null}
      />
    </ServiceFrame>
  );
}
