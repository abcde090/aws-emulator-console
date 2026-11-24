/**
 * The console engine's contract (see DESIGN.md "The engine"). A service is data: its
 * def.ts exports a ServiceDef and the engine draws list, detail, create and action screens
 * from it. Definitions run on the server only; the browser gets the *Meta types below.
 */

import type { AwsClients } from "../lib/aws.ts";
import type { SimIdentity } from "../lib/permissions.ts";

export type Row = Record<string, unknown>;

export interface Ctx {
  /**
   * Permission-checked clients: every call goes through the IAM simulator. They sign for
   * `region`; clients of global services (IAM, S3, Route 53, CloudFront …) always sign for
   * their home Region, us-east-1.
   */
  clients: AwsClients;
  /**
   * The same permission-checked clients, all signing for another Region (e.g. "us-west-2"),
   * for cross-Region copy actions. Throws on a malformed Region name.
   */
  clientsIn(region: string): AwsClients;
  /** The Region chosen in the top bar; us-east-1 on a global service's pages. */
  region: string;
  accountId: string;
  identity: SimIdentity;
}

export type ColumnKind = "text" | "link" | "status" | "date" | "bytes" | "count" | "arn" | "tags" | "boolean" | "code";

export interface ColumnDef {
  key: string;
  label: string;
  kind: ColumnKind;
  /** Hidden in the table but still searchable by the filter. */
  hidden?: boolean;
  /**
   * Makes the cell a link. A path template filled from the same row, e.g.
   * "/ecs/services/{cluster}/{serviceName}"; each value is URL-encoded. No link when a
   * placeholder is empty. Must start with "/". Works in list, detail-tab and result tables.
   */
  href?: string;
}

export type TabKind = "keyvalue" | "table" | "json" | "text";

export interface DetailTab {
  id: string;
  label: string;
  kind: TabKind;
  /** keyvalue: Row; table: Row[]; json: any JSON value; text: string. */
  data: unknown;
  /** For "table" tabs. */
  columns?: ColumnDef[];
  /** Shown above the tab content, e.g. what an empty tab means. */
  description?: string;
  emptyText?: string;
}

export interface Detail {
  summary: Row;
  /** Labels for summary keys; defaults to the key itself. */
  summaryLabels?: Record<string, string>;
  tabs?: DetailTab[];
  /** Set by the engine (never by a definition): actions whose availableFor() is false here ("$delete" for Delete). */
  unavailableActions?: string[];
}

export interface Option {
  value: string;
  label: string;
}

/** "password" is a masked text input; its value is never prefilled or echoed in errors. */
export type FieldKind = "text" | "number" | "select" | "multiselect" | "checkbox" | "textarea" | "json" | "tags" | "radio" | "password";

/**
 * Show a field only when another field has a value: `equals` is one value or a list of
 * allowed values. A field whose controlling field is hidden is hidden too.
 */
export interface ShowIf {
  field: string;
  equals: unknown;
}

/** Live options. `id` is the resource id when the field belongs to an action (or a delete). */
export type OptionsLoader = (ctx: Ctx, id?: string) => Promise<Option[]>;

export interface FieldValidation {
  pattern?: string;
  min?: number;
  max?: number;
  message: string;
}

export interface FieldDef {
  name: string;
  label: string;
  help?: string;
  kind: FieldKind;
  required?: boolean;
  default?: unknown;
  placeholder?: string;
  options?: Option[] | OptionsLoader;
  showIf?: ShowIf;
  validate?: FieldValidation;
  /** Groups fields into containers on the create form. */
  section?: string;
}

export type Tag = { Key: string; Value: string };

export type FieldValue = string | number | boolean | string[] | Tag[] | null;
export type FieldValues = Record<string, FieldValue>;

/** What an action shows when it finishes. A message must describe what the API returned. */
export interface ActionResult {
  message?: string;
  table?: {
    columns: ColumnDef[];
    rows: Row[];
    rowKey: string;
    emptyText?: string;
    /** Lets the user select rows and run another (usually hidden) action on them. */
    selectionAction?: { actionId: string; label: string; danger?: boolean; valuesField: string };
  };
  json?: unknown;
}

