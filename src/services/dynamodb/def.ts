/**
 * Amazon DynamoDB: tables (generic engine), the hand-built Explore items and PartiQL
 * editor screens (src/app/dynamodb/...), backups, and exports and imports with S3.
 */

import type { ResourceDef, ServiceDef } from "../../console/types.ts";
import { backupsResource } from "./backups.ts";
import { exportsResource, importsResource } from "./exports.ts";
import { listTableNames } from "./shared.ts";
import { tablesResource } from "./tables.ts";

/** Left-nav entries for hand-built screens; their list is the tables they open. */
function tablePicker(id: string, name: string, description: string, href: string): ResourceDef {
  return {
    id,
    name,
    singular: "table",
    idField: "name",
    nameField: "name",
    description,
    emptyText: "You have no tables in this account in this AWS Region.",
    columns: [{ key: "name", label: "Table", kind: "link" }],
    async list(ctx) {
      return (await listTableNames(ctx)).map((name) => ({ name }));
    },
    detailHref: href,
  };
}

const exploreItems = tablePicker("explore-items", "Explore items", "Scan or query a table's items, and create, edit or delete them.", "explore-items?table={id}");
const partiql = tablePicker("partiql-editor", "PartiQL editor", "Run PartiQL statements against your tables.", "partiql-editor?table={id}");

export const dynamodbService: ServiceDef = {
  id: "dynamodb",
  name: "Amazon DynamoDB",
  category: "Database",
  description: "Serverless, fully managed NoSQL key-value and document database with single-digit millisecond performance at any scale.",
  resources: [tablesResource, exploreItems, partiql, backupsResource, exportsResource, importsResource],
};
