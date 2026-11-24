import { test } from "node:test";
import assert from "node:assert/strict";
import { sdkCallToIam, cliArgsToIam, expandRecursive, UNKNOWN_RESOURCE } from "../src/lib/iam-action.ts";
import { UNKNOWN_RESOURCE as PERMISSIONS_UNKNOWN } from "../src/lib/permissions.ts";

const one = (r) => {
  assert.equal(r.length, 1, JSON.stringify(r));
  return r[0];
};
const reqs = (plan) => {
  assert.equal(plan?.kind, "requests", JSON.stringify(plan));
  return plan.requests;
};

test("SDK commands map to their IAM action, with S3, SQS and Lambda renames", () => {
  assert.equal(one(sdkCallToIam("SQSClient", "ListQueuesCommand", {})).action, "sqs:ListQueues");
  assert.equal(one(sdkCallToIam("S3Client", "ListBucketsCommand", {})).action, "s3:ListAllMyBuckets");
  assert.equal(one(sdkCallToIam("S3Client", "ListObjectsV2Command", { Bucket: "b" })).action, "s3:ListBucket");
  assert.equal(one(sdkCallToIam("S3Client", "PutBucketEncryptionCommand", { Bucket: "b" })).action, "s3:PutEncryptionConfiguration");
  assert.equal(one(sdkCallToIam("S3Client", "ListBucketInventoryConfigurationsCommand", { Bucket: "b" })).action, "s3:GetInventoryConfiguration");
  assert.equal(one(sdkCallToIam("S3Client", "DeleteBucketInventoryConfigurationCommand", { Bucket: "b" })).action, "s3:PutInventoryConfiguration");
  assert.equal(one(sdkCallToIam("S3Client", "PutBucketReplicationCommand", { Bucket: "b" })).action, "s3:PutReplicationConfiguration");
  assert.equal(one(sdkCallToIam("LambdaClient", "InvokeCommand", { FunctionName: "f" })).action, "lambda:InvokeFunction");
  assert.equal(one(sdkCallToIam("SQSClient", "SendMessageBatchCommand", { QueueUrl: "u/q" })).action, "sqs:SendMessage");
  assert.equal(one(sdkCallToIam("ElasticLoadBalancingV2Client", "DescribeLoadBalancersCommand", {})).action, "elasticloadbalancing:DescribeLoadBalancers");
});

test("SDK calls name the resource when the input identifies one", () => {
  assert.equal(one(sdkCallToIam("S3Client", "GetObjectCommand", { Bucket: "b", Key: "a/x.txt" })).resource, "arn:aws:s3:::b/a/x.txt");
  assert.equal(one(sdkCallToIam("S3Client", "DeleteBucketCommand", { Bucket: "b" })).resource, "arn:aws:s3:::b");
  assert.equal(one(sdkCallToIam("DynamoDBClient", "ScanCommand", { TableName: "T" })).resource, "arn:aws:dynamodb:us-east-1:000000000000:table/T");
  assert.equal(
    one(sdkCallToIam("SQSClient", "SendMessageCommand", { QueueUrl: "https://127.0.0.1:9297/000000000000/jobs" })).resource,
    "arn:aws:sqs:us-east-1:000000000000:jobs"
  );
  assert.equal(one(sdkCallToIam("IAMClient", "DeleteUserCommand", { UserName: "alice" })).resource, "arn:aws:iam::000000000000:user/alice");
  assert.equal(one(sdkCallToIam("EC2Client", "DescribeInstancesCommand", {})).resource, "*");
  assert.equal(one(sdkCallToIam("KMSClient", "ScheduleKeyDeletionCommand", { KeyId: "abc" })).resource, "arn:aws:kms:us-east-1:000000000000:key/abc");
  assert.equal(
    one(sdkCallToIam("IAMClient", "DeleteVirtualMFADeviceCommand", { SerialNumber: "arn:aws:iam::000000000000:mfa/u" })).resource,
    "arn:aws:iam::000000000000:mfa/u"
  );
});

