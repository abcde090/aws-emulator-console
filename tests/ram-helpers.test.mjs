import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePrincipals, parseResourceArns } from "../src/services/ram/principals.ts";

test("RAM principals and resource ARNs", () => {
  assert.deepEqual(parsePrincipals("111122223333\narn:aws:organizations::111122223333:ou/o-abc/ou-1, 111122223333"), ["111122223333", "arn:aws:organizations::111122223333:ou/o-abc/ou-1"]);
  assert.deepEqual(parsePrincipals("arn:aws:iam::111122223333:role/r elasticmapreduce.amazonaws.com"), ["arn:aws:iam::111122223333:role/r", "elasticmapreduce.amazonaws.com"]);
  assert.throws(() => parsePrincipals("1234"));
  assert.deepEqual(parseResourceArns("arn:aws:ec2:us-east-1:000000000000:subnet/subnet-1"), ["arn:aws:ec2:us-east-1:000000000000:subnet/subnet-1"]);
  assert.throws(() => parseResourceArns("subnet-1"));
  assert.deepEqual(parseResourceArns(undefined), []);
});

