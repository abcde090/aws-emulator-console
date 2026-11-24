/**
 * Amazon EventBridge: event buses, rules, archives, replays, and EventBridge Scheduler.
 * Every value comes from an EventBridge or Scheduler API response.
 *
 * Delivery (checked against AWS Emulator): rules deliver matched and scheduled events to SQS
 * targets when the queue policy allows events.amazonaws.com, and start Step Functions
 * executions when the target role trusts events.amazonaws.com and allows states:StartExecution.
 * Scheduler delivers to SQS when the execution role allows sqs:SendMessage.
 */

import type { ServiceDef } from "../../console/types.ts";
import { archives, replays } from "./archives.ts";
import { eventBuses } from "./buses.ts";
import { rules } from "./rules.ts";
import { scheduleGroups, schedules } from "./schedules.ts";

export const eventbridgeService: ServiceDef = {
  id: "eventbridge",
  name: "Amazon EventBridge",
  category: "Application Integration",
  description: "Serverless event bus and scheduler: route events between AWS services and your applications.",
  resources: [eventBuses, rules, archives, replays, schedules, scheduleGroups],
};
