/**
 * Data for the hand-built ECS screens. Uses the engine's context (permission-checked
 * clients and the acting identity) and returns Results; nothing here throws to the page.
 */

import { makeCtx } from "../../console/server.ts";
import { errorMessage } from "../../console/serialize.ts";
import type { Result, Row } from "../../console/types.ts";
import { isEcsName, splitId, splitTaskDefinition } from "./helpers.ts";
import { describeServicesIn, serviceRow } from "./services.ts";
import { listRevisions } from "./task-definitions.ts";
import { describeTasksIn, taskRow } from "./tasks.ts";

async function attempt<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err: unknown) {
    return { ok: false, error: errorMessage(err) };
  }
}

export function clusterServices(cluster: string): Promise<Result<Row[]>> {
  return attempt(async () => {
    if (!isEcsName(cluster)) throw new Error("That is not a valid cluster name.");
    return (await describeServicesIn(await makeCtx(), cluster)).map(serviceRow);
  });
}

export function clusterTasks(cluster: string): Promise<Result<Row[]>> {
  return attempt(async () => {
    if (!isEcsName(cluster)) throw new Error("That is not a valid cluster name.");
    return (await describeTasksIn(await makeCtx(), cluster)).map(taskRow);
  });
}

export function serviceTasks(id: string): Promise<Result<Row[]>> {
  return attempt(async () => {
    const { cluster, name } = splitId(id, "service");
    return (await describeTasksIn(await makeCtx(), cluster, name)).map(taskRow);
  });
}

export function familyRevisions(id: string): Promise<Result<Row[]>> {
  return attempt(async () => {
    const { family } = splitTaskDefinition(id);
    return listRevisions(await makeCtx(), family);
  });
}
