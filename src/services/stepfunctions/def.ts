/**
 * AWS Step Functions: state machines, executions and activities. Every value comes from a
 * Step Functions API response. The state machine page is hand-built
 * (src/app/stepfunctions/state-machines/[arn]) to add the Executions list and definition editor.
 */

import type { ServiceDef } from "../../console/types.ts";
import { activities } from "./activities.ts";
import { executions } from "./executions.ts";
import { stateMachines } from "./state-machines.ts";

export const stepfunctionsService: ServiceDef = {
  id: "stepfunctions",
  name: "AWS Step Functions",
  category: "Application Integration",
  description: "Visual workflows that coordinate AWS services, with state, retries and error handling.",
  resources: [stateMachines, executions, activities],
};
