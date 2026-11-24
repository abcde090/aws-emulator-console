import { test } from "node:test";
import assert from "node:assert/strict";
import { deleteConfirmation, emptyValue, initialValues, isFieldVisible, showIfMatches, visibleValues } from "../src/console/form-state.ts";
import { fillHref, statusTone } from "../src/console/format.ts";
import { applyInitialValues, detailPath, idFromSegments, navHref, resolveFields, toResourceMeta, toServiceMeta, UNAVAILABLE_ACTIONS_KEY, unavailableActions, hasAvailabilityChecks } from "../src/console/meta.ts";
import { orderTabIds } from "../src/console/tabs.ts";
import { DELETE_TARGET, pageActionTarget } from "../src/console/targets.ts";
import { validateValues } from "../src/console/validate.ts";
import { clientsIn, isValidRegion, SERVICE_KEYS } from "../src/lib/aws.ts";
import { sdkCallToIam } from "../src/lib/iam-action.ts";

const opts = [{ value: "snap-1", label: "snap-1" }, { value: "snap-2", label: "snap-2" }];

test("optional selects start empty; required selects keep the first option", () => {
  assert.equal(emptyValue({ name: "s", label: "S", kind: "select", options: opts }), "");
  assert.equal(emptyValue({ name: "s", label: "S", kind: "select", required: true, options: opts }), "snap-1");
  assert.equal(emptyValue({ name: "s", label: "S", kind: "select", required: true, options: [] }), "");
  assert.equal(emptyValue({ name: "r", label: "R", kind: "radio", options: opts }), "snap-1");
  assert.deepEqual(initialValues([{ name: "s", label: "S", kind: "select", options: opts, default: "snap-2" }]), { s: "snap-2" });
  // What the form submits for an untouched optional select is nothing.
  const fields = [{ name: "snapshot", label: "Snapshot", kind: "select", options: opts }];
  const checked = validateValues(fields, visibleValues(fields, initialValues(fields)));
  assert.deepEqual(checked, { ok: true, data: { snapshot: "" } });
});

test("showIf takes one value or a list, and hidden parents hide their dependants", () => {
  assert.equal(showIfMatches({ field: "a", equals: ["x", "y"] }, "y"), true);
  assert.equal(showIfMatches({ field: "a", equals: ["x", "y"] }, "z"), false);
  assert.equal(showIfMatches({ field: "a", equals: true }, true), true);
  const fields = [
    { name: "engine", label: "Engine", kind: "select", required: true, options: [{ value: "mysql", label: "MySQL" }, { value: "postgres", label: "PostgreSQL" }, { value: "aurora", label: "Aurora" }] },
    { name: "useSnapshot", label: "Use snapshot", kind: "checkbox", showIf: { field: "engine", equals: ["mysql", "postgres"] } },
    { name: "snapshot", label: "Snapshot", kind: "text", required: true, showIf: { field: "useSnapshot", equals: true } },
  ];
  const values = { engine: "aurora", useSnapshot: true, snapshot: "" };
  assert.equal(isFieldVisible(fields[1], values, fields), false);
  assert.equal(isFieldVisible(fields[2], values, fields), false, "parent hidden, so the dependant is hidden");
  assert.equal(isFieldVisible(fields[2], values), true, "without the field list only the direct rule counts");
  assert.deepEqual(visibleValues(fields, values), { engine: "aurora" });
  // The server agrees: the hidden required field is not demanded.
  assert.deepEqual(validateValues(fields, values), { ok: true, data: { engine: "aurora" } });
  assert.match(validateValues(fields, { engine: "mysql", useSnapshot: true, snapshot: "" }).error, /Snapshot is required/);
  const cyclic = [
    { name: "a", label: "A", kind: "text", showIf: { field: "b", equals: "" } },
    { name: "b", label: "B", kind: "text", showIf: { field: "a", equals: "" } },
  ];
  assert.equal(isFieldVisible(cyclic[0], { a: "", b: "" }, cyclic), false);
});

test("password fields are masked values that never appear in errors", () => {
  const fields = [{ name: "pw", label: "Master password", kind: "password", required: true, validate: { pattern: "[^/@\" ]{8,41}", message: "8-41 printable characters, no / @ \" or space" } }];
  const bad = validateValues(fields, { pw: "has space secret" });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.includes("has space secret"), false);
  assert.deepEqual(validateValues(fields, { pw: " keeps-spaces1 " }).ok, false);
  assert.deepEqual(validateValues(fields, { pw: "Sup3r-secret" }), { ok: true, data: { pw: "Sup3r-secret" } });
  assert.equal(emptyValue(fields[0]), "");
});

