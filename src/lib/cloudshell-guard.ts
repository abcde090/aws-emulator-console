/**
 * What the console's CloudShell refuses to run.
 *
 * The aws CLI can do more than call AWS: it can run a program to fetch credentials
 * (credential_process), read and write local files (file://, `s3 cp` to a path, outfiles),
 * start other programs (ssh, session-manager-plugin, npm) and change its own config. None of
 * that belongs in a practice terminal running on your Mac, so those forms are refused here.
 * The real boundary is cloudshell-sandbox.ts: on macOS the CLI runs under sandbox-exec, which
 * lets it write only to its own empty temp folder, read only system and CLI install folders,
 * and reach no network except the emulator.
 * This list refuses the known forms early, with a clear message.
 */

/** A token after `--flag=value` splitting; `fromSplit` marks both halves of a split argument. */
interface Token {
  text: string;
  fromSplit: boolean;
}

/** Splits `--flag=value` into `--flag value`, the way the aws CLI reads it. */
function splitWithOrigin(args: string[]): Token[] {
  return args.flatMap((a): Token[] => {
    const m = /^(--[A-Za-z0-9-]+)=([\s\S]*)$/.exec(a);
    return m ? [{ text: m[1], fromSplit: true }, { text: m[2], fromSplit: true }] : [{ text: a, fromSplit: false }];
  });
}

/**
 * True when tokens[i] is the value of an AWS-name flag (--name /app/x): both the flag and the
 * value were written as separate arguments. A value from `--x=--name` is never a flag, and a
 * value from `--name=/x` is not exempt either (write it as `--name /x`).
 */
function isAwsNameValue(tokens: Token[], i: number): boolean {
  if (i === 0) return false;
  const flag = tokens[i - 1];
  return !flag.fromSplit && !tokens[i].fromSplit && AWS_PATH_FLAGS.has(flag.text);
}

export type GuardResult = { ok: true } | { ok: false; error: string };

/** Flags that point the CLI somewhere else or read input from a file. */
const BLOCKED_FLAGS = new Set([
  "--profile",
  "--endpoint-url",
  "--ca-bundle",
  "--no-verify-ssl",
  "--cli-input-json",
  "--cli-input-yaml",
  // Interactive mode: it needs a terminal and reads further input, so it is refused.
  "--cli-auto-prompt",
]);

/** Whole services that manage the CLI itself rather than call AWS. */
const BLOCKED_SERVICES = new Set(["configure", "login", "logout", "history", "cli-dev"]);

/** Commands that start other programs or package local folders. */
const BLOCKED_COMMANDS = new Set([
  "sso login",
  "sso logout",
  "ec2-instance-connect ssh",
  "ec2-instance-connect open-tunnel",
  "ssm start-session",
  "codeartifact login",
  "emr ssh",
  "emr socks",
  "emr get",
  "emr put",
  "eks update-kubeconfig",
  "deploy push",
  "deploy install",
  "deploy uninstall",
  "cloudformation package",
  "cloudformation deploy",
  "ecr get-login",
  "ecs execute-command",
  "gamelift upload-build",
]);

const refuse = (error: string): GuardResult => ({ ok: false, error: `CloudShell: ${error}` });

/**
 * `rawArgs` are the CLI arguments after `aws`; `parts` is the service and operation from
 * cliCommandParts in iam-action.ts (null when it could not tell them apart).
 */
/** Flags whose values are AWS names that start with "/" (log groups, SSM parameters, IAM paths, devices). */
const AWS_PATH_FLAGS = new Set([
  "--log-group-name", "--log-group-name-prefix", "--log-group-identifier", "--name", "--names", "--path",
  "--path-prefix", "--parameter-name", "--device", "--device-name", "--prefix", "--key", "--role-path",
]);

