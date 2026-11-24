import { test } from "node:test";
import assert from "node:assert/strict";
import { sdkCallToIam, cliArgsToIam, UNKNOWN_RESOURCE } from "../src/lib/iam-action.ts";
import { arnFieldResources, cliFlagsToInput } from "../src/lib/iam-resources.ts";
import { resolveLookups } from "../src/lib/iam-lookup.ts";
import { evaluatePermissions } from "../src/lib/permissions.ts";

const A = "arn:aws";
const R = "us-east-1:000000000000";
const res = (client, cmd, input) => sdkCallToIam(client, cmd, input).map((r) => r.resource);
const cliRes = (args) => {
  const plan = cliArgsToIam(args);
  assert.equal(plan?.kind, "requests", JSON.stringify(plan));
  return plan.requests.map((r) => r.resource);
};
const user = (statements) => ({
  type: "user", name: "rev-idsec-limited", accountId: "000000000000",
  policies: [{ name: "p", document: { Version: "2012-10-17", Statement: statements } }],
});

test("IDS-5: the reviewer's secret-scoped Allow matches DescribeSecret by name once the ARN is looked up", async () => {
  const id = user([{ Effect: "Allow", Action: ["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"], Resource: `${A}:secretsmanager:${R}:secret:rev-idsec-secret-*` }]);
  const reqs = sdkCallToIam("SecretsManagerClient", "DescribeSecretCommand", { SecretId: "rev-idsec-secret" });
  assert.equal(reqs[0].resource, `${A}:secretsmanager:${R}:secret:rev-idsec-secret-??????`);
  assert.deepEqual(reqs[0].lookup, { service: "secretsmanager", name: "rev-idsec-secret", region: "us-east-1" });
  // Without the lookup, the documented "-??????" form already matches name-*.
  assert.equal(evaluatePermissions(id, reqs[0].action, reqs[0].resource).allowed, true);
  const real = `${A}:secretsmanager:${R}:secret:rev-idsec-secret-AbC123`;
  const [resolved] = await resolveLookups(reqs, async () => real);
  assert.deepEqual(resolved, { action: "secretsmanager:DescribeSecret", resource: real });
  assert.equal(evaluatePermissions(id, resolved.action, resolved.resource).allowed, true);
  // Another secret stays denied; a failed lookup keeps the fallback.
  const [other] = await resolveLookups(sdkCallToIam("SecretsManagerClient", "DescribeSecretCommand", { SecretId: "prod-db" }), async () => null);
  assert.equal(evaluatePermissions(id, other.action, other.resource).allowed, false);
  // An exact-ARN Allow works once looked up.
  const exact = user([{ Effect: "Allow", Action: "secretsmanager:*", Resource: real }]);
  assert.equal(evaluatePermissions(exact, resolved.action, resolved.resource).allowed, true);
  // The CLI goes through the same mapping.
  assert.deepEqual(cliRes(["secretsmanager", "get-secret-value", "--secret-id", "rev-idsec-secret"]), [`${A}:secretsmanager:${R}:secret:rev-idsec-secret-??????`]);
  assert.deepEqual(res("SecretsManagerClient", "DescribeSecretCommand", { SecretId: real }), [real]);
});

