/** Live options for SNS forms: topics, queues and functions that exist in the emulator. */

import { ListTopicsCommand } from "@aws-sdk/client-sns";
import { GetQueueAttributesCommand, ListQueuesCommand } from "@aws-sdk/client-sqs";
import { ListFunctionsCommand } from "@aws-sdk/client-lambda";
import type { Ctx, Option } from "../../console/types.ts";
import { lastArnSegment } from "./helpers.ts";

export async function listTopicArns(ctx: Ctx): Promise<string[]> {
  const arns: string[] = [];
  let token: string | undefined;
  do {
    const page = await ctx.clients.sns.send(new ListTopicsCommand({ NextToken: token }));
    for (const t of page.Topics ?? []) if (t.TopicArn) arns.push(t.TopicArn);
    token = page.NextToken;
  } while (token);
  return arns;
}

export async function topicOptions(ctx: Ctx): Promise<Option[]> {
  return (await listTopicArns(ctx)).map((arn) => ({ value: arn, label: lastArnSegment(arn) }));
}

export async function queueOptions(ctx: Ctx): Promise<Option[]> {
  const urls: string[] = [];
  let token: string | undefined;
  do {
    const page = await ctx.clients.sqs.send(new ListQueuesCommand({ MaxResults: 1000, NextToken: token }));
    urls.push(...(page.QueueUrls ?? []));
    token = page.NextToken;
  } while (token);
  const rows = await Promise.all(
    urls.map(async (url) => {
      const r = await ctx.clients.sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ["QueueArn"] }));
      return r.Attributes?.QueueArn ?? null;
    })
  );
  return rows.filter((arn): arn is string => arn !== null).map((arn) => ({ value: arn, label: lastArnSegment(arn) }));
}

export async function functionOptions(ctx: Ctx): Promise<Option[]> {
  const out: Option[] = [];
  let marker: string | undefined;
  do {
    const page = await ctx.clients.lambda.send(new ListFunctionsCommand({ Marker: marker }));
    for (const f of page.Functions ?? []) if (f.FunctionArn) out.push({ value: f.FunctionArn, label: f.FunctionName ?? f.FunctionArn });
    marker = page.NextMarker;
  } while (marker);
  return out;
}
