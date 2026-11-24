import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkPathPart,
  checkRouteKey,
  childPath,
  formatStageVariables,
  functionArnFromUri,
  functionName,
  invokeUrlFromExport,
  isHttpMethod,
  lambdaInvocationUri,
  orderTree,
  parseStageVariables,
  variablePatches,
} from "../src/services/apigateway/helpers.ts";
import { splitApiStage, tagsRecord } from "../src/services/apigateway/common.ts";

const FN = "arn:aws:lambda:us-east-1:000000000000:function:hello";

test("Lambda integration URIs round-trip", () => {
  const uri = lambdaInvocationUri("us-east-1", FN);
  assert.equal(uri, `arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/${FN}/invocations`);
  assert.equal(functionArnFromUri(uri), FN);
  assert.equal(functionArnFromUri("https://example.com"), null);
  assert.equal(functionArnFromUri(undefined), null);
  assert.equal(functionName(FN), "hello");
});

test("invoke URL from an OpenAPI export", () => {
  const doc = { servers: [{ url: "https://127.0.0.1:9297/_aws/execute-api/abc/{basePath}", variables: { basePath: { default: "dev" } } }] };
  assert.equal(invokeUrlFromExport(doc), "https://127.0.0.1:9297/_aws/execute-api/abc/dev");
  assert.equal(invokeUrlFromExport({ servers: [] }), null);
  assert.equal(invokeUrlFromExport(null), null);
  assert.equal(invokeUrlFromExport({ servers: [{ url: "https://x/{a}" }] }), "https://x/{a}");
});

test("stage variables parse, format and diff", () => {
  assert.deepEqual(parseStageVariables("a=1\n\n b = x/y "), { ok: true, vars: { a: "1", b: "x/y" } });
  assert.equal(parseStageVariables("nope").ok, false);
  assert.equal(parseStageVariables("bad-name=1").ok, false);
  assert.equal(parseStageVariables("a=has space").ok, false);
  assert.deepEqual(parseStageVariables(""), { ok: true, vars: {} });
  assert.equal(formatStageVariables({ a: "1", b: "2" }), "a=1\nb=2");
  assert.equal(formatStageVariables(undefined), "");
  assert.deepEqual(variablePatches({ a: "1", b: "2" }, { b: "3", c: "4" }), [
    { op: "remove", path: "/variables/a" },
    { op: "replace", path: "/variables/b", value: "3" },
    { op: "replace", path: "/variables/c", value: "4" },
  ]);
  assert.deepEqual(variablePatches({ a: "1" }, { a: "1" }), []);
});

test("path parts and route keys", () => {
  assert.equal(checkPathPart("items"), null);
  assert.equal(checkPathPart("{id}"), null);
  assert.equal(checkPathPart("{proxy+}"), null);
  assert.notEqual(checkPathPart("a/b"), null);
  assert.notEqual(checkPathPart(""), null);
  assert.equal(checkRouteKey("GET /items/{id}", "HTTP"), null);
  assert.equal(checkRouteKey("$default", "HTTP"), null);
  assert.notEqual(checkRouteKey("FETCH /x", "HTTP"), null);
  assert.notEqual(checkRouteKey("GET items", "HTTP"), null);
  assert.equal(checkRouteKey("$connect", "WEBSOCKET"), null);
  assert.equal(checkRouteKey("sendmessage", "WEBSOCKET"), null);
  assert.notEqual(checkRouteKey("send message", "WEBSOCKET"), null);
  assert.equal(isHttpMethod("ANY"), true);
  assert.equal(isHttpMethod("get"), false);
});

test("resource tree order and depth", () => {
  const tree = orderTree([
    { id: "c", path: "/items/{id}" },
    { id: "r", path: "/" },
    { id: "b", path: "/items" },
    { id: "a", path: "/accounts" },
  ]);
  assert.deepEqual(tree.map((t) => [t.id, t.depth]), [["r", 0], ["a", 1], ["b", 1], ["c", 2]]);
  assert.equal(childPath("/", "x"), "/x");
  assert.equal(childPath("/a", "x"), "/a/x");
});

test("API stage choices and tags", () => {
  assert.deepEqual(splitApiStage("abc/dev"), { apiId: "abc", stage: "dev" });
  assert.throws(() => splitApiStage("abc"));
  assert.throws(() => splitApiStage(""));
  assert.deepEqual(tagsRecord([{ Key: "a", Value: "1" }]), { a: "1" });
  assert.equal(tagsRecord([]), undefined);
});