test("IDS-5: common services map their identifying fields to ARNs", () => {
  assert.deepEqual(res("SNSClient", "PublishCommand", { TopicArn: `${A}:sns:${R}:t`, Message: "x" }), [`${A}:sns:${R}:t`]);
  assert.deepEqual(res("CloudWatchLogsClient", "DeleteLogGroupCommand", { logGroupName: "/aws/lambda/f" }), [`${A}:logs:${R}:log-group:/aws/lambda/f:*`]);
  assert.deepEqual(res("CloudWatchLogsClient", "GetLogEventsCommand", { logGroupName: "g", logStreamName: "s" }), [`${A}:logs:${R}:log-group:g:log-stream:s`]);
  assert.deepEqual(res("SSMClient", "GetParameterCommand", { Name: "/app/db" }), [`${A}:ssm:${R}:parameter/app/db`]);
  assert.deepEqual(res("SSMClient", "GetParametersCommand", { Names: ["a", "/b"] }), [`${A}:ssm:${R}:parameter/a`, `${A}:ssm:${R}:parameter/b`]);
  assert.deepEqual(res("EC2Client", "ModifyInstanceAttributeCommand", { InstanceId: "i-1" }), [`${A}:ec2:${R}:instance/i-1`]);
  assert.deepEqual(res("EC2Client", "DeleteVolumeCommand", { VolumeId: "vol-1" }), [`${A}:ec2:${R}:volume/vol-1`]);
  assert.deepEqual(res("EC2Client", "AuthorizeSecurityGroupIngressCommand", { GroupId: "sg-1" }), [`${A}:ec2:${R}:security-group/sg-1`]);
  assert.deepEqual(res("EC2Client", "DescribeInstanceAttributeCommand", { InstanceId: "i-1" }), ["*"]);
  assert.deepEqual(res("RDSClient", "DeleteDBInstanceCommand", { DBInstanceIdentifier: "db1" }), [`${A}:rds:${R}:db:db1`]);
  assert.deepEqual(res("RDSClient", "DeleteDBClusterCommand", { DBClusterIdentifier: "c1" }), [`${A}:rds:${R}:cluster:c1`]);
  assert.deepEqual(res("EventBridgeClient", "DisableRuleCommand", { Name: "r" }), [`${A}:events:${R}:rule/r`]);
  assert.deepEqual(res("EventBridgeClient", "PutTargetsCommand", { Rule: "r", EventBusName: "bus", Targets: [] }), [`${A}:events:${R}:rule/bus/r`]);
  const sm = `${A}:states:${R}:stateMachine:m`;
  assert.deepEqual(res("SFNClient", "StartExecutionCommand", { stateMachineArn: sm, roleArn: `${A}:iam::000000000000:role/x` }), [sm]);
  assert.deepEqual(res("SFNClient", "StopExecutionCommand", { executionArn: `${A}:states:${R}:execution:m:e` }), [`${A}:states:${R}:execution:m:e`]);
  assert.deepEqual(res("KinesisClient", "PutRecordCommand", { StreamName: "s" }), [`${A}:kinesis:${R}:stream/s`]);
  assert.deepEqual(res("KinesisClient", "PutRecordCommand", { StreamARN: `${A}:kinesis:${R}:stream/s` }), [`${A}:kinesis:${R}:stream/s`]);
  assert.deepEqual(res("ECSClient", "UpdateServiceCommand", { cluster: "c", service: "web" }), [`${A}:ecs:${R}:service/c/web`]);
  assert.deepEqual(res("ECSClient", "DescribeClustersCommand", { clusters: ["c"] }), [`${A}:ecs:${R}:cluster/c`]);
  assert.deepEqual(res("CloudFormationClient", "DeleteStackCommand", { StackName: "st" }), [`${A}:cloudformation:${R}:stack/st/*`]);
  assert.deepEqual(res("ACMClient", "DescribeCertificateCommand", { CertificateArn: `${A}:acm:${R}:certificate/x` }), [`${A}:acm:${R}:certificate/x`]);
  assert.deepEqual(res("IAMClient", "GetPolicyCommand", { PolicyArn: `${A}:iam::000000000000:policy/p` }), [`${A}:iam::000000000000:policy/p`]);
  assert.deepEqual(res("CognitoIdentityProviderClient", "DescribeUserPoolCommand", { UserPoolId: "us-east-1_x" }), [`${A}:cognito-idp:${R}:userpool/us-east-1_x`]);
});