export interface ActionDef {
  id: string;
  label: string;
  danger?: boolean;
  /** Ask before running; the text explains what will happen. */
  confirm?: string;
  fields?: FieldDef[];
  /** Not in the Actions menu; reachable only from an ActionResult's selectionAction. */
  hidden?: boolean;
  /**
   * Current values for the dialog ("Edit …" actions): they replace the fields' defaults.
   * Password fields are never prefilled.
   */
  initialValues?(ctx: Ctx, id: string): Promise<FieldValues>;
  /**
   * Hides the action when it doesn't apply. Gets the list row on list pages and the detail
   * summary on detail pages; return true when unsure. Not a permission check.
   */
  availableFor?(row: Row): boolean;
  /**
   * Read-only actions with no fields and no confirm (e.g. EC2 "Connect"): the dialog runs it as
   * soon as it opens, so it never shows a blank dialog with only a button.
   */
  runOnOpen?: boolean;
  run(ctx: Ctx, id: string, values: FieldValues): Promise<ActionResult | void>;
}

/** An action on the page itself, needing no selected row (e.g. "Generate sample findings"). */
export interface PageActionDef {
  id: string;
  label: string;
  danger?: boolean;
  confirm?: string;
  fields?: FieldDef[];
  run(ctx: Ctx, values: FieldValues): Promise<ActionResult | void>;
}

export interface DeleteDef {
  confirmText?: "name" | "delete";
  /** false hides Delete for that row (list row or detail summary), like ActionDef.availableFor. */
  availableFor?(row: Row): boolean;
  /** Extra choices on the delete dialog, e.g. "Create final snapshot". */
  fields?: FieldDef[];
  run(ctx: Ctx, id: string, values: FieldValues): Promise<void>;
}

export interface ResourceDef {
  id: string;
  name: string;
  singular: string;
  idField: string;
  nameField?: string;
  list(ctx: Ctx): Promise<Row[]>;
  columns: ColumnDef[];
  get?(ctx: Ctx, id: string): Promise<Detail>;
  create?: { title: string; description?: string; fields: FieldDef[]; run(ctx: Ctx, values: FieldValues): Promise<string> };
  actions?: ActionDef[];
  /** Buttons in the list page header that act on no particular row. */
  pageActions?: PageActionDef[];
  delete?: DeleteDef;
  emptyText?: string;
  description?: string;
  /** Path (under the service) of a hand-built detail screen; "{id}" is replaced. */
  detailHref?: string;
}

export interface ServiceDef {
  id: string;
  name: string;
  category: string;
  description: string;
  resources: ResourceDef[];
  notSupported?: string[];
  /** Left-nav entries for hand-built pages; href "/x/y" or relative to the service ("y"). */
  extraNav?: NavEntry[];
}

export interface NavEntry {
  label: string;
  href: string;
}

// ---- Plain, serialisable metadata sent to the browser ----

export interface FieldMeta {
  name: string;
  label: string;
  help?: string;
  kind: FieldKind;
  required?: boolean;
  default?: FieldValue;
  placeholder?: string;
  options?: Option[];
  /** Set when live options could not be loaded; the field is then not offered. */
  optionsError?: string;
  showIf?: ShowIf;
  validate?: FieldValidation;
  section?: string;
  /** An optional select prefilled from initialValues() whose definition has no default: it keeps "-" so it can be cleared. */
  clearable?: boolean;
}

export interface ActionMeta {
  id: string;
  label: string;
  danger?: boolean;
  confirm?: string;
  hasFields: boolean;
  hidden?: boolean;
  runOnOpen?: boolean;
  /** The action has availableFor(); rows/details carry which actions are unavailable. */
  conditional?: boolean;
}

export interface PageActionMeta {
  id: string;
  label: string;
  danger?: boolean;
  confirm?: string;
  hasFields: boolean;
  runOnOpen?: boolean;
}

export interface ResourceMeta {
  id: string;
  name: string;
  singular: string;
  idField: string;
  nameField?: string;
  columns: ColumnDef[];
  canGet: boolean;
  canCreate: boolean;
  createTitle?: string;
  createDescription?: string;
  actions: ActionMeta[];
  pageActions: PageActionMeta[];
  deleteConfirm?: "name" | "delete";
  canDelete: boolean;
  deleteHasFields: boolean;
  emptyText?: string;
  description?: string;
  detailHref?: string;
}

export interface ServiceMeta {
  id: string;
  name: string;
  category: string;
  description: string;
  resources: ResourceMeta[];
  notSupported: string[];
  extraNav: NavEntry[];
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: string };
