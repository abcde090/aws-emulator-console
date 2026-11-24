import { test } from "node:test";
import assert from "node:assert/strict";
import { domainList } from "../src/services/acm/domains.ts";

test("additional certificate names", () => {
  assert.deepEqual(domainList("www.example.com\nexample.com, *.example.com", "example.com"), ["www.example.com", "*.example.com"]);
  assert.deepEqual(domainList(undefined, "a.com"), []);
  assert.throws(() => domainList("not a domain", "a.com"));
});

import { matchingZone } from "../src/services/acm/domains.ts";

test("validation records go to the longest matching public hosted zone", () => {
  const zones = [
    { id: "Z1", name: "example.com.", privateZone: false },
    { id: "Z2", name: "app.example.com.", privateZone: false },
    { id: "Z3", name: "app.example.com.", privateZone: true },
  ];
  assert.equal(matchingZone("www.app.example.com", zones)?.id, "Z2");
  assert.equal(matchingZone("*.example.com", zones)?.id, "Z1");
  assert.equal(matchingZone("example.com", zones)?.id, "Z1");
  assert.equal(matchingZone("badexample.com", zones), undefined);
  assert.equal(matchingZone("x.other.org", zones), undefined);
});
