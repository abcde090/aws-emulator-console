/** Pure helpers for RAM: the principal and resource-ARN text boxes, and the tag difference "Manage tags" saves. */

const PRINCIPAL = /^(\d{12}|arn:aws:(organizations|iam)::[^\s]+|[a-z0-9.-]+\.amazonaws\.com)$/;

function lines(raw: unknown): string[] {
  return typeof raw === "string" ? [...new Set(raw.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean))] : [];
}

export function parsePrincipals(raw: unknown): string[] {
  const list = lines(raw);
  for (const p of list) if (!PRINCIPAL.test(p)) throw new Error(`"${p}" is not an AWS account ID, organization / OU ARN, IAM ARN or service principal.`);
  return list;
}

export function parseResourceArns(raw: unknown): string[] {
  const list = lines(raw);
  for (const a of list) if (!/^arn:aws[a-z-]*:[a-z0-9-]+:[a-z0-9-]*:\d{0,12}:.+$/.test(a)) throw new Error(`"${a}" is not a resource ARN.`);
  return list;
}
