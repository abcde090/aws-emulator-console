import { test } from "node:test";
import assert from "node:assert/strict";
import { ENV_NAME, environmentOptionSettings, joinId, logLocation, splitId, tagList, tierLabel } from "../src/services/elasticbeanstalk/helpers.ts";

test("Beanstalk composite ids split at the first slash", () => {
  assert.equal(joinId("app", "v1"), "app/v1");
  assert.deepEqual(splitId("my app/v1.0"), { app: "my app", child: "v1.0" });
  assert.throws(() => splitId("app"));
  assert.throws(() => splitId("app/"));
});

test("Beanstalk create environment option settings", () => {
  assert.deepEqual(environmentOptionSettings({}), []);
  const s = environmentOptionSettings({
    tier: "WebServer", preset: "LoadBalanced", loadBalancerType: "application", serviceRole: "svc", instanceProfile: "prof",
    vpcId: "vpc-1", subnets: ["subnet-a", "subnet-b"], publicIp: true, instanceTypes: "t3.micro, t3.small", minSize: 2, maxSize: 4,
    healthReporting: "enhanced", deploymentPolicy: "Rolling", managedUpdates: true, updateWindow: "", updateLevel: "patch",
  });
  const get = (ns, o) => s.find((x) => x.Namespace === ns && x.OptionName === o)?.Value;
  assert.equal(get("aws:elasticbeanstalk:environment", "EnvironmentType"), "LoadBalanced");
  assert.equal(get("aws:elasticbeanstalk:environment", "LoadBalancerType"), "application");
  assert.equal(get("aws:elasticbeanstalk:environment", "ServiceRole"), "svc");
  assert.equal(get("aws:autoscaling:launchconfiguration", "IamInstanceProfile"), "prof");
  assert.equal(get("aws:ec2:vpc", "Subnets"), "subnet-a,subnet-b");
  assert.equal(get("aws:ec2:vpc", "AssociatePublicIpAddress"), "true");
  assert.equal(get("aws:ec2:instances", "InstanceTypes"), "t3.micro,t3.small");
  assert.equal(get("aws:autoscaling:asg", "MinSize"), "2");
  assert.equal(get("aws:elasticbeanstalk:managedactions", "PreferredStartTime"), "Sun:10:00");
  assert.equal(get("aws:elasticbeanstalk:managedactions:platformupdate", "UpdateLevel"), "patch");
  // Worker environments get no web-server preset; turning managed updates off is explicit.
  const w = environmentOptionSettings({ tier: "Worker", preset: "LoadBalanced", managedUpdates: false, publicIp: true });
  assert.deepEqual(w, [{ Namespace: "aws:elasticbeanstalk:managedactions", OptionName: "ManagedActionsEnabled", Value: "false" }]);
});

test("Beanstalk log locations come from presigned URLs", () => {
  assert.deepEqual(logLocation("https://127.0.0.1:9297/elasticbeanstalk-us-east-1-000000000000/resources/environments/logs/tail/e-1/i-1/eb-activity.log?X-Amz-Expires=900"), {
    bucket: "elasticbeanstalk-us-east-1-000000000000",
    key: "resources/environments/logs/tail/e-1/i-1/eb-activity.log",
  });
  assert.deepEqual(logLocation("https://my-bucket.s3.us-east-1.amazonaws.com/a/b%20c.log"), { bucket: "my-bucket", key: "a/b c.log" });
  assert.equal(logLocation("not a url"), null);
  assert.equal(logLocation("https://host/"), null);
});

test("Beanstalk small helpers", () => {
  assert.deepEqual(tagList([{ Key: "a", Value: "1" }, { Key: "", Value: "" }]), [{ Key: "a", Value: "1" }]);
  assert.deepEqual(tagList("x"), []);
  assert.equal(tierLabel({ Name: "Worker", Type: "SQS/HTTP" }), "Worker");
  assert.equal(tierLabel({ Name: "WebServer" }), "Web server");
  assert.equal(tierLabel(undefined), null);
  const re = new RegExp(`^(?:${ENV_NAME})$`);
  assert.ok(re.test("my-env-1"));
  assert.ok(!re.test("-bad"));
  assert.ok(!re.test("bad-"));
  assert.ok(!re.test("abc"));
});