test("group membership is authorised on the group, as the pre-checks in iam/actions.ts expect", () => {
  assert.equal(
    one(sdkCallToIam("IAMClient", "AddUserToGroupCommand", { UserName: "u", GroupName: "g" })).resource,
    "arn:aws:iam::000000000000:group/g"
  );
  assert.equal(
    one(sdkCallToIam("IAMClient", "RemoveUserFromGroupCommand", { UserName: "u", GroupName: "g" })).resource,
    "arn:aws:iam::000000000000:group/g"
  );
});

test("DeleteObjects is checked per key, not against the bucket", () => {
  assert.deepEqual(
    sdkCallToIam("S3Client", "DeleteObjectsCommand", { Bucket: "b", Delete: { Objects: [{ Key: "open/a" }, { Key: "secret/b" }] } }),
    [
      { action: "s3:DeleteObject", resource: "arn:aws:s3:::b/open/a" },
      { action: "s3:DeleteObject", resource: "arn:aws:s3:::b/secret/b" },
    ]
  );
});

test("CopyObject needs GetObject on the source and PutObject on the target", () => {
  assert.deepEqual(sdkCallToIam("S3Client", "CopyObjectCommand", { Bucket: "dst", Key: "k2", CopySource: "src/dir/k%201" }), [
    { action: "s3:GetObject", resource: "arn:aws:s3:::src/dir/k 1" },
    { action: "s3:PutObject", resource: "arn:aws:s3:::dst/k2" },
  ]);
});

test("DynamoDB batch calls are checked on every table", () => {
  assert.deepEqual(
    sdkCallToIam("DynamoDBClient", "BatchWriteItemCommand", { RequestItems: { A: [], B: [] } }).map((r) => r.resource),
    ["arn:aws:dynamodb:us-east-1:000000000000:table/A", "arn:aws:dynamodb:us-east-1:000000000000:table/B"]
  );
});

test("an unknown client gets no action, so a non-admin is denied", () => {
  assert.equal(sdkCallToIam("MysteryClient", "DoThingCommand", {}), null);
});

test("CLI service commands map kebab-case operations to IAM actions", () => {
  assert.deepEqual(reqs(cliArgsToIam(["dynamodb", "put-item", "--table-name", "Users", "--item", "{}"])), [
    { action: "dynamodb:PutItem", resource: "arn:aws:dynamodb:us-east-1:000000000000:table/Users" },
  ]);
  assert.equal(one(reqs(cliArgsToIam(["s3api", "get-bucket-encryption", "--bucket", "b"]))).action, "s3:GetEncryptionConfiguration");
  assert.equal(one(reqs(cliArgsToIam(["--region", "us-east-1", "sqs", "list-queues"]))).action, "sqs:ListQueues");
  assert.equal(one(reqs(cliArgsToIam(["lambda", "invoke", "--function-name", "f", "out.json"]))).action, "lambda:InvokeFunction");
  assert.equal(one(reqs(cliArgsToIam(["ec2", "describe-instances"]))).action, "ec2:DescribeInstances");
});

test("--flag=value names the same resource as --flag value", () => {
  assert.deepEqual(reqs(cliArgsToIam(["s3api", "delete-bucket", "--bucket=secret"])), [
    { action: "s3:DeleteBucket", resource: "arn:aws:s3:::secret" },
  ]);
  assert.equal(one(reqs(cliArgsToIam(["dynamodb", "delete-table", "--table-name=T"]))).resource, "arn:aws:dynamodb:us-east-1:000000000000:table/T");
});

test("a boolean flag before the operation's arguments does not hide them", () => {
  assert.deepEqual(reqs(cliArgsToIam(["--debug", "s3", "rm", "s3://b/k"])), [{ action: "s3:DeleteObject", resource: "arn:aws:s3:::b/k" }]);
  assert.deepEqual(cliArgsToIam(["s3", "rm", "--recursive", "s3://b/logs/"]), {
    kind: "s3-recursive", operation: "rm", source: { bucket: "b", key: "logs/" }, deleteExtra: false,
  });
});

