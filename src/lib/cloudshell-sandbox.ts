/**
 * The pieces of CloudShell's sandbox that have no side effects, so they can be tested:
 * the macOS sandbox-exec profile, the child's environment and the rewritten CLI config.
 */

import { DEFAULT_REGION, isConsoleRegion } from "./regions.ts";

/** Where an aws binary may live. Absolute paths only: PATH is never consulted. */
export const AWS_BINARY_CANDIDATES = ["/opt/homebrew/bin/aws", "/usr/local/bin/aws", "/usr/bin/aws"];

/**
 * Folders the sandboxed CLI may read and start programs from: the system, Homebrew's and
 * /usr/local's package trees (the aws CLI is Python under these) and the time zone data.
 * Everything else is unreadable, including Homebrew's var/ and etc/ and /usr/local/var.
 */
export const READ_ALLOWED = [
  "/System",
  "/usr/bin",
  "/usr/lib",
  "/usr/libexec",
  "/usr/share",
  "/bin",
  "/private/var/db/timezone",
  "/opt/homebrew/bin",
  "/opt/homebrew/Cellar",
  "/opt/homebrew/opt",
  "/opt/homebrew/lib",
  "/opt/homebrew/share",
  "/usr/local/bin",
  "/usr/local/Cellar",
  "/usr/local/opt",
  "/usr/local/lib",
  "/usr/local/aws-cli",
];

/** Single files the CLI reads outside those folders (time zone link, devices). */
export const READ_ALLOWED_FILES = ["/private/etc/localtime", "/dev/null", "/dev/urandom", "/dev/random", "/dev/zero", "/dev/tty", "/dev/dtracehelper"];

/** Folders the sandboxed CLI may start programs from. */
export const EXEC_ALLOWED = ["/opt/homebrew/bin", "/opt/homebrew/Cellar", "/opt/homebrew/opt", "/usr/local/bin", "/usr/local/Cellar", "/usr/local/opt", "/usr/local/aws-cli", "/usr/bin", "/bin"];

/** Folders the sandboxed CLI may never read, write or even stat. */
export const FILE_DENIED = ["/Users", "/Volumes", "/private/var/root"];

/** Devices the CLI may write to (its own output streams). */
export const WRITE_ALLOWED_DEVICES = ["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty", "/dev/dtracehelper"];

export const CLOUDSHELL_TIMEOUT_MS = 12_000;
export const CLOUDSHELL_MAX_OUTPUT = 2 * 1024 * 1024;

/** SBPL string literal: refuse anything that could break out of the quotes. */
function sbplString(value: string): string {
  if (!/^\/[A-Za-z0-9._\/-]*$/.test(value)) throw new Error(`unsafe path for the sandbox profile: ${value}`);
  return `"${value}"`;
}

const subpaths = (paths: string[]) => paths.map((p) => `(subpath ${sbplString(p)})`).join(" ");
const literals = (paths: string[]) => paths.map((p) => `(literal ${sbplString(p)})`).join(" ");

/**
 * Deny-by-default for files. Reads: the allow-listed system folders, the run's config folder
 * and its home folder. Writes: only the run's home folder and the output devices. Later rules
 * win in SBPL, so the /Users denial comes after the broad metadata allowance and the run's
 * own folders come last (they stay usable even if TMPDIR were under /Users).
 */
export function buildSandboxProfile(paths: Pick<WorkPaths, "dir" | "home">, emulatorPort: number): string {
  if (!Number.isInteger(emulatorPort) || emulatorPort < 1 || emulatorPort > 65535) throw new Error("bad emulator port");
  if (!paths.home.startsWith(`${paths.dir}/`)) throw new Error("the home folder must be inside the work folder");
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-read* file-write*)",
    // stat() on any path (Python resolves every parent folder); no listing or reading.
    "(allow file-read-metadata)",
    `(allow file-read* ${subpaths(READ_ALLOWED)} ${literals(READ_ALLOWED_FILES)} (literal "/") (regex #"^/dev/fd/[0-9]+$"))`,
    `(allow file-write-data ${literals(WRITE_ALLOWED_DEVICES)} (regex #"^/dev/fd/[0-9]+$"))`,
    `(deny file-read* file-write* ${subpaths(FILE_DENIED)})`,
    `(allow file-read* (subpath ${sbplString(paths.dir)}))`,
    `(allow file-write* (subpath ${sbplString(paths.home)}))`,
    "(deny network*)",
    `(allow network-outbound (remote ip "localhost:${emulatorPort}"))`,
    "(deny process-exec)",
    `(allow process-exec ${subpaths(EXEC_ALLOWED)})`,
    "",
  ].join("\n");
}

/**
 * One CloudShell run's folders: `dir` holds `conf/` (config, keys and CA copies, read-only)
 * and `bin/`; `home` is an empty folder used as cwd, HOME and TMPDIR, the only writable place,
 * so relative paths in a command can never name the key files.
 */
export interface WorkPaths {
  dir: string;
  home: string;
  bin: string;
  config: string;
  credentials: string;
  ca: string;
}

/**
 * The child's whole environment. Nothing is inherited from the console's process. `region`
 * is the Region chosen in the top bar; only the console's own Region codes are accepted.
 */
export function buildChildEnv(paths: WorkPaths, emulatorPort: number, region: string = DEFAULT_REGION): Record<string, string> {
  if (!isConsoleRegion(region)) throw new Error(`"${String(region)}" is not a Region this console offers.`);
  return {
    HOME: paths.home,
    TMPDIR: paths.home,
    PATH: paths.bin,
    LANG: "en_US.UTF-8",
    AWS_CONFIG_FILE: paths.config,
    AWS_SHARED_CREDENTIALS_FILE: paths.credentials,
    AWS_CA_BUNDLE: paths.ca,
    AWS_ENDPOINT_URL: `https://127.0.0.1:${emulatorPort}`,
    AWS_REGION: region,
    AWS_DEFAULT_REGION: region,
    AWS_PAGER: "",
    AWS_CLI_AUTO_PROMPT: "off",
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_DISABLE_HOST_PREFIX_INJECTION: "true",
  };
}

/** The emulator's CLI config, with ca_bundle pointed at the copy in the work folder. */
export function rewriteCliConfig(config: string, caPath: string): string {
  const lines = config.split(/\r?\n/);
  const out = lines.filter((l) => !/^\s*ca_bundle\s*=/.test(l));
  const defaultIdx = out.findIndex((l) => /^\s*\[default\]\s*$/.test(l));
  if (defaultIdx === -1) return [`[default]`, `ca_bundle = ${caPath}`, ...out].join("\n");
  return [...out.slice(0, defaultIdx + 1), `ca_bundle = ${caPath}`, ...out.slice(defaultIdx + 1)].join("\n");
}

/** Joins stdout and stderr, cut at the output cap with a note. */
export function capOutput(text: string, max = CLOUDSHELL_MAX_OUTPUT): string {
  return text.length > max ? `${text.slice(0, max)}\n[output cut at ${max} bytes]` : text;
}
