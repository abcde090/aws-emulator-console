/** IAM Dashboard: IAM resources (GetAccountSummary), security recommendations and the AWS Account panel (alias). */

import Link from "next/link";
import { notFound } from "next/navigation";
import { getService } from "@/console/registry";
import { ServiceFrame } from "@/console/ui/pages";
import { Container, ErrorBanner, PageHeader } from "@/console/ui/primitives";
import { dashboardData } from "@/services/iam/page-data";
import { AccountAlias } from "@/services/iam/ui/AccountAlias";

export const dynamic = "force-dynamic";

const RESOURCES: { key: string; label: string; href: string }[] = [
  { key: "Groups", label: "User groups", href: "/iam/groups" },
  { key: "Users", label: "Users", href: "/iam/users" },
  { key: "Roles", label: "Roles", href: "/iam/roles" },
  { key: "Policies", label: "Policies", href: "/iam/policies" },
  { key: "Providers", label: "Identity providers", href: "/iam/identity-providers" },
];

export default async function IamDashboardPage() {
  const service = getService("iam");
  if (!service) notFound();
  const r = await dashboardData();
  return (
    <ServiceFrame service={service} activeResource="dashboard" crumbs={[{ label: "IAM", href: "/iam" }, { label: "Dashboard" }]}>
      <div className="space-y-5">
        <PageHeader title="IAM Dashboard" />
        {!r.ok && <ErrorBanner message={r.error} />}
        {r.ok && (
          <>
            <Container title="Security recommendations">
              <ul className="space-y-2" data-testid="security-recommendations">
                <li>
                  <span className={r.data.summary.AccountMFAEnabled === 1 ? "text-ok" : "text-warn"}>{r.data.summary.AccountMFAEnabled === 1 ? "●" : "▲"}</span>{" "}
                  {r.data.summary.AccountMFAEnabled === 1 ? "Root user has MFA" : "Add MFA for root user"}
                </li>
                <li>
                  <span className={r.data.summary.AccountAccessKeysPresent === 1 ? "text-warn" : "text-ok"}>{r.data.summary.AccountAccessKeysPresent === 1 ? "▲" : "●"}</span>{" "}
                  {r.data.summary.AccountAccessKeysPresent === 1 ? "Root user has active access keys" : "Root user has no active access keys"}
                </li>
              </ul>
            </Container>
            <Container title="IAM resources" description="Resources in this AWS account">
              <dl className="grid grid-cols-2 gap-4 md:grid-cols-5" data-testid="iam-resources">
                {RESOURCES.map((x) => (
                  <div key={x.key}>
                    <dt className="font-bold text-muted">{x.label}</dt>
                    <dd className="text-2xl">
                      <Link href={x.href}>{r.data.summary[x.key] ?? 0}</Link>
                    </dd>
                  </div>
                ))}
              </dl>
            </Container>
            <AccountAlias accountId={r.data.accountId} alias={r.data.alias} />
            <Container title="Quotas" description="From GetAccountSummary">
              <dl className="grid grid-cols-1 gap-4 md:grid-cols-3">
                {Object.entries(r.data.summary)
                  .filter(([k]) => k.endsWith("Quota"))
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([k, v]) => (
                    <div key={k}>
                      <dt className="font-bold text-muted">{k.replace(/([a-z])([A-Z])/g, "$1 $2")}</dt>
                      <dd>{v}</dd>
                    </div>
                  ))}
              </dl>
            </Container>
          </>
        )}
      </div>
    </ServiceFrame>
  );
}
