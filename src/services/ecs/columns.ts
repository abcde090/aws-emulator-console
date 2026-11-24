/** Columns for the hand-built ECS tabs (first column is the link). */

import type { ColumnDef } from "../../console/types.ts";

export const SERVICE_TAB_COLUMNS: ColumnDef[] = [
  { key: "name", label: "Service name", kind: "link" },
  { key: "status", label: "Status", kind: "status" },
  { key: "deployment", label: "Deployment", kind: "status" },
  { key: "desired", label: "Desired tasks", kind: "count" },
  { key: "running", label: "Running tasks", kind: "count" },
  { key: "pending", label: "Pending tasks", kind: "count" },
  { key: "taskDefinition", label: "Task definition", kind: "text" },
  { key: "compute", label: "Launch type", kind: "text" },
];

export const TASK_TAB_COLUMNS: ColumnDef[] = [
  { key: "taskId", label: "Task", kind: "link" },
  { key: "lastStatus", label: "Last status", kind: "status" },
  { key: "desiredStatus", label: "Desired status", kind: "status" },
  { key: "taskDefinition", label: "Task definition", kind: "text" },
  { key: "health", label: "Health status", kind: "status" },
  { key: "started", label: "Started at", kind: "date" },
  { key: "group", label: "Group", kind: "text" },
  { key: "stoppedReason", label: "Stopped reason", kind: "text" },
];

export const REVISION_TAB_COLUMNS: ColumnDef[] = [
  { key: "id", label: "Task definition: revision", kind: "link" },
  { key: "status", label: "Status", kind: "status" },
];

export const taskHref = (id: unknown): string => `/ecs/tasks/${encodeURIComponent(String(id))}`;
export const serviceHref = (id: unknown): string => `/ecs/services/${encodeURIComponent(String(id))}`;
export const revisionHref = (id: unknown): string => `/ecs/task-definitions/${encodeURIComponent(String(id))}`;
