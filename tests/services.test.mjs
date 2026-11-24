import { test } from "node:test";
import assert from "node:assert/strict";
import { SERVICES, getResource, serviceCatalog } from "../src/console/registry.ts";
import { epochSecondsToIso, num, parseJsonAttribute, queueNameFromUrl } from "../src/services/sqs/helpers.ts";
import { attachmentHeader, checkFolderName, displayName, isBucketName, normalisePrefix, prefixCrumbs, uploadKey } from "../src/services/s3/object-paths.ts";
import { optionalRead } from "../src/console/secondary.ts";

test("every registered service follows the engine contract", () => {
  const ids = new Set();
  for (const s of SERVICES) {
    assert.match(s.id, /^[a-z0-9-]+$/);
    assert.equal(ids.has(s.id), false, `duplicate ${s.id}`);
    ids.add(s.id);
    assert.ok(s.name && s.category && s.description, s.id);
    assert.ok(s.resources.length > 0, s.id);
    for (const r of s.resources) {
      assert.match(r.id, /^[a-z0-9-]+$/);
      assert.notEqual(r.id, "create");
      assert.equal(typeof r.list, "function");
      assert.ok(r.columns.some((c) => c.kind === "link"), `${s.id}/${r.id} needs a link column`);
      const actionIds = (r.actions ?? []).map((a) => a.id);
      assert.equal(new Set(actionIds).size, actionIds.length, `${s.id}/${r.id} has duplicate action ids`);
      assert.equal(actionIds.includes("create"), false);
      for (const a of r.actions ?? []) if (a.hidden) assert.ok((a.fields ?? []).length > 0, `hidden action ${a.id} must declare its fields`);
      const pageIds = (r.pageActions ?? []).map((a) => a.id);
      assert.equal(new Set(pageIds).size, pageIds.length, `${s.id}/${r.id} has duplicate page action ids`);
      // showIf must name a field of the same form (create, one action, a page action or the delete dialog).
      const forms = [r.create?.fields, ...(r.actions ?? []).map((a) => a.fields), ...(r.pageActions ?? []).map((a) => a.fields), r.delete?.fields];
      for (const form of forms) {
        for (const f of form ?? []) {
          if (f.showIf) assert.ok([...(r.create?.fields ?? []), ...(r.actions ?? []).flatMap((a) => a.fields ?? []), ...(form ?? [])].some((g) => g.name === f.showIf.field), `${f.name} depends on a missing field`);
        }
      }
      for (const c of [...r.columns]) if (c.href) assert.match(c.href, /^\/[^/]/, `${s.id}/${r.id} column ${c.key} href must be a local path`);
    }
  }
  assert.ok(getResource("sqs", "queues"));
  assert.equal(getResource("sqs", "nope"), null);
  // The catalog lists exactly the built services (those with resources), each once.
  const catalogIds = serviceCatalog().map((s) => s.id);
  assert.ok(catalogIds.includes("s3") && catalogIds.includes("sqs"));
  assert.equal(new Set(catalogIds).size, catalogIds.length);
  assert.ok(serviceCatalog().every((s) => s.firstResource !== null));
});

test("SQS attribute helpers", () => {
  assert.equal(num("12"), 12);
  assert.equal(num("x"), null);
  assert.equal(epochSecondsToIso("0"), "1970-01-01T00:00:00.000Z");
  assert.equal(queueNameFromUrl("https://127.0.0.1:9297/000000000000/jobs.fifo"), "jobs.fifo");
  assert.deepEqual(parseJsonAttribute('{"a":1}'), { a: 1 });
  assert.equal(parseJsonAttribute(""), null);
});

test("S3 object browser paths", () => {
  assert.deepEqual(prefixCrumbs("a/b/"), [{ label: "a", prefix: "a/" }, { label: "b", prefix: "a/b/" }]);
  assert.equal(displayName("a/b/c.txt", "a/b/"), "c.txt");
  assert.equal(normalisePrefix("a"), "a/");
  assert.equal(normalisePrefix(""), "");
  assert.equal(normalisePrefix(5), "");
  assert.deepEqual(checkFolderName("docs/", "a/"), { ok: true, name: "docs" });
  assert.equal(checkFolderName("a/b", "").ok, false);
  assert.equal(checkFolderName("..", "").ok, false);
  assert.equal(checkFolderName("  ", "").ok, false);
  assert.equal(uploadKey("p/", "C:\\Users\\me\\file.txt"), "p/file.txt");
  assert.equal(uploadKey("p/", ".."), null);
  assert.equal(isBucketName("my-bucket"), true);
  assert.equal(isBucketName("My_Bucket"), false);
  assert.equal(isBucketName("../x"), false);
  assert.equal(attachmentHeader('dir/we"ird é.txt'), `attachment; filename="we_ird _.txt"; filename*=UTF-8''we%22ird%20%C3%A9.txt`);
});

test("S3 settings that are not set read as missing, other errors as errors", async () => {
  const fail = (name) => async () => { const e = new Error("x"); e.name = name; throw e; };
  assert.deepEqual(await optionalRead(async () => 1, []), { kind: "value", value: 1 });
  assert.deepEqual(await optionalRead(fail("NoSuchBucketPolicy"), ["NoSuchBucketPolicy"]), { kind: "missing" });
  assert.deepEqual(await optionalRead(fail("NotImplemented"), ["NoSuchBucketPolicy"]), { kind: "error", error: "NotImplemented: x" });
});
