/**
 * Tag edits as a difference, shared by every "Manage tags" dialog. The dialog opens with the
 * current tags and Save sends only what changed: tag (add or overwrite) the new or changed keys,
 * untag the keys that are gone. Saving an unchanged list sends nothing ("No tag changes.").
 *
 * Wanted keys are trimmed, blank keys are ignored and a repeated key is an error (the real
 * console refuses duplicate keys). Two shapes: `{ Key, Value }[]` lists (`tagDiff`) and the
 * `{ key: value }` maps some APIs use (EKS, Lambda, EFS, Backup… : `recordTagDiff`).
 */

import type { ActionDef, Ctx, Tag } from "./types.ts";

/** A tag as APIs return it (SDK types make both members optional). */
export type TagLike = { Key?: string | null; Value?: string | null };

export interface TagDiff {
  /** Tags that are new or have a new value. */
  set: Tag[];
  /** Keys that are gone from the wanted list. */
  remove: string[];
}

export interface RecordTagDiff {
  set: Record<string, string>;
  remove: string[];
}

/** The wanted tags as a map: keys trimmed, blank keys dropped, a repeated key rejected. */
function wantedMap(pairs: Iterable<readonly [unknown, unknown]>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of pairs) {
    const key = typeof k === "string" ? k.trim() : "";
    if (key === "") continue;
    if (out.has(key)) throw new Error(`The tag key "${key}" appears more than once. Tag keys must be unique.`);
    out.set(key, typeof v === "string" ? v : "");
  }
  return out;
}

/** The current tags as a map (keys exactly as the API returned them; blank keys dropped). */
function currentMap(pairs: Iterable<readonly [unknown, unknown]>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of pairs) if (typeof k === "string" && k !== "") out.set(k, typeof v === "string" ? v : "");
  return out;
}

const listPairs = (tags: readonly TagLike[] | undefined | null): [unknown, unknown][] => (tags ?? []).filter((t) => t && typeof t === "object").map((t) => [t.Key, t.Value]);

function diffMaps(now: Map<string, string>, want: Map<string, string>): { set: [string, string][]; remove: string[] } {
  return {
    set: [...want].filter(([k, v]) => now.get(k) !== v),
    remove: [...now.keys()].filter((k) => !want.has(k)),
  };
}

/** What to send to turn the `current` tag list into `wanted`. */
export function tagDiff(current: readonly TagLike[] | undefined | null, wanted: readonly TagLike[] | undefined | null): TagDiff {
  const d = diffMaps(currentMap(listPairs(current)), wantedMap(listPairs(wanted)));
  return { set: d.set.map(([Key, Value]) => ({ Key, Value })), remove: d.remove };
}

/** What to send to turn the `current` tag map into `wanted`, for APIs that take `{ key: value }` maps. */
export function recordTagDiff(current: Record<string, string> | undefined | null, wanted: Record<string, string> | undefined | null): RecordTagDiff {
  const d = diffMaps(currentMap(Object.entries(current ?? {})), wantedMap(Object.entries(wanted ?? {})));
  return { set: Object.fromEntries(d.set), remove: d.remove };
}

/** True when the diff sends nothing. */
export function noTagChanges(d: TagDiff | RecordTagDiff): boolean {
  return d.remove.length === 0 && (Array.isArray(d.set) ? d.set.length : Object.keys(d.set).length) === 0;
}

/** "No tag changes." or "Added or changed 2 tags, removed 1." */
export function tagDiffMessage(d: TagDiff | RecordTagDiff): string {
  if (noTagChanges(d)) return "No tag changes.";
  const n = Array.isArray(d.set) ? d.set.length : Object.keys(d.set).length;
  return `Added or changed ${n} tag${n === 1 ? "" : "s"}, removed ${d.remove.length}.`;
}

// ---- adapters ----

/** A "tags" form value (or any unknown list) as clean `{ Key, Value }` pairs: trimmed, non-blank keys, string values. */
export function fieldTags(v: unknown): Tag[] {
  if (!Array.isArray(v)) return [];
  const out: Tag[] = [];
  for (const t of v as unknown[]) {
    if (!t || typeof t !== "object") continue;
    const { Key, Value } = t as { Key?: unknown; Value?: unknown };
    const key = typeof Key === "string" ? Key.trim() : "";
    if (key !== "") out.push({ Key: key, Value: typeof Value === "string" ? Value : "" });
  }
  return out;
}

/** Tags as returned by an API, as `{ Key, Value }` pairs (blank keys dropped, missing values ""). */
export function tagPairs(tags: readonly TagLike[] | undefined | null): Tag[] {
  return [...currentMap(listPairs(tags))].map(([Key, Value]) => ({ Key, Value }));
}

/** A `{ key: value }` tag map as `{ Key, Value }` pairs (a "tags" field value or table rows). */
export function recordToTags(record: Record<string, string> | undefined | null): Tag[] {
  return Object.entries(record ?? {}).map(([Key, Value]) => ({ Key, Value }));
}

/** A tag list as a `{ key: value }` map, with the same key rules as a diff (a repeated key throws). */
export function tagsToRecord(tags: readonly TagLike[] | undefined | null): Record<string, string> {
  return Object.fromEntries(wantedMap(listPairs(tags)));
}

/** A "tags" form value as a `{ key: value }` map for a create call, or undefined when there are none. */
export function tagRecord(v: unknown): Record<string, string> | undefined {
  const r = tagsToRecord(fieldTags(v));
  return Object.keys(r).length ? r : undefined;
}

// ---- a generic "Manage tags" action ----

export interface TagApi {
  read(ctx: Ctx, id: string): Promise<Tag[]>;
  tag(ctx: Ctx, id: string, tags: Tag[]): Promise<void>;
  untag(ctx: Ctx, id: string, keys: string[]): Promise<void>;
}

/** "Manage tags": opens with the current tags; Save untags removed keys and tags new or changed ones. */
export function manageTagsAction(api: TagApi, help = "Edit or remove the current tags, or add new ones. Removing a row deletes that tag."): ActionDef {
  return {
    id: "tags",
    label: "Manage tags",
    fields: [{ name: "tags", label: "Tags", kind: "tags", help }],
    async initialValues(ctx, id) {
      return { tags: await api.read(ctx, id) };
    },
    async run(ctx, id, v) {
      const diff = tagDiff(await api.read(ctx, id), fieldTags(v.tags));
      if (diff.remove.length) await api.untag(ctx, id, diff.remove);
      if (diff.set.length) await api.tag(ctx, id, diff.set);
      return { message: tagDiffMessage(diff) };
    },
  };
}

/** The value of the "Name" tag, as the console shows it, or null. */
export function nameTag(tags: readonly TagLike[] | undefined | null): string | null {
  return tags?.find((t) => t.Key === "Name")?.Value ?? null;
}