test("OG-6: CloudWatch alarm actions map alarm names to alarm ARNs", () => {
  const alarm = (n) => `${A}:cloudwatch:${R}:alarm:${n}`;
  assert.deepEqual(res("CloudWatchClient", "PutMetricAlarmCommand", { AlarmName: "hi-cpu" }), [alarm("hi-cpu")]);
  assert.deepEqual(res("CloudWatchClient", "SetAlarmStateCommand", { AlarmName: "hi-cpu", StateValue: "OK" }), [alarm("hi-cpu")]);
  for (const cmd of ["DeleteAlarmsCommand", "DisableAlarmActionsCommand", "EnableAlarmActionsCommand"]) {
    assert.deepEqual(res("CloudWatchClient", cmd, { AlarmNames: ["a", "b"] }), [alarm("a"), alarm("b")], cmd);
  }
  assert.deepEqual(cliRes(["cloudwatch", "delete-alarms", "--alarm-names", "a", "b"]), [alarm("a"), alarm("b")]);
  const id = user([{ Effect: "Allow", Action: "cloudwatch:*", Resource: `${A}:cloudwatch:${R}:alarm:team-*` }]);
  const reqs = sdkCallToIam("CloudWatchClient", "DeleteAlarmsCommand", { AlarmNames: ["team-a", "other"] });
  assert.deepEqual(reqs.map((r) => evaluatePermissions(id, r.action, r.resource).allowed), [true, false]);
  assert.equal(evaluatePermissions(id, "cloudwatch:DescribeAlarms", res("CloudWatchClient", "DescribeAlarmsCommand", {})[0]).allowed, false);
});

test("unknown resources stay fail-closed", () => {
  assert.deepEqual(res("SecretsManagerClient", "DescribeSecretCommand", {}), [UNKNOWN_RESOURCE]);
  assert.deepEqual(res("GuardDutyClient", "GetDetectorCommand", { DetectorId: "d" }), [UNKNOWN_RESOURCE]);
  // ARNs of another service are never taken as the resource.
  assert.deepEqual(res("SFNClient", "CreateActivityCommand", { name: "a", roleArn: `${A}:iam::000000000000:role/x` }), [UNKNOWN_RESOURCE]);
  assert.deepEqual(arnFieldResources("sns", { TopicArn: "not-an-arn", KmsKeyArn: `${A}:kms:${R}:key/k` }), []);
  const id = user([{ Effect: "Allow", Action: "guardduty:*", Resource: `${A}:guardduty:${R}:detector/d` }]);
  assert.equal(evaluatePermissions(id, "guardduty:GetDetector", UNKNOWN_RESOURCE).allowed, false);
  // CLI: repeated, abbreviated or JSON/shorthand values never name a narrower resource.
  assert.deepEqual(cliRes(["secretsmanager", "get-secret-value", "--secret-id", "a", "--secret-id", "b"]), [UNKNOWN_RESOURCE]);
  assert.deepEqual(cliRes(["secretsmanager", "get-secret-value", "--secret", "a"]), [UNKNOWN_RESOURCE]);
  assert.deepEqual(cliRes(["cloudwatch", "delete-alarms", "--alarm-names", '["a","b"]']), [UNKNOWN_RESOURCE]);
  assert.deepEqual(cliRes(["cloudwatch", "delete-alarms", "--alarm-names", "a,b"]), [UNKNOWN_RESOURCE]);
  assert.equal(cliFlagsToInput(["--x", "1", "--x", "2"]), null);
});

test("RC-3: Athena, Route 53, CodeBuild, SQS GetQueueUrl and Budgets map to their resource ARNs", () => {
  assert.deepEqual(res("AthenaClient", "GetWorkGroupCommand", { WorkGroup: "wg" }), [`${A}:athena:${R}:workgroup/wg`]);
  assert.deepEqual(res("AthenaClient", "StartQueryExecutionCommand", { QueryString: "select 1" }), [`${A}:athena:${R}:workgroup/primary`]);
  assert.deepEqual(res("Route53Client", "GetHostedZoneCommand", { Id: "/hostedzone/Z1" }), [`${A}:route53:::hostedzone/Z1`]);
  assert.deepEqual(res("Route53Client", "ListResourceRecordSetsCommand", { HostedZoneId: "Z1" }), [`${A}:route53:::hostedzone/Z1`]);
  assert.deepEqual(res("CodeBuildClient", "StartBuildCommand", { projectName: "p" }), [`${A}:codebuild:${R}:project/p`]);
  assert.deepEqual(res("CodeBuildClient", "BatchGetBuildsCommand", { ids: ["p:1234"] }), [`${A}:codebuild:${R}:project/p`]);
  assert.deepEqual(res("SQSClient", "GetQueueUrlCommand", { QueueName: "q" }), [`${A}:sqs:${R}:q`]);
  assert.deepEqual(res("BudgetsClient", "DescribeBudgetCommand", { AccountId: "000000000000", BudgetName: "b" }), [`${A}:budgets::000000000000:budget/b`]);
});
