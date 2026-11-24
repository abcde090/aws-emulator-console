/** Field-target names for loadFields/engineFields besides "create" and an action id (pure; browser-safe). */
export const DELETE_TARGET = "$delete";
export const PAGE_ACTION_PREFIX = "$page:";

export function pageActionTarget(actionId: string): string {
  return `${PAGE_ACTION_PREFIX}${actionId}`;
}