test("CLI high-level s3 commands map to the actions they perform", () => {
  assert.deepEqual(reqs(cliArgsToIam(["s3", "ls"])), [{ action: "s3:ListAllMyBuckets", resource: "*" }]);
  assert.deepEqual(reqs(cliArgsToIam(["s3", "ls", "s3://b/"])), [{ action: "s3:ListBucket", resource: "arn:aws:s3:::b" }]);
  assert.deepEqual(reqs(cliArgsToIam(["s3", "mb", "s3://b"])), [{ action: "s3:CreateBucket", resource: "arn:aws:s3:::b" }]);
  assert.deepEqual(reqs(cliArgsToIam(["s3", "rm", "s3://b/k"])), [{ action: "s3:DeleteObject", resource: "arn:aws:s3:::b/k" }]);
  assert.deepEqual(reqs(cliArgsToIam(["s3", "cp", "s3://b/k", "-"])), [{ action: "s3:GetObject", resource: "arn:aws:s3:::b/k" }]);
});

test("copy and move check the source as well as the target", () => {
  assert.deepEqual(reqs(cliArgsToIam(["s3", "cp", "s3://secret/k", "s3://open/"])), [
    { action: "s3:GetObject", resource: "arn:aws:s3:::secret/k" },
    { action: "s3:PutObject", resource: "arn:aws:s3:::open/k" },
  ]);
  assert.deepEqual(reqs(cliArgsToIam(["s3", "mv", "s3://a/k", "s3://b/k2"])), [
    { action: "s3:GetObject", resource: "arn:aws:s3:::a/k" },
    { action: "s3:DeleteObject", resource: "arn:aws:s3:::a/k" },
    { action: "s3:PutObject", resource: "arn:aws:s3:::b/k2" },
  ]);
});

test("s3api copy-object and delete-objects are checked per object", () => {
  assert.deepEqual(reqs(cliArgsToIam(["s3api", "copy-object", "--copy-source", "a/k", "--bucket", "b", "--key", "k"])), [
    { action: "s3:GetObject", resource: "arn:aws:s3:::a/k" },
    { action: "s3:PutObject", resource: "arn:aws:s3:::b/k" },
  ]);
  assert.deepEqual(
    reqs(cliArgsToIam(["s3api", "delete-objects", "--bucket", "b", "--delete", '{"Objects":[{"Key":"x"},{"Key":"y"}]}'])).map((r) => r.resource),
    ["arn:aws:s3:::b/x", "arn:aws:s3:::b/y"]
  );
  // Shorthand syntax is not parsed, so it cannot be checked: denied for non-admins.
  assert.equal(cliArgsToIam(["s3api", "delete-objects", "--bucket", "b", "--delete", "Objects=[{Key=x}]"]), null);
});

test("recursive commands are expanded to every object they touch", () => {
  const plan = cliArgsToIam(["s3", "sync", "s3://a/in", "s3://b/out", "--delete"]);
  assert.deepEqual(plan, {
    kind: "s3-recursive", operation: "sync", source: { bucket: "a", key: "in" }, target: { bucket: "b", key: "out" }, deleteExtra: true,
  });
  assert.deepEqual(expandRecursive(plan, ["in/x"], ["out/old"]), [
    { action: "s3:ListBucket", resource: "arn:aws:s3:::a" },
    { action: "s3:ListBucket", resource: "arn:aws:s3:::b" },
    { action: "s3:GetObject", resource: "arn:aws:s3:::a/in/x" },
    { action: "s3:PutObject", resource: "arn:aws:s3:::b/out/x" },
    { action: "s3:DeleteObject", resource: "arn:aws:s3:::b/out/old" },
  ]);
  const rb = cliArgsToIam(["s3", "rb", "s3://b", "--force"]);
  assert.deepEqual(expandRecursive(rb, ["k1"], []), [
    { action: "s3:ListBucket", resource: "arn:aws:s3:::b" },
    { action: "s3:DeleteObject", resource: "arn:aws:s3:::b/k1" },
    { action: "s3:DeleteBucket", resource: "arn:aws:s3:::b" },
  ]);
  // An empty bucket still needs DeleteBucket.
  assert.deepEqual(expandRecursive(rb, [], []).map((r) => r.action), ["s3:ListBucket", "s3:DeleteBucket"]);
});

