import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAwsCommand } from "../src/lib/cli-args.ts";

test("splits a plain aws command into arguments", () => {
  assert.deepEqual(parseAwsCommand("aws s3 ls"), { ok: true, args: ["s3", "ls"] });
});

test("keeps quoted values as one argument", () => {
  const r = parseAwsCommand(`aws dynamodb put-item --table-name T --item '{"id":{"S":"a b"}}'`);
  assert.deepEqual(r, { ok: true, args: ["dynamodb", "put-item", "--table-name", "T", "--item", '{"id":{"S":"a b"}}'] });
});

test("supports double quotes and backslash escapes", () => {
  assert.deepEqual(parseAwsCommand('aws s3 cp "my file.txt" s3://b/a\\ b'), {
    ok: true,
    args: ["s3", "cp", "my file.txt", "s3://b/a b"],
  });
});

test("collapses repeated whitespace", () => {
  assert.deepEqual(parseAwsCommand("  aws   s3   rb  s3://b "), { ok: true, args: ["s3", "rb", "s3://b"] });
});

test("rejects anything that is not an aws command", () => {
  for (const cmd of ["cat ~/.aws/credentials", "rm -rf /", "awsx s3 ls", "bash -c 'aws s3 ls'", ""]) {
    assert.equal(parseAwsCommand(cmd).ok, false, cmd);
  }
});

test("rejects shell operators outside quotes", () => {
  for (const cmd of [
    "aws s3 ls; cat /etc/passwd",
    "aws s3 ls | grep x",
    "aws s3 ls && id",
    "aws s3 ls > out.txt",
    "aws s3 ls $(id)",
    "aws s3 ls `id`",
    "aws s3 ls\nid",
  ]) {
    assert.equal(parseAwsCommand(cmd).ok, false, JSON.stringify(cmd));
  }
});

test("allows shell characters inside single quotes, where they are plain text", () => {
  assert.deepEqual(parseAwsCommand("aws sqs send-message --message-body 'a;b|c $(x)'"), {
    ok: true,
    args: ["sqs", "send-message", "--message-body", "a;b|c $(x)"],
  });
});

test("rejects $ and backticks inside double quotes, where a shell would expand them", () => {
  assert.equal(parseAwsCommand('aws s3 ls "$(id)"').ok, false);
});

test("rejects unterminated quotes", () => {
  assert.equal(parseAwsCommand("aws s3 ls 'oops").ok, false);
});

test("inside double quotes a backslash is kept unless it escapes a quote or backslash, as in bash", () => {
  const r = parseAwsCommand('aws sqs send-message --message-body "a\\nb \\"q\\" c\\\\d"');
  assert.equal(r.ok, true);
  assert.equal(r.args.at(-1), 'a\\nb "q" c\\d');
});
