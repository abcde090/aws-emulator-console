/**
 * Hand-built "AWS accounts" screen: the organization's root and OUs as a tree, like the
 * Organizations console. Rows come from the accounts resource's list() via the engine, so
 * errors and simulated AccessDenied are shown the same way as everywhere else.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { getResource, getService } from "@/console/registry";
import { engineList } from "@/console/server";
import { firstParam, ServiceFrame } from "@/console/ui/pages";
import { buttonClass, Container, EmptyState, ErrorBanner, Flash, PageHeader } from "@/console/ui/primitives";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function OrganizationTreePage({ searchParams }: PageProps) {
  const service = getService("organizations");
  const resource = getResource("organizations", "accounts");
  if (!service || !resource) notFound();
  const deleted = firstParam((await searchParams).deleted);
  const r = await engineList("organizations", "accounts");
  const rows = r.ok ? r.data : [];
  const ouCount = rows.filter((x) => x.type === "Organizational unit").length;
  const deletedFlash = deleted && r.ok && !rows.some((x) => x.id === deleted) ? `Deleted organizational unit ${deleted}.` : null;

  return (
    <ServiceFrame service={service} activeResource="accounts" crumbs={[{ label: service.name, href: "/organizations" }, { label: "AWS accounts" }]}>
      <div className="space-y-4">
        <PageHeader
          title="AWS accounts"
          description="The root and organizational units (OUs) of your organization."
          actions={
            r.ok && rows.length > 0 ? (
              <Link href="/organizations/accounts/create" className={`${buttonClass("primary")} hover:no-underline`}>
                Create organizational unit
              </Link>
            ) : null
          }
        />
        {deletedFlash && <Flash kind="success" message={deletedFlash} />}
        {!r.ok && <ErrorBanner message={r.error} />}
        {r.ok && (
          <Container title="Organizational structure" counter={`(${ouCount} OU${ouCount === 1 ? "" : "s"})`} description="AWS Emulator doesn't list the accounts inside the root or OUs yet (ListAccounts, ListAccountsForParent).">
            {rows.length === 0 ? (
              <EmptyState title="No organization">
                <Link href="/organizations/settings/create">Create an organization</Link> to group accounts into organizational units.
              </EmptyState>
            ) : (
              <ul className="space-y-1" data-testid="org-tree" role="tree" aria-label="Organizational structure">
                {rows.map((row) => {
                  const id = String(row.id);
                  const depth = typeof row.depth === "number" ? row.depth : 0;
                  return (
                    <li key={id} role="treeitem" aria-level={depth + 1} aria-selected={false} className="flex flex-wrap items-baseline gap-3 border-b border-line-soft py-1.5" style={{ paddingLeft: `${depth * 1.5}rem` }}>
                      <span aria-hidden className="text-muted">{row.type === "Root" ? "▣" : depth > 0 ? "└ ▢" : "▢"}</span>
                      <Link href={`/organizations/accounts/${encodeURIComponent(id)}`} className="font-bold">
                        {String(row.name)}
                      </Link>
                      <span className="font-mono text-[13px] text-muted">{id}</span>
                      <span className="text-[13px] text-muted">{String(row.type)}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Container>
        )}
      </div>
    </ServiceFrame>
  );
}
