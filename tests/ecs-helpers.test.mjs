import { test } from "node:test";
import assert from "node:assert/strict";
import {
  arnName, buildContainerDefinition, checkFargateSize, chunk, clusterFromArn, containerInsightsText, isEcsName, joinId,
  pairsToRecord, parseEnvLines, splitId, splitList, splitTaskDefinition, strategyText, tagRows, taskDefinitionFromJson, taskDefinitionLabel,
} from "../src/services/ecs/helpers.ts";

test("ECS ids join and split as cluster/name", () => {
  assert.equal(joinId("c1", "svc"), "c1/svc");
  assert.deepEqual(splitId("c1/svc", "service"), { cluster: "c1", name: "svc" });
  assert.throws(() => splitId("nocluster", "service"), /valid service id/);
  assert.throws(() => splitId("c1/a/b", "task"), /valid task id/);
  assert.throws(() => splitId("bad name/x", "task"), /valid task id/);
  assert.equal(isEcsName("my_cluster-1"), true);
  assert.equal(isEcsName("no spaces"), false);
});

test("ARN parsing", () => {
  assert.equal(arnName("arn:aws:ecs:us-east-1:000000000000:task/c1/abc123"), "abc123");
  assert.equal(arnName(undefined), "");
  assert.equal(clusterFromArn("arn:aws:ecs:us-east-1:000000000000:cluster/c1"), "c1");
  assert.equal(clusterFromArn("arn:aws:ecs:us-east-1:000000000000:task/c1/abc"), "c1");
  assert.equal(clusterFromArn("arn:aws:ecs:us-east-1:000000000000:service/c2/web"), "c2");
  assert.equal(clusterFromArn("arn:aws:ecs:us-east-1:000000000000:task/abc"), "");
  assert.equal(taskDefinitionLabel("arn:aws:ecs:us-east-1:000000000000:task-definition/web:3"), "web:3");
  assert.equal(taskDefinitionLabel("web:3"), "web:3");
  assert.deepEqual(splitTaskDefinition("web:3"), { family: "web", revision: 3 });
  assert.deepEqual(splitTaskDefinition("web"), { family: "web", revision: null });
  assert.throws(() => splitTaskDefinition("web:x"), /family/);
});

test("small list helpers", () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(pairsToRecord([{ name: "a", value: "1" }, { value: "x" }, { name: "b" }]), { a: "1", b: "" });
  assert.deepEqual(splitList(" a, b ,,c "), ["a", "b", "c"]);
  assert.deepEqual(splitList(null), []);
  assert.deepEqual(tagRows([{ key: "k", value: "v" }]), [{ Key: "k", Value: "v" }]);
  assert.equal(containerInsightsText([{ name: "containerInsights", value: "enhanced" }]), "Container Insights with enhanced observability");
  assert.equal(containerInsightsText([{ name: "containerInsights", value: "enabled" }]), "Container Insights");
  assert.equal(containerInsightsText(undefined), "Off");
  assert.equal(strategyText([{ capacityProvider: "FARGATE", weight: 1, base: 2 }]), "FARGATE (weight 1, base 2)");
  assert.equal(strategyText([]), null);
});

test("environment lines", () => {
  assert.deepEqual(parseEnvLines("A=1\n\n B = two=2 \n"), [{ name: "A", value: "1" }, { name: "B", value: " two=2" }]);
  assert.throws(() => parseEnvLines("noequals"), /line 1/);
  assert.throws(() => parseEnvLines("A=1\n1X=2"), /line 2/);
});

test("Fargate task sizes", () => {
  assert.equal(checkFargateSize("256", "512"), null);
  assert.equal(checkFargateSize("1024", "3072"), null);
  assert.equal(checkFargateSize("4096", "30720"), null);
  assert.match(checkFargateSize("256", "4096") ?? "", /doesn't support 4096 MiB/);
  assert.match(checkFargateSize("300", "512") ?? "", /not a Fargate task size/);
});

test("task definition JSON", () => {
  const described = {
    taskDefinition: {
      taskDefinitionArn: "arn:x", revision: 2, status: "ACTIVE", registeredAt: "2026-01-01", compatibilities: ["EC2"], requiresAttributes: [],
      family: "web", containerDefinitions: [{ name: "c", image: "nginx" }], cpu: "256",
    },
    tags: [{ key: "a", value: "b" }],
  };
  const input = taskDefinitionFromJson(JSON.stringify(described));
  assert.deepEqual(input, { family: "web", containerDefinitions: [{ name: "c", image: "nginx" }], cpu: "256", tags: [{ key: "a", value: "b" }] });
  assert.equal(taskDefinitionFromJson(JSON.stringify(described.taskDefinition), "other").family, "other");
  assert.throws(() => taskDefinitionFromJson("{"), /not valid JSON/);
  assert.throws(() => taskDefinitionFromJson("[]"), /must be an object/);
  assert.throws(() => taskDefinitionFromJson('{"containerDefinitions":[{"name":"c","image":"i"}]}'), /family/);
  assert.throws(() => taskDefinitionFromJson('{"family":"f","containerDefinitions":[]}'), /at least one/);
  assert.throws(() => taskDefinitionFromJson('{"family":"f","containerDefinitions":[{"name":"c"}]}'), /\[0\] needs/);
});

test("container definition from the form", () => {
  const def = buildContainerDefinition({
    name: "web", image: "nginx", essential: true, containerPort: 80, protocol: "tcp", environment: "A=1", healthCheck: "curl -f http://localhost/", logGroup: "/ecs/web", region: "us-east-1",
  });
  assert.deepEqual(def.portMappings, [{ containerPort: 80, protocol: "tcp", name: "web-80-tcp" }]);
  assert.deepEqual(def.environment, [{ name: "A", value: "1" }]);
  assert.deepEqual(def.healthCheck?.command, ["CMD-SHELL", "curl -f http://localhost/"]);
  assert.equal(def.logConfiguration?.options?.["awslogs-group"], "/ecs/web");
  const bare = buildContainerDefinition({ name: "w", image: "i", essential: false, containerPort: null, protocol: "tcp", environment: "", healthCheck: " ", logGroup: null, region: "us-east-1" });
  assert.deepEqual(bare, { name: "w", image: "i", essential: false });
});


