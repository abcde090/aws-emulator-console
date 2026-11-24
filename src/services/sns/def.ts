/**
 * Amazon SNS: topics, subscriptions and mobile push. Every value comes from an SNS API
 * response; every control calls an SNS API through the permission-checked client.
 */

import type { ServiceDef } from "../../console/types.ts";
import { platformApplications } from "./platform.ts";
import { subscriptions } from "./subscriptions.ts";
import { topics } from "./topics.ts";

export const snsService: ServiceDef = {
  id: "sns",
  name: "Amazon SNS",
  category: "Application Integration",
  description: "Fully managed pub/sub messaging: fan messages out to queues, functions, HTTP endpoints, email and SMS.",
  resources: [topics, subscriptions, platformApplications],
  notSupported: [
    "Confirming email and HTTP/S subscriptions: they stay Pending confirmation, and ConfirmSubscription needs the token SNS sends to the endpoint",
  ],
};