test("a resource that cannot be worked out is UNKNOWN, except for List and Describe calls", () => {
  assert.equal(UNKNOWN_RESOURCE, PERMISSIONS_UNKNOWN);
  assert.equal(one(sdkCallToIam("KMSClient", "ScheduleKeyDeletionCommand", { KeyId: "alias/x" })).resource, UNKNOWN_RESOURCE);
  assert.equal(one(sdkCallToIam("ElasticLoadBalancingV2Client", "DeleteLoadBalancerCommand", {})).resource, UNKNOWN_RESOURCE);
  assert.equal(one(sdkCallToIam("KMSClient", "ListKeysCommand", {})).resource, "*");
  assert.deepEqual(sdkCallToIam("EC2Client", "TerminateInstancesCommand", { InstanceIds: ["i-1", "i-2"] }).map((r) => r.resource), [
    "arn:aws:ec2:us-east-1:000000000000:instance/i-1",
    "arn:aws:ec2:us-east-1:000000000000:instance/i-2",
  ]);
  assert.deepEqual(reqs(cliArgsToIam(["ec2", "terminate-instances", "--instance-ids", "i-1", "i-2"])).map((r) => r.resource), [
    "arn:aws:ec2:us-east-1:000000000000:instance/i-1",
    "arn:aws:ec2:us-east-1:000000000000:instance/i-2",
  ]);
});

test("a repeated or abbreviated resource flag is checked as an unknown resource", () => {
  for (const args of [
    ["s3api", "delete-bucket", "--bucket", "allowed", "--bucket", "secret"],
    ["s3api", "delete-bucket", "--bucket=allowed", "--bucket", "secret"],
    ["s3api", "delete-bucket", "--buck", "secret"],
    ["dynamodb", "delete-table", "--table-name", "a", "--table-name", "b"],
    ["iam", "delete-user", "--user", "admin"],
  ]) {
    assert.deepEqual(reqs(cliArgsToIam(args)).map((r) => r.resource), [UNKNOWN_RESOURCE], JSON.stringify(args));
  }
  // High-level s3 flags change which objects are touched, so those are denied outright.
  assert.equal(cliArgsToIam(["s3", "cp", "--rec", "s3://a/p/", "s3://b/q/"]), null);
  assert.equal(cliArgsToIam(["s3", "rb", "s3://b", "--for"]), null);
});

test("flag values are not taken as S3 locations", () => {
  assert.deepEqual(cliArgsToIam(["s3", "rm", "--exclude", "s3://allowed/none", "s3://forbidden", "--recursive"]), {
    kind: "s3-recursive", operation: "rm", source: { bucket: "forbidden", key: "" }, deleteExtra: false,
  });
  assert.deepEqual(reqs(cliArgsToIam(["s3", "rm", "--include", "s3://allowed/k", "s3://forbidden/k"])), [
    { action: "s3:DeleteObject", resource: "arn:aws:s3:::forbidden/k" },
  ]);
  // A local file disguised by a "-" flag value is not an S3-to-S3 copy.
  assert.equal(cliArgsToIam(["s3", "cp", "credentials", "s3://forbidden/k", "--content-type", "-"]), null);
});

test("instance ids in JSON list form or via --instance-id are checked per instance", () => {
  const arn = (id) => `arn:aws:ec2:us-east-1:000000000000:instance/${id}`;
  assert.deepEqual(reqs(cliArgsToIam(["ec2", "terminate-instances", "--instance-ids", '["i-a1","i-b2"]'])).map((r) => r.resource), [arn("i-a1"), arn("i-b2")]);
  assert.deepEqual(reqs(cliArgsToIam(["ec2", "associate-address", "--instance-id", "i-a1", "--allocation-id", "e"])).map((r) => r.resource), [arn("i-a1")]);
  assert.equal(cliArgsToIam(["ec2", "terminate-instances", "--instance-ids", "Name=x"]), null);
});

test("CLI service names map to IAM prefixes, and unknown services are denied", () => {
  assert.equal(one(reqs(cliArgsToIam(["stepfunctions", "delete-state-machine", "--state-machine-arn", "a"]))).action, "states:DeleteStateMachine");
  assert.equal(one(reqs(cliArgsToIam(["sesv2", "send-email"]))).action, "ses:SendEmail");
  assert.equal(cliArgsToIam(["madeupservice", "do-thing"]), null);
});