/** Safe CLI info commands that never call AWS or touch local files (e.g. `aws`, `aws --version`, `aws help`, `aws s3 help`). */
export function isInfoOnlyCommand(rawArgs: string[]): boolean {
  if (rawArgs.length === 0) return true;
  if (rawArgs.length === 1) {
    return rawArgs[0] === "--version" || rawArgs[0] === "help" || rawArgs[0] === "--help";
  }
  if (rawArgs.length === 2) {
    const [svc, sub] = rawArgs;
    return !svc.startsWith("-") && !BLOCKED_SERVICES.has(svc) && (sub === "help" || sub === "--help");
  }
  return false;
}

/** --cli-auto-prompt or an unambiguous abbreviation of it (the CLI accepts those). */
function isAutoPromptFlag(a: string): boolean {
  return a.startsWith("--") && "--cli-auto-prompt".startsWith(a) && a.length > "--cli-".length;
}

export function checkCloudShellArgs(
  rawArgs: string[],
  parts: { service: string; operation: string; s3Positionals?: string[] | null } | null
): GuardResult {
  const tokens = splitWithOrigin(rawArgs);
  const args = tokens.map((t) => t.text);
  if (isInfoOnlyCommand(args)) return { ok: true };
  // Checked before the command shape, so "aws --cli-auto-prompt" gets the right reason.
  const prompt = args.find(isAutoPromptFlag);
  if (prompt) return refuse(`${prompt} starts the CLI's interactive prompt, which needs a terminal. Type the full command instead.`);
  if (args.includes("--")) {
    return refuse('"--" (end of options) is not available here. Write each value straight after its option.');
  }
  if (!parts) {
    return refuse("put the operation straight after the service (aws s3 rb s3://b --force, not aws s3 --force rb ...) and write global options in full (--region, not --reg).");
  }
  const { service, operation } = parts;

  if (BLOCKED_SERVICES.has(service)) {
    return refuse(`"aws ${service}" changes the CLI's own setup, so it is not available here. Use your normal terminal.`);
  }
  if (BLOCKED_COMMANDS.has(`${service} ${operation}`)) {
    return refuse(`"aws ${service} ${operation}" starts other programs or reads local folders, so it is not available here. Use your normal terminal.`);
  }

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    // The CLI accepts any unambiguous abbreviation of a flag, so --endpoint and --prof count too.
    if (a.startsWith("--") && [...BLOCKED_FLAGS].some((f) => f.startsWith(a))) {
      return refuse(`${a} is not available here: CloudShell always uses the emulator's own profile and endpoint.`);
    }
    // Anywhere in the value: shorthand can load a file with key@=file://... too.
    if (/fileb?:\/\//i.test(a) || /@\s*=/.test(a)) {
      return refuse("file://, fileb:// and @= values read files on this computer, so they are not available here. Paste the value inline instead.");
    }
    // /dev/stdout lets output-file commands (lambda invoke, s3api get-object) print the result.
    const awsName = isAwsNameValue(tokens, i) || a === "/dev/stdout";
    if (!awsName && (a.startsWith("/") || a.startsWith("~") || a.startsWith("\\") || /(^|[\\/])\.\.([\\/]|$)/.test(a))) {
      const hint = a.startsWith("/") && tokens[i].fromSplit && i > 0 && AWS_PATH_FLAGS.has(args[i - 1])
        ? ` If it is an AWS name, write it as a separate value: ${args[i - 1]} ${a}`
        : "";
      return refuse(`"${a}" looks like a path on this computer. CloudShell here cannot read or write local files.${hint}`);
    }
  }

  if (service === "s3" && (operation === "cp" || operation === "mv" || operation === "sync")) {
    // Positionals only: "--content-type -" or "--exclude s3://x" are values, not endpoints.
    const positionals = parts.s3Positionals;
    if (!positionals || positionals.length !== 2 || !positionals.every((a) => a.startsWith("s3://") || a === "-")) {
      return refuse(`"aws s3 ${operation}" here only works between S3 locations (s3://bucket/key) or to the screen (-). Local files are not reachable.`);
    }
  }

  return { ok: true };
}
