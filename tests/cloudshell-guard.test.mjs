import { test } from "node:test";
import assert from "node:assert/strict";
import { checkCloudShellArgs } from "../src/lib/cloudshell-guard.ts";
import { cliCommandParts } from "../src/lib/iam-action.ts";

const check = (args) => checkCloudShellArgs(args, cliCommandParts(args));

const refused = (args) => assert.equal(check(args).ok, false, JSON.stringify(args));
const allowed = (args) => assert.deepEqual(check(args), { ok: true }, JSON.stringify(args));

test("the CLI cannot change its own config (credential_process, aliases, plugins)", () => {
  refused(["configure", "set", "profile.x.credential_process", "sh -c 'touch PROOF'"]);
  refused(["s3", "ls", "--profile", "x"]);
  refused(["s3", "ls", "--profile=x"]);
  refused(["login"]);
  refused(["sso", "login"]);
});

test("the CLI cannot point somewhere else", () => {
  refused(["s3", "ls", "--endpoint-url", "https://evil.example"]);
  refused(["s3", "ls", "--endpoint-url=https://evil.example"]);
  refused(["s3", "ls", "--no-verify-ssl"]);
  refused(["s3", "ls", "--ca-bundle", "x.pem"]);
});

test("local files cannot be read or written", () => {
  refused(["sqs", "send-message", "--queue-url", "q", "--message-body", "file://secrets.txt"]);
  refused(["s3api", "put-object", "--bucket", "b", "--key", "k", "--body", "fileb://id_rsa"]);
  refused(["dynamodb", "put-item", "--cli-input-json", "{}"]);
  refused(["s3", "cp", "s3://b/k", "/Users/alex/project/src/proxy.ts"]);
  refused(["s3", "cp", "s3://b/k", "~/x"]);
  refused(["s3", "cp", "local.txt", "s3://b/k"]);
  refused(["s3", "sync", "s3://b", "."]);
  refused(["s3api", "get-object", "--bucket", "b", "--key", "k", "../../escape"]);
  refused(["lambda", "invoke", "--function-name", "f", "/tmp/out.json"]);
});

test("commands that start other programs are refused", () => {
  refused(["ec2-instance-connect", "ssh", "--instance-id", "i-1"]);
  refused(["ssm", "start-session", "--target", "i-1"]);
  refused(["codeartifact", "login", "--tool", "npm"]);
  refused(["eks", "update-kubeconfig", "--name", "c"]);
  refused(["cloudformation", "package", "--template-file", "t.yaml"]);
});

test("a global option before the service cannot hide the command", () => {
  refused(["--region", "us-east-1", "configure", "list"]);
  refused(["--output", "json", "sso", "login"]);
  refused(["--region", "us-east-1", "s3", "cp", "s3://b/k", "out.txt"]);
  refused(["--reg", "us-east-1", "configure", "list"]);
});

test("abbreviated blocked flags are refused", () => {
  refused(["--endpoint", "http://192.168.1.50:8080", "s3", "ls"]);
  refused(["s3", "ls", "--endp=http://x"]);
  refused(["--prof", "x", "s3", "ls"]);
  refused(["s3", "ls", "--no-verify"]);
  refused(["ecs", "execute-command", "--cluster", "c"]);
});

test("ordinary practice commands still run", () => {
  allowed(["--region", "us-east-1", "s3", "ls"]);
  allowed(["sts", "get-caller-identity"]);
  allowed(["s3", "ls"]);
  allowed(["s3", "cp", "s3://a/k", "s3://b/k"]);
  allowed(["s3", "cp", "s3://a/k", "-"]);
  allowed(["s3", "rm", "--recursive", "s3://b/logs/"]);
  allowed(["s3api", "put-object", "--bucket", "b", "--key", "logs/2026/a.txt"]);
  allowed(["dynamodb", "put-item", "--table-name", "T", "--item", '{"id":{"S":"1"}}']);
  allowed(["sqs", "send-message", "--queue-url", "https://127.0.0.1:9297/000000000000/q", "--message-body", "hi"]);
  allowed(["lambda", "invoke", "--function-name", "f", "out.json"]);
  allowed(["ec2", "describe-instances", "--region", "us-east-1"]);
});

test("an s3:// or - flag value does not count as an S3 endpoint", () => {
  refused(["s3", "cp", "credentials", "s3://forbidden/k", "--content-type", "-"]);
  refused(["s3", "cp", "config", "s3://b/k", "--exclude", "s3://x"]);
  allowed(["s3", "cp", "s3://a/k", "s3://b/k", "--content-type", "text/plain"]);
});