test("wait commands check the call they poll", () => {
  assert.deepEqual(reqs(cliArgsToIam(["ec2", "wait", "instance-running"])), [{ action: "ec2:DescribeInstances", resource: "*" }]);
  assert.deepEqual(reqs(cliArgsToIam(["dynamodb", "wait", "table-exists", "--table-name", "T"])), [
    { action: "dynamodb:DescribeTable", resource: "arn:aws:dynamodb:us-east-1:000000000000:table/T" },
  ]);
});

test("CLI --copy-source is used as typed", () => {
  assert.equal(reqs(cliArgsToIam(["s3api", "copy-object", "--copy-source", "a/k%201", "--bucket", "b", "--key", "k"]))[0].resource, "arn:aws:s3:::a/k%201");
});

test("a flag before the operation is denied unless it is an exact global option", () => {
  assert.equal(cliArgsToIam(["s3", "--force", "rb", "s3://b"]), null);
  assert.equal(cliArgsToIam(["s3", "--recursive", "cp", "s3://a/p/", "s3://b/q/"]), null);
  assert.equal(cliArgsToIam(["--reg", "us-east-1", "s3", "ls"]), null);
  assert.deepEqual(reqs(cliArgsToIam(["s3", "--region", "us-east-1", "ls"])), [{ action: "s3:ListAllMyBuckets", resource: "*" }]);
  assert.deepEqual(reqs(cliArgsToIam(["--debug", "s3", "--no-paginate", "ls", "s3://b"])), [{ action: "s3:ListBucket", resource: "arn:aws:s3:::b" }]);
});

test("commands that cannot be mapped give null", () => {
  for (const args of [[], ["configure"], ["s3"], ["s3", "frobnicate", "s3://b"], ["help"], ["s3", "cp", "local.txt", "s3://b/k"]]) {
    assert.equal(cliArgsToIam(args), null, JSON.stringify(args));
  }
});

test("a full resource flag plus a shorter form of it checks an unknown resource", () => {
  for (const args of [
    ["iam", "delete-user", "--user-name", "mine", "--user", "victim"],
    ["iam", "delete-group", "--group-name", "mine", "--group", "victim"],
    ["iam", "delete-role", "--role-name", "mine", "--role", "victim"],
    ["kms", "schedule-key-deletion", "--key-id", "1111", "--key", "2222"],
  ]) {
    assert.deepEqual(reqs(cliArgsToIam(args)).map((r) => r.resource), [UNKNOWN_RESOURCE], JSON.stringify(args));
  }
  // On List calls --key is --key-marker, so it must not turn the bucket into an object.
  assert.equal(one(reqs(cliArgsToIam(["s3api", "list-object-versions", "--bucket", "secret", "--key", "x"]))).resource, "arn:aws:s3:::secret");
});

test("only account-wide List/Describe calls use '*'; others without a resource are unknown", () => {
  assert.equal(one(sdkCallToIam("KMSClient", "DescribeKeyCommand", { KeyId: "alias/secret" })).resource, UNKNOWN_RESOURCE);
  // IDS-5: a PolicyArn names the policy, as in AWS (it was unknown before).
  assert.equal(one(sdkCallToIam("IAMClient", "ListEntitiesForPolicyCommand", { PolicyArn: "arn:aws:iam::000000000000:policy/P" })).resource, "arn:aws:iam::000000000000:policy/P");
  assert.equal(one(sdkCallToIam("GuardDutyClient", "GetDetectorCommand", { DetectorId: "d" })).resource, UNKNOWN_RESOURCE);
  assert.equal(one(sdkCallToIam("IAMClient", "ListUsersCommand", {})).resource, "*");
  assert.equal(one(sdkCallToIam("EC2Client", "DescribeVolumesCommand", {})).resource, "*");
  assert.equal(one(sdkCallToIam("S3Client", "ListBucketsCommand", {})).resource, "*");
});

test("S3 operations whose IAM action has another name are renamed", () => {
  assert.equal(one(sdkCallToIam("S3Client", "ListMultipartUploadsCommand", { Bucket: "b" })).action, "s3:ListBucketMultipartUploads");
  assert.equal(one(sdkCallToIam("S3Client", "DeleteBucketLifecycleCommand", { Bucket: "b" })).action, "s3:PutLifecycleConfiguration");
  assert.equal(one(sdkCallToIam("S3Client", "GetBucketReplicationCommand", { Bucket: "b" })).action, "s3:GetReplicationConfiguration");
});
