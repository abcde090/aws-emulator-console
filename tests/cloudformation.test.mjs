import { test } from "node:test";
import assert from "node:assert/strict";
import {
  changeDetailRows,
  changeRows,
  driftRows,
  formatTemplate,
  isStackName,
  parameterFields,
  parameterList,
  parseAccounts,
  parseParameters,
  stackNameFromId,
  templateSource,
} from "../src/services/cloudformation/helpers.ts";

test("CloudFormation stack names", () => {
  assert.equal(isStackName("my-stack-1"), true);
  assert.equal(isStackName("1stack"), false);
  assert.equal(isStackName("a_b"), false);
  assert.equal(isStackName("a".repeat(129)), false);
});

test("CloudFormation template sources", () => {
  assert.deepEqual(templateSource("body", "{}", ""), { TemplateBody: "{}" });
  assert.deepEqual(templateSource("url", "", " https://b.s3.amazonaws.com/t.json "), { TemplateURL: "https://b.s3.amazonaws.com/t.json" });
  assert.deepEqual(templateSource("current", "", "", true), { UsePreviousTemplate: true });
  assert.throws(() => templateSource("current", "", ""), /Choose a template/);
  assert.throws(() => templateSource("url", "", "http://x"), /https/);
  assert.throws(() => templateSource("body", "  ", ""), /Paste/);
  assert.throws(() => templateSource("body", "x".repeat(51201), ""), /51,200/);
  assert.throws(() => templateSource("nope", "", ""), /source/);
});

test("CloudFormation parameters parse from both JSON forms", () => {
  assert.deepEqual(parseParameters(""), []);
  assert.deepEqual(parseParameters(null), []);
  assert.deepEqual(parseParameters('{"A":"1","B":2}'), [{ ParameterKey: "A", ParameterValue: "1" }, { ParameterKey: "B", ParameterValue: "2" }]);
  assert.deepEqual(parseParameters('[{"ParameterKey":"A","UsePreviousValue":true},{"ParameterKey":"B","ParameterValue":"x"}]'), [
    { ParameterKey: "A", UsePreviousValue: true },
    { ParameterKey: "B", ParameterValue: "x" },
  ]);
  assert.throws(() => parseParameters("{"), /valid JSON/);
  assert.throws(() => parseParameters('[{"ParameterValue":"x"}]'), /ParameterKey/);
  assert.throws(() => parseParameters('{"A":{"b":1}}'), /text/);
  assert.throws(() => parseParameters("5"), /object/);
});

test("CloudFormation account lists", () => {
  assert.deepEqual(parseAccounts("000000000000, 111111111111\n000000000000"), ["000000000000", "111111111111"]);
  assert.throws(() => parseAccounts("123"), /12-digit/);
  assert.throws(() => parseAccounts(""), /at least one/);
});

test("CloudFormation ids and templates", () => {
  assert.equal(stackNameFromId("arn:aws:cloudformation:us-east-1:0:stack/web/abc-123"), "web");
  assert.equal(stackNameFromId(null), null);
  assert.equal(formatTemplate('{"a":1}'), '{\n  "a": 1\n}');
  assert.equal(formatTemplate("Resources: {}\n"), "Resources: {}\n");
  assert.equal(formatTemplate({ a: 1 }), '{\n  "a": 1\n}');
  assert.equal(formatTemplate(undefined), "");
});

const changes = [
  {
    Type: "Resource",
    ResourceChange: {
      Action: "Modify", LogicalResourceId: "Q", PhysicalResourceId: "url", ResourceType: "AWS::SQS::Queue", Replacement: "True", Scope: ["Properties"],
      Details: [
        { Target: { Attribute: "Properties", Name: "QueueName", RequiresRecreation: "Always" }, Evaluation: "Static", ChangeSource: "ParameterReference", CausingEntity: "QName" },
        { Target: { Attribute: "Properties", Name: "VisibilityTimeout", RequiresRecreation: "Never" }, Evaluation: "Static", ChangeSource: "DirectModification" },
      ],
    },
  },
  { Type: "Resource", ResourceChange: { Action: "Add", LogicalResourceId: "T", ResourceType: "AWS::SNS::Topic" } },
];

test("CloudFormation change set rows", () => {
  const rows = changeRows(changes);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].replacement, "True");
  assert.equal(rows[0].scope, "Properties");
  assert.equal(rows[1].action, "Add");
  assert.equal(rows[1].replacement, "-");
  const details = changeDetailRows(changes);
  assert.equal(details.length, 2);
  assert.equal(details[0].causingEntity, "QName");
  assert.equal(details[1].requiresRecreation, "Never");
  assert.deepEqual(changeRows(null), []);
  assert.deepEqual(changeDetailRows("x"), []);
});

test("CloudFormation drift rows", () => {
  const rows = driftRows([{ LogicalResourceId: "Q", StackResourceDriftStatus: "MODIFIED", PropertyDifferences: [{ PropertyPath: "/VisibilityTimeout", ExpectedValue: "60", ActualValue: "99", DifferenceType: "NOT_EQUAL" }] }, { LogicalResourceId: "T", StackResourceDriftStatus: "IN_SYNC" }]);
  assert.equal(rows[0].differences, "/VisibilityTimeout NOT_EQUAL: expected 60, actual 99");
  assert.equal(rows[1].differences, null);
  assert.deepEqual(driftRows(undefined), []);
});

test("CloudFormation parameter fields and values", () => {
  const params = [
    { key: "Env", type: "String", defaultValue: "dev", description: "Stage", noEcho: false, allowedValues: ["dev", "prod"] },
    { key: "Name", type: "String", defaultValue: null, description: null, noEcho: false, allowedValues: [] },
    { key: "Secret", type: "String", defaultValue: null, description: null, noEcho: true, allowedValues: [] },
  ];
  const create = parameterFields(params);
  assert.equal(create[0].kind, "select");
  assert.equal(create[0].default, "dev");
  assert.equal(create[1].kind, "text");
  assert.equal(create[1].default, "");
  const current = [{ key: "Env", value: "prod" }, { key: "Name", value: "n" }, { key: "Secret", value: "****" }];
  const update = parameterFields(params, current);
  assert.equal(update[0].default, "prod");
  assert.equal(update[1].default, "n");
  assert.equal(update[2].default, "");
  assert.match(update[2].help, /keep the existing value/);
  assert.deepEqual(parameterList(params, { "param:Env": "prod", "param:Name": "x", "param:Secret": "" }, current), [
    { ParameterKey: "Env", ParameterValue: "prod" },
    { ParameterKey: "Name", ParameterValue: "x" },
    { ParameterKey: "Secret", UsePreviousValue: true },
  ]);
  assert.deepEqual(parameterList(params, { "param:Secret": "" }), [
    { ParameterKey: "Env", ParameterValue: "" },
    { ParameterKey: "Name", ParameterValue: "" },
    { ParameterKey: "Secret", ParameterValue: "" },
  ]);
});