test("numbers accept decimals", () => {
  const fields = [{ name: "n", label: "N", kind: "number" }];
  assert.deepEqual(validateValues(fields, { n: "0.25" }), { ok: true, data: { n: 0.25 } });
  assert.deepEqual(validateValues(fields, { n: 1.5 }), { ok: true, data: { n: 1.5 } });
});

test("status tones", () => {
  for (const s of ["Deployed", "Successful", "Succeeded", "Available", "Active", "InService", "ACTIVE", "available"]) assert.equal(statusTone(s), "success", s);
  for (const s of ["InProgress", "IN_PROGRESS", "Pending", "Creating", "Updating", "Deleting", "Modifying"]) assert.equal(statusTone(s), "pending", s);
  for (const s of ["Failed", "Error", "CREATE_FAILED", "UPDATE_ROLLBACK_COMPLETE"]) assert.equal(statusTone(s), "error", s);
  for (const s of ["Stopped", "Superseded", "Abandoned", "Deleted", "Inactive"]) assert.equal(statusTone(s), "warning", s);
  assert.equal(statusTone("whatever"), "neutral");
});

test("link templates fill from the row, URL-encoded, and only for local paths", () => {
  const row = { cluster: "prod", serviceName: "web api", n: 3 };
  assert.equal(fillHref("/ecs/services/{cluster}/{serviceName}", row), "/ecs/services/prod/web%20api");
  assert.equal(fillHref("/x/{id}", { id: "a/b?c" }), "/x/a%2Fb%3Fc");
  assert.equal(fillHref("/x/{missing}", row), null);
  assert.equal(fillHref("/x/{n}", row), "/x/3");
  assert.equal(fillHref("https://evil.example/{cluster}", row), null);
  assert.equal(fillHref("//evil.example/{cluster}", row), null);
  assert.equal(fillHref(undefined, row), null);
});

test("ids with slashes round-trip through the generic route", () => {
  const path = detailPath("logs", { id: "groups" }, "/aws/lambda/fn");
  assert.equal(path, "/logs/groups/%2Faws%2Flambda%2Ffn");
  assert.equal(idFromSegments(path.split("/").slice(3)), "/aws/lambda/fn");
  assert.equal(idFromSegments(["prod", "web%20api"]), "prod/web api");
  assert.equal(idFromSegments(["a%2Fb"]), "a/b");
  assert.equal(idFromSegments(["100%"]), "100%");
});

test("delete confirmation uses the name when there is one", () => {
  assert.equal(deleteConfirmation("name", "i-123", "web"), "web");
  assert.equal(deleteConfirmation("name", "i-123", undefined), "i-123");
  assert.equal(deleteConfirmation("name", "i-123", ""), "i-123");
  assert.equal(deleteConfirmation("delete", "i-123", "web"), "delete");
});

test("hand-built tabs go first by default, or after a named definition tab", () => {
  assert.deepEqual(orderTabIds(["a", "b"], [{ id: "x" }]), ["x", "a", "b"]);
  assert.deepEqual(orderTabIds(["a", "b"], [{ id: "x", after: "a" }, { id: "y" }, { id: "z", after: "$end" }]), ["y", "a", "x", "b", "z"]);
  assert.deepEqual(orderTabIds([], [{ id: "x", after: "a" }]), ["x"]);
});

