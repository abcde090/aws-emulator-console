/**
 * Turns a CloudShell line into arguments for the aws CLI, so it can run without a shell.
 * Only `aws ...` commands are accepted; pipes, redirects and substitutions are refused.
 */

export type ParsedAwsCommand = { ok: true; args: string[] } | { ok: false; error: string };

const SHELL_OPERATORS = new Set([";", "|", "&", ">", "<", "`", "\n", "\r"]);

export function parseAwsCommand(input: string): ParsedAwsCommand {
  const tokens = tokenize(input);
  if (!tokens.ok) return tokens;
  const [binary, ...args] = tokens.args;
  if (binary !== "aws") {
    return { ok: false, error: "Only aws commands can run here. Example: aws s3 ls" };
  }
  return { ok: true, args };
}

function tokenize(input: string): ParsedAwsCommand {
  const args: string[] = [];
  let current = "";
  let inToken = false;
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "$" || ch === "`") return refuse(ch);
      // Inside double quotes a backslash only escapes " and \\, as in bash ($ and ` are refused).
      else if (ch === "\\" && (input[i + 1] === '"' || input[i + 1] === "\\")) current += input[++i];
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inToken = true;
    } else if (ch === "\\" && i + 1 < input.length) {
      current += input[++i];
      inToken = true;
    } else if (ch === " " || ch === "\t") {
      if (inToken) args.push(current);
      current = "";
      inToken = false;
    } else if (SHELL_OPERATORS.has(ch) || (ch === "$" && input[i + 1] === "(")) {
      return refuse(ch);
    } else {
      current += ch;
      inToken = true;
    }
  }
  if (quote) return { ok: false, error: "Unterminated quote." };
  if (inToken) args.push(current);
  return { ok: true, args };
}

function refuse(ch: string): ParsedAwsCommand {
  const shown = ch === "\n" || ch === "\r" ? "a line break" : `"${ch}"`;
  return { ok: false, error: `Shell operators such as ${shown} are not supported. Run one aws command at a time.` };
}
