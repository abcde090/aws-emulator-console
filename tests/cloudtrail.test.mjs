import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFilter, eventRow } from "../src/services/cloudtrail/events.ts";
import { buildSelectors, selectorInput, selectorRows, trailBucketPolicy, trailChanges } from "../src/services/cloudtrail/selectors.ts";
import { lakeRows } from "../src/services/cloudtrail/lake.ts";

test("CloudTrail: event lookup filters are validated", () => {
  assert.deepEqual(checkFilter({ key: "EventName", value: " CreateQueue " }), { attribute: { AttributeKey: "EventName", AttributeValue: "CreateQueue" } });
  assert.deepEqual(checkFilter({ key: "EventName", value: "" }), {});
  assert.deepEqual(checkFilter(null), {});
  assert.throws(() => checkFilter({ key: "Nope", value: "x" }));
  assert.throws(() => checkFilter({ key: "ReadOnly", value: "maybe" }));
  assert.throws(() => checkFilter({ start: "not a date" }));
  assert.throws(() => checkFilter({ start: "2026-02-01T00:00:00Z", end: "2026-01-01T00:00:00Z" }));
  assert.equal(checkFilter({ start: "2026-01-01T00:00:00Z" }).start.toISOString(), "2026-01-01T00:00:00.000Z");
});

test("CloudTrail: event rows read the record JSON", () => {
  const row = eventRow({ EventId: "e1", EventName: "DeleteBucket", EventTime: new Date("2026-01-01T00:00:00Z"), Username: "dan", Resources: [{ ResourceType: "AWS::S3::Bucket", ResourceName: "b" }], CloudTrailEvent: '{"errorCode":"AccessDenied","sourceIPAddress":"127.0.0.1"}' });
  assert.equal(row.errorCode, "AccessDenied");
  assert.equal(row.sourceIp, "127.0.0.1");
  assert.equal(row.time, "2026-01-01T00:00:00.000Z");
  assert.equal(eventRow({ CloudTrailEvent: "{bad" }).errorCode, null);
});

test("CloudTrail: selectors, bucket policy, Lake rows", () => {
  const s = buildSelectors({ management: true, readWrite: "WriteOnly", excludeKms: true, excludeRdsData: false, dataTypes: ["AWS::S3::Object"] });
  assert.equal(s.length, 2);
  assert.deepEqual(s[0].FieldSelectors[1], { Field: "readOnly", Equals: ["false"] });
  assert.deepEqual(s[0].FieldSelectors[2], { Field: "eventSource", NotEquals: ["kms.amazonaws.com"] });
  assert.throws(() => buildSelectors({ management: false, readWrite: "All", excludeKms: false, excludeRdsData: false, dataTypes: [] }));
  assert.throws(() => buildSelectors({ management: false, readWrite: "All", excludeKms: false, excludeRdsData: false, dataTypes: ["AWS::Bogus"] }));
  assert.match(selectorRows(s)[1].conditions, /resources.type equals AWS::S3::Object/);
  const policy = JSON.parse(trailBucketPolicy("b", "000000000000", "us-east-1", "t", "/logs/"));
  assert.equal(policy.Statement[1].Resource, "arn:aws:s3:::b/logs/AWSLogs/000000000000/*");
  assert.equal(policy.Statement[0].Condition.StringEquals["AWS:SourceArn"], "arn:aws:cloudtrail:us-east-1:000000000000:trail/t");
  const lr = lakeRows([[{ eventName: "A" }, { eventTime: "t" }], [{ eventName: "B" }]]);
  assert.deepEqual(lr.columns, ["eventName", "eventTime"]);
  assert.equal(lr.rows[1].eventName, "B");
});

test("CloudTrail: selectorInput reverses buildSelectors and reads basic selectors", () => {
  const input = { management: true, readWrite: "WriteOnly", excludeKms: true, excludeRdsData: false, dataTypes: ["AWS::S3::Object", "AWS::Lambda::Function"] };
  assert.deepEqual(selectorInput(buildSelectors(input), undefined), input);
  const dataOnly = { management: false, readWrite: "All", excludeKms: false, excludeRdsData: false, dataTypes: ["AWS::DynamoDB::Table"] };
  assert.deepEqual(selectorInput(buildSelectors(dataOnly), undefined), dataOnly);
  assert.deepEqual(selectorInput(undefined, [{ ReadWriteType: "ReadOnly", IncludeManagementEvents: true, DataResources: [{ Type: "AWS::S3::Object", Values: ["arn:aws:s3"] }], ExcludeManagementEventSources: ["rdsdata.amazonaws.com"] }]), {
    management: true, readWrite: "ReadOnly", excludeKms: false, excludeRdsData: true, dataTypes: ["AWS::S3::Object"],
  });
  assert.equal(selectorInput([], [{ IncludeManagementEvents: false, ReadWriteType: "All" }]).management, false);
});

test("CloudTrail: trailChanges sends only what changed", () => {
  const cur = { validation: false, multiRegion: false, kmsKey: "arn:k", sns: "" };
  assert.deepEqual(trailChanges(cur, { ...cur }), {});
  assert.deepEqual(trailChanges(cur, { ...cur, validation: true }), { EnableLogFileValidation: true });
  assert.deepEqual(trailChanges(cur, { ...cur, kmsKey: "", sns: "arn:t" }), { KmsKeyId: "", SnsTopicName: "arn:t" });
});