test("AWS names that start with / are allowed after their flags, local paths still are not", () => {
  allowed(["logs", "describe-log-streams", "--log-group-name", "/aws/lambda/f"]);
  allowed(["ssm", "get-parameter", "--name", "/app/db/password"]);
  allowed(["iam", "list-users", "--path-prefix", "/team/"]);
  refused(["lambda", "invoke", "--function-name", "f", "/tmp/out.json"]);
  refused(["ec2", "get-password-data", "--instance-id", "i-1", "--priv-launch-key", "/Users/alex/.ssh/id_rsa"]);
});

test("shorthand @= and file:// anywhere in a value are refused", () => {
  refused(["sqs", "send-message", "--queue-url", "q", "--message-body", "x", "--message-attributes", "a={DataType=String,StringValue@=file:///etc/hosts}"]);
  refused(["ssm", "put-parameter", "--name", "p", "--value", "v", "--tags", "Key=a,Value@=file:///Users/alex/.aws/credentials"]);
  refused(["ssm", "put-parameter", "--name", "p", "--value", "v", "--tags", "{a @ =fileb:///x}"]);
  refused(["sqs", "send-message", "--queue-url", "q", "--message-body", "see file:///etc/passwd"]);
});

test("/dev/stdout is allowed so output-file commands can print", () => {
  allowed(["lambda", "invoke", "--function-name", "f", "/dev/stdout"]);
  allowed(["s3api", "get-object", "--bucket", "b", "--key", "k", "/dev/stdout"]);
});

test("info-only commands (bare aws, --version, help) are allowed while blocked services stay refused", () => {
  allowed([]);
  allowed(["--version"]);
  allowed(["help"]);
  allowed(["--help"]);
  allowed(["s3", "help"]);
  allowed(["s3", "--help"]);
  refused(["configure", "help"]);
  refused(["login", "--help"]);
});

test("SEC-1: a value split from --x=y never counts as an AWS-name flag or an exempt name", () => {
  // The reviewer's exploit: the CLI reads --name as the language and the path as the outfile.
  refused(["s3api", "get-object", "--bucket", "b", "--key", "k", "--response-content-language=--name", "/private/tmp/pwn.txt"]);
  refused(["s3api", "get-object", "--bucket", "b", "--key", "k", "--response-content-language=--key", "/opt/homebrew/bin/brew"]);
  refused(["lambda", "invoke", "--function-name", "f", "--qualifier=--path", "/usr/local/bin/x"]);
  // A name written with = is not exempt: it must be a separate token.
  refused(["ssm", "get-parameter", "--name=/app/db/password"]);
  assert.match(check(["ssm", "get-parameter", "--name=/app/x"]).error, /--name \/app\/x/);
  // Written as separate tokens, AWS names still work.
  allowed(["ssm", "get-parameter", "--name", "/app/db/password"]);
  allowed(["logs", "describe-log-streams", "--log-group-name=aws-lambda-f"]);
});

test("SEC-3: the interactive auto-prompt is refused, --no-cli-auto-prompt is fine", () => {
  refused(["sqs", "list-queues", "--cli-auto-prompt"]);
  refused(["sqs", "list-queues", "--cli-auto"]);
  refused(["--cli-auto-prompt"]);
  assert.match(check(["s3", "ls", "--cli-auto-prompt"]).error, /interactive prompt/);
  allowed(["sqs", "list-queues", "--no-cli-auto-prompt"]);
});

test("info-only shortcuts cannot carry blocked flags or paths", () => {
  refused(["--endpoint-url=help"]);
  refused(["--profile", "help"]);
  refused(["--cli-auto-prompt", "help"]);
  refused(["configure", "--help"]);
});

test("RC-5: '--' and a bare --cli-auto-prompt are refused with their own reasons", async () => {
  const { checkCloudShellArgs } = await import("../src/lib/cloudshell-guard.ts");
  const dash = checkCloudShellArgs(["s3", "ls", "--", "x"], { service: "s3", operation: "ls" });
  assert.equal(dash.ok, false);
  assert.match(dash.error, /end of options/);
  const prompt = checkCloudShellArgs(["--cli-auto-prompt"], null);
  assert.equal(prompt.ok, false);
  assert.match(prompt.error, /interactive prompt/);
});
