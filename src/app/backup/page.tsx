/**
 * Hand-built AWS Backup dashboard (the console's landing page): job status counts and
 * resource totals. Every number is counted from the engine's list results, which go
 * through the permission-checked Backup client.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { getService } from "@/console/registry";
import { engineList } from "@/console/server";
import type { Result, Row } from "@/console/types";
import { ServiceFrame } from "@/console/ui/pages";
import { Container, ErrorBanner, PageHeader, StatusBadge, buttonClass } from "@/console/ui/primitives";
import { countByState } from "@/services/backup/helpers";

function JobPanel({ title, href, result }: { title: string; href: string; result: Result<Row[]> }) {
  return (
    <Container title={<Link href={href}>{title}</Link>} counter={result.ok ? `(${result.data.length})` : undefined}>
      {!result.ok ? (
        <ErrorBanner message={result.error} />
      ) : result.data.length === 0 ? (
        <p className="text-muted">No jobs.</p>
      ) : (
        <ul className="space-y-1" data-testid={`dashboard-${title}`}>
          {countByState(result.data, "status").map((s) => (
            <li key={s.state} className="flex items-center justify-between gap-4">
              <StatusBadge value={s.state} />
              <span className="font-bold">{s.count}</span>
            </li>
          ))}
        </ul>
      )}
    </Container>
  );
}

function Total({ label, href, result }: { label: string; href: string; result: Result<Row[]> }) {
  return (
    <div className="min-w-40">
      <p className="text-muted">{label}</p>
      {result.ok ? (
        <Link href={href} className="text-2xl font-bold" data-testid={`total-${label}`}>
          {result.data.length}
        </Link>
      ) : (
        <p className="text-[13px] text-bad">{result.error}</p>
      )}
    </div>
  );
}

export default async function BackupDashboard() {
  const service = getService("backup");
  if (!service) notFound();
  const [vaults, plans, recoveryPoints, backupJobs, restoreJobs, copyJobs] = await Promise.all(
    ["vaults", "plans", "recovery-points", "backup-jobs", "restore-jobs", "copy-jobs"].map((r) => engineList("backup", r))
  );
  return (
    <ServiceFrame service={service} crumbs={[{ label: service.name, href: "/backup" }, { label: "Dashboard" }]}>
      <div className="space-y-5">
        <PageHeader
          title="Dashboard"
          description="Backup activity in this Region, counted from the AWS Backup job lists."
          actions={
            <>
              <Link href="/backup/plans/create" className={buttonClass("normal")}>
                Create backup plan
              </Link>
              <Link href="/backup/backup-jobs/create" className={buttonClass("primary")}>
                Create on-demand backup
              </Link>
            </>
          }
        />
        <Container title="Overview">
          <div className="flex flex-wrap gap-8">
            <Total label="Backup vaults" href="/backup/vaults" result={vaults} />
            <Total label="Backup plans" href="/backup/plans" result={plans} />
            <Total label="Recovery points" href="/backup/recovery-points" result={recoveryPoints} />
          </div>
        </Container>
        <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
          <JobPanel title="Backup jobs" href="/backup/backup-jobs" result={backupJobs} />
          <JobPanel title="Restore jobs" href="/backup/restore-jobs" result={restoreJobs} />
          <JobPanel title="Copy jobs" href="/backup/copy-jobs" result={copyJobs} />
        </div>
      </div>
    </ServiceFrame>
  );
}