test("prefill, per-row availability, page actions, delete fields and extra nav reach the metadata", async () => {
  const seen = [];
  const def = {
    id: "svc", name: "Svc", category: "C", description: "d",
    extraNav: [{ label: "Dashboard", href: "dashboard" }, { label: "Other", href: "/x/y" }],
    resources: [{
      id: "things", name: "Things", singular: "thing", idField: "id", columns: [], list: async () => [],
      actions: [
        { id: "start", label: "Start", availableFor: (row) => row.state === "stopped", run: async () => {} },
        { id: "boom", label: "Boom", availableFor: () => { throw new Error("x"); }, run: async () => {} },
        { id: "edit", label: "Edit", fields: [{ name: "a", label: "A", kind: "text" }, { name: "pw", label: "P", kind: "password" }], initialValues: async () => ({ a: "current", pw: "secret" }), run: async () => {} },
      ],
      pageActions: [{ id: "sample", label: "Generate sample findings", run: async () => ({ message: "ok" }) }],
      delete: { confirmText: "name", fields: [{ name: "final", label: "Final snapshot", kind: "checkbox" }], run: async () => {} },
    }],
  };
  const meta = toServiceMeta(def);
  assert.deepEqual(meta.extraNav, [{ label: "Dashboard", href: "/svc/dashboard" }, { label: "Other", href: "/x/y" }]);
  assert.equal(navHref("svc", { label: "a", href: "b/c" }), "/svc/b/c");
  const r = meta.resources[0];
  assert.deepEqual(r.pageActions, [{ id: "sample", label: "Generate sample findings", danger: undefined, confirm: undefined, hasFields: false }]);
  assert.equal(r.deleteHasFields, true);
  assert.equal(r.actions[0].conditional, true);
  assert.equal(r.actions[2].conditional, undefined);
  assert.deepEqual(toResourceMeta({ ...def.resources[0], delete: undefined }).deleteHasFields, false);
  assert.deepEqual(unavailableActions(def.resources[0].actions, { state: "running" }), ["start"]);
  assert.deepEqual(unavailableActions(def.resources[0].actions, { state: "stopped" }), []);
  assert.equal(UNAVAILABLE_ACTIONS_KEY.startsWith("__"), true);
  // DeleteDef.availableFor: false adds "$delete" (DELETE_TARGET) so the list and detail hide Delete for that row.
  const del = { availableFor: (row) => row.name !== "Default", run: async () => {} };
  assert.deepEqual(unavailableActions(def.resources[0].actions, { state: "stopped", name: "Default" }, del), ["$delete"]);
  assert.deepEqual(unavailableActions(def.resources[0].actions, { state: "running", name: "Default" }, del), ["start", "$delete"]);
  assert.deepEqual(unavailableActions(undefined, { name: "mine" }, del), []);
  assert.deepEqual(unavailableActions(undefined, { name: "x" }, { availableFor: () => { throw new Error("bad row"); } }), []);
  assert.equal(hasAvailabilityChecks({ delete: del }), true);
  assert.equal(hasAvailabilityChecks({ actions: [{ id: "a" }], delete: { run: async () => {} } }), false);

  const fields = await resolveFields({}, [{ name: "item", label: "Item", kind: "select", options: async (_ctx, id) => { seen.push(id); return [{ value: `${id}-1`, label: "one" }]; } }], "res-9");
  assert.deepEqual(seen, ["res-9"]);
  assert.deepEqual(fields[0].options, [{ value: "res-9-1", label: "one" }]);
  const prefilled = applyInitialValues(await resolveFields({}, def.resources[0].actions[2].fields), { a: "current", pw: "secret", unknown: "x" });
  assert.equal(prefilled[0].default, "current");
  assert.equal(prefilled[1].default, undefined, "passwords are never prefilled");
  assert.equal(DELETE_TARGET, "$delete");
  assert.equal(pageActionTarget("sample"), "$page:sample");
});

test("region-scoped clients: valid names only, same client keys, cached", () => {
  assert.equal(isValidRegion("us-west-2"), true);
  assert.equal(isValidRegion("us-gov-west-1"), true);
  assert.equal(isValidRegion("evil.com"), false);
  assert.equal(isValidRegion("us-west-2/../x"), false);
  assert.throws(() => clientsIn("not a region"), /not a valid AWS Region/);
  const west = clientsIn("us-west-2");
  assert.equal(clientsIn("us-west-2"), west);
  assert.deepEqual(Object.keys(west).sort(), [...SERVICE_KEYS].sort());
});

test("new clients map to their IAM prefixes", () => {
  const cases = [
    ["Route53ResolverClient", "ListResolverEndpointsCommand", "route53resolver:ListResolverEndpoints"],
    ["PipesClient", "ListPipesCommand", "pipes:ListPipes"],
    ["CognitoIdentityClient", "ListIdentityPoolsCommand", "cognito-identity:ListIdentityPools"],
    ["DAXClient", "DescribeClustersCommand", "dax:DescribeClusters"],
    ["DynamoDBStreamsClient", "ListStreamsCommand", "dynamodb:ListStreams"],
    ["ApplicationAutoScalingClient", "DescribeScalableTargetsCommand", "application-autoscaling:DescribeScalableTargets"],
    ["RedshiftDataClient", "ListStatementsCommand", "redshift-data:ListStatements"],
    ["ServiceDiscoveryClient", "ListNamespacesCommand", "servicediscovery:ListNamespaces"],
    ["AccessAnalyzerClient", "ListAnalyzersCommand", "access-analyzer:ListAnalyzers"],
  ];
  for (const [client, command, action] of cases) assert.equal(sdkCallToIam(client, command, {})?.[0]?.action, action, client);
});
