import { test } from "node:test";
import assert from "node:assert/strict";
import { cliArgsToIam, cliRegion, sdkCallToIam } from "../src/lib/iam-action.ts";
import { mappedResources } from "../src/lib/iam-resources.ts";
import { resolveLookups } from "../src/lib/iam-lookup.ts";
import { evaluatePermissions } from "../src/lib/permissions.ts";

const W = "us-west-2:000000000000";
const res = (client, cmd, input, region) => sdkCallToIam(client, cmd, input, region).map((r) => r.resource);
const cliRes = (args, region) => {
  const plan = cliArgsToIam(args, region);
  assert.equal(plan?.kind, "requests", JSON.stringify(plan));
  return plan.requests.map((r) => r.resource);
};

test("SDK calls build Regional ARNs with the client's Region", () => {
  assert.deepEqual(res("DynamoDBClient", "ScanCommand", { TableName: "T" }, "us-west-2"), [`arn:aws:dynamodb:${W}:table/T`]);
  assert.deepEqual(res("SQSClient", "SendMessageCommand", { QueueUrl: "https://sqs.us-west-2.amazonaws.com/000000000000/q" }, "us-west-2"), [`arn:aws:sqs:${W}:q`]);
  assert.deepEqual(res("LambdaClient", "InvokeCommand", { FunctionName: "f" }, "us-west-2"), [`arn:aws:lambda:${W}:function:f`]);
  assert.deepEqual(res("KMSClient", "DisableKeyCommand", { KeyId: "k1" }, "eu-west-1"), ["arn:aws:kms:eu-west-1:000000000000:key/k1"]);
  assert.deepEqual(res("EC2Client", "StopInstancesCommand", { InstanceIds: ["i-1"] }, "us-west-2"), [`arn:aws:ec2:${W}:instance/i-1`]);
  assert.deepEqual(res("DynamoDBClient", "BatchWriteItemCommand", { RequestItems: { A: [] } }, "us-west-2"), [`arn:aws:dynamodb:${W}:table/A`]);
  // iam-resources.ts mappings follow the Region too.
  assert.deepEqual(res("CloudWatchLogsClient", "DeleteLogGroupCommand", { logGroupName: "g" }, "us-west-2"), [`arn:aws:logs:${W}:log-group:g:*`]);
  assert.deepEqual(res("SSMClient", "GetParameterCommand", { Name: "/a/b" }, "ap-south-1"), ["arn:aws:ssm:ap-south-1:000000000000:parameter/a/b"]);
  assert.deepEqual(res("KinesisClient", "DescribeStreamCommand", { StreamName: "s" }, "us-west-2"), [`arn:aws:kinesis:${W}:stream/s`]);
  // Without a Region the default stays us-east-1.
  assert.deepEqual(res("DynamoDBClient", "ScanCommand", { TableName: "T" }), ["arn:aws:dynamodb:us-east-1:000000000000:table/T"]);
});

test("global and Region-less ARNs do not change with the Region", () => {
  assert.deepEqual(res("IAMClient", "GetUserCommand", { UserName: "u" }, "us-west-2"), ["arn:aws:iam::000000000000:user/u"]);
  assert.deepEqual(res("S3Client", "GetObjectCommand", { Bucket: "b", Key: "k" }, "us-west-2"), ["arn:aws:s3:::b/k"]);
  assert.deepEqual(res("Route53Client", "GetHostedZoneCommand", { Id: "/hostedzone/Z1" }, "us-west-2"), ["arn:aws:route53:::hostedzone/Z1"]);
});

test("a Secrets Manager lookup happens in the call's Region", async () => {
  const reqs = sdkCallToIam("SecretsManagerClient", "DescribeSecretCommand", { SecretId: "s" }, "us-west-2");
  assert.equal(reqs[0].resource, `arn:aws:secretsmanager:${W}:secret:s-??????`);
  assert.deepEqual(reqs[0].lookup, { service: "secretsmanager", name: "s", region: "us-west-2" });
  let asked = null;
  await resolveLookups(reqs, async (l) => {
    asked = l.region;
    return null;
  });
  assert.equal(asked, "us-west-2");
});

