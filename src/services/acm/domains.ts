/** Pure helper: the "additional names" box of the Request certificate form. */

const FQDN = /^(\*\.)?([a-zA-Z0-9-]{1,63}\.)+[a-zA-Z]{2,63}$/;

export function domainList(raw: unknown, primary: string): string[] {
  if (typeof raw !== "string") return [];
  const names = [...new Set(raw.split(/[\s,]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))].filter((n) => n !== primary.toLowerCase());
  for (const n of names) if (!FQDN.test(n)) throw new Error(`"${n}" is not a fully qualified domain name.`);
  if (names.length > 99) throw new Error("A certificate can have at most 100 names.");
  return names;
}

const bare = (name: string): string => name.toLowerCase().replace(/\.$/, "");

/**
 * The hosted zone a validation record belongs in: the zone whose name is the longest
 * suffix of the domain (a wildcard's "*." is ignored). Public zones win over private ones.
 */
export function matchingZone<Z extends { name: string; privateZone: boolean }>(domain: string, zones: readonly Z[]): Z | undefined {
  const d = bare(domain).replace(/^\*\./, "");
  const fits = zones.filter((z) => {
    const n = bare(z.name);
    return d === n || d.endsWith(`.${n}`);
  });
  return [...fits].sort((a, b) => Number(a.privateZone) - Number(b.privateZone) || bare(b.name).length - bare(a.name).length)[0];
}
