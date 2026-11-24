/**
 * AWS Lambda: Functions (with the hand-built Code and Test tabs), Layers and Event source
 * mappings, as in the Lambda console's left navigation.
 */

import type { ServiceDef } from "../../console/types.ts";
import { functions } from "./functions.ts";
import { eventSourceMappings, layers } from "./layers.ts";

export const lambdaService: ServiceDef = {
  id: "lambda",
  name: "AWS Lambda",
  category: "Compute",
  description: "Run code without thinking about servers or clusters.",
  resources: [functions, layers, eventSourceMappings],
  notSupported: [
    "Invoking Ruby functions (the emulator's Ruby runtime fails at invoke), so Ruby isn't offered",
  ],
};