test("fail closed: a malformed Region maps to nothing (denied), never to a crafted ARN", () => {
  for (const bad of ["us-east-1:000000000000:table/Allowed", "", "evil.com", "us-west-2/../x"]) {
    assert.equal(sdkCallToIam("DynamoDBClient", "ScanCommand", { TableName: "T" }, bad), null, bad);
    assert.equal(mappedResources("logs", "DeleteLogGroup", { logGroupName: "g" }, bad), null, bad);
    assert.equal(cliArgsToIam(["dynamodb", "scan", "--table-name", "T"], bad), null, bad);
  }
});

test("a us-east-1-scoped Allow does not cover the same table in us-west-2", () => {
  const id = {
    type: "user", name: "u", accountId: "000000000000",
    policies: [{ name: "p", document: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "dynamodb:Scan", Resource: "arn:aws:dynamodb:us-east-1:000000000000:table/T" }] } }],
  };
  const [east] = sdkCallToIam("DynamoDBClient", "ScanCommand", { TableName: "T" }, "us-east-1");
  const [west] = sdkCallToIam("DynamoDBClient", "ScanCommand", { TableName: "T" }, "us-west-2");
  assert.equal(evaluatePermissions(id, east.action, east.resource).allowed, true);
  assert.equal(evaluatePermissions(id, west.action, west.resource).allowed, false);
});

test("CloudShell commands use CloudShell's Region, or the command's own --region", () => {
  assert.deepEqual(cliRes(["dynamodb", "scan", "--table-name", "T"], "us-west-2"), [`arn:aws:dynamodb:${W}:table/T`]);
  assert.deepEqual(cliRes(["dynamodb", "scan", "--table-name", "T", "--region", "eu-west-1"], "us-west-2"), ["arn:aws:dynamodb:eu-west-1:000000000000:table/T"]);
  assert.deepEqual(cliRes(["--region=eu-west-1", "dynamodb", "scan", "--table-name", "T"], "us-west-2"), ["arn:aws:dynamodb:eu-west-1:000000000000:table/T"]);
  assert.deepEqual(cliRes(["ec2", "stop-instances", "--instance-ids", "i-1"], "us-west-2"), [`arn:aws:ec2:${W}:instance/i-1`]);
  assert.deepEqual(cliRes(["logs", "delete-log-group", "--log-group-name", "g"], "us-west-2"), [`arn:aws:logs:${W}:log-group:g:*`]);
  assert.deepEqual(cliRes(["dynamodb", "wait", "table-exists", "--table-name", "T"], "us-west-2"), [`arn:aws:dynamodb:${W}:table/T`]);
});

test("cliRegion: an unclear --region is denied (null), never guessed", () => {
  assert.equal(cliRegion(["sqs", "list-queues"], "us-west-2"), "us-west-2");
  assert.equal(cliRegion(["sqs", "list-queues", "--region", "ap-south-1"], "us-west-2"), "ap-south-1");
  assert.equal(cliRegion(["sqs", "list-queues", "--region", "a", "--region", "b"], "us-west-2"), null, "repeated");
  assert.equal(cliRegion(["sqs", "list-queues", "--region", "us-west-2", "--region", "us-west-2"], "us-west-2"), null, "repeated");
  assert.equal(cliRegion(["sqs", "list-queues", "--regi", "eu-west-1"], "us-west-2"), null, "abbreviated");
  assert.equal(cliRegion(["sqs", "list-queues", "--region"], "us-west-2"), null, "no value");
  assert.equal(cliRegion(["sqs", "list-queues", "--region", "us-east-1:000000000000:table/X"], "us-west-2"), null, "not a Region");
  assert.equal(cliArgsToIam(["dynamodb", "scan", "--table-name", "T", "--regio", "eu-west-1"], "us-west-2"), null);
});
