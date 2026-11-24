import Link from "next/link";
import { ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { DescribeInstancesCommand } from "@aws-sdk/client-ec2";
import { ListUsersCommand } from "@aws-sdk/client-iam";
import { ListFunctionsCommand } from "@aws-sdk/client-lambda";
import { ListBucketsCommand } from "@aws-sdk/client-s3";
import { ListQueuesCommand } from "@aws-sdk/client-sqs";
import { GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { clients } from "@/lib/aws";
import { emulatorEndpoint } from "@/lib/emulator-files";
import { getActiveIdentity } from "@/lib/identity";
import { principalArn } from "@/lib/permissions";
import { regionName } from "@/lib/regions";
import { selectedRegion } from "@/lib/selected-region";
import { serviceCatalog } from "@/console/registry";
import { errorMessage } from "@/console/serialize";
import { Container, ErrorBanner } from "@/console/ui/primitives";
import { RecentlyVisited } from "@/components/shell/RecentlyVisited";
import { ServiceIcon } from "@/components/shell/ServiceIcon";
import { ServicesCatalog } from "@/components/shell/ServicesCatalog";

async function emulatorStatus(): Promise<{ ok: true; account: string; arn: string } | { ok: false; error: string }> {
  try {
    const r = await clients.sts.send(new GetCallerIdentityCommand({}));
    // The console signs with the emulator's admin keys; the IAM simulator acts as the chosen
    // identity, so show that identity's ARN (what every check on this page runs as).
    const identity = await getActiveIdentity();
    return { ok: true, account: r.Account ?? "-", arn: identity.type === "admin" ? r.Arn ?? "-" : principalArn(identity) };
  } catch (err: unknown) {
    return { ok: false, error: errorMessage(err) };
  }
}

interface ResourceMetric {
  id: string;
  label: string;
  href: string;
  count: number | null;
}

async function safeCount(fn: () => Promise<number>): Promise<number | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

async function loadResourceSummary(): Promise<ResourceMetric[]> {
  const [buckets, queues, instances, functions, tables, users] = await Promise.all([
    safeCount(async () => (await clients.s3.send(new ListBucketsCommand({}))).Buckets?.length ?? 0),
    safeCount(async () => (await clients.sqs.send(new ListQueuesCommand({}))).QueueUrls?.length ?? 0),
    safeCount(async () => {
      // Live instances only: the emulator keeps terminated ones, which AWS drops after about an hour.
      const Filters = [{ Name: "instance-state-name", Values: ["pending", "running", "stopping", "stopped"] }];
      let n = 0;
      let NextToken: string | undefined;
      do {
        const r = await clients.ec2.send(new DescribeInstancesCommand({ Filters, NextToken }));
        n += (r.Reservations ?? []).reduce((sum, res) => sum + (res.Instances?.length ?? 0), 0);
        NextToken = r.NextToken;
      } while (NextToken);
      return n;
    }),
    safeCount(async () => (await clients.lambda.send(new ListFunctionsCommand({}))).Functions?.length ?? 0),
    safeCount(async () => (await clients.dynamodb.send(new ListTablesCommand({}))).TableNames?.length ?? 0),
    safeCount(async () => (await clients.iam.send(new ListUsersCommand({}))).Users?.length ?? 0),
  ]);

  return [
    { id: "s3", label: "S3 Buckets", href: "/s3/buckets", count: buckets },
    { id: "sqs", label: "SQS Queues", href: "/sqs/queues", count: queues },
    { id: "ec2", label: "EC2 Instances", href: "/ec2/instances", count: instances },
    { id: "lambda", label: "Lambda Functions", href: "/lambda/functions", count: functions },
    { id: "dynamodb", label: "DynamoDB Tables", href: "/dynamodb/tables", count: tables },
    { id: "iam", label: "IAM Users", href: "/iam/users", count: users },
  ];
}

export default async function ConsoleHome() {
  const services = serviceCatalog();
  const [status, region] = await Promise.all([emulatorStatus(), selectedRegion()]);
  const summary = status.ok ? await loadResourceSummary() : [];
  let endpoint = "";
  try {
    endpoint = emulatorEndpoint();
  } catch (err: unknown) {
    endpoint = errorMessage(err);
  }
  return (
    <div>
      {/* Cloudscape Console Home Hero Band */}
      <div className="border-b border-[#2a3441] bg-gradient-to-r from-[#0f1b2a] via-[#16253b] to-[#1a2f4d] px-6 py-5 text-white">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-[12px] font-semibold tracking-wider text-[#9ba7b6] uppercase">AWS Management Console</p>
            <h1 className="mt-0.5 text-[24px] font-bold tracking-tight text-white">Console Home</h1>
          </div>
          {status.ok && (
            <div
              className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-3.5 py-1.5 text-[12px] text-[#e9ebed]"
              data-testid="emulator-status"
            >
              <span className="inline-block size-2 rounded-full bg-[#29ad32]" aria-hidden="true" />
              <span>
                Connected to AWS Emulator at <span className="font-mono text-white">{endpoint}</span> · account{" "}
                <span className="font-mono text-white">{status.account}</span> · <span className="font-mono text-white">{status.arn}</span>
              </span>
            </div>
          )}
        </div>
      </div>

      <main className="mx-auto max-w-[1440px] space-y-5 px-6 py-5">
        {!status.ok && (
          <ErrorBanner
            title={`AWS Emulator is not answering at ${endpoint}`}
            message={`${status.error}\nStart it with ./scripts/emulator.sh start, then reload.`}
          />
        )}

        {/* Live Emulator Resource Overview */}
        {summary.length > 0 && (
          <Container title="Resource overview" description={`Live counts queried directly from your local AWS Emulator (${region}; S3 buckets and IAM users are global)`}>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {summary.map((m) => (
                <Link
                  key={m.id}
                  href={m.href}
                  className="group flex flex-col justify-between rounded-[6px] border border-line-soft bg-shade p-3 transition-colors hover:border-primary hover:bg-info-bg hover:no-underline"
                >
                  <div className="flex items-center gap-2">
                    <ServiceIcon serviceId={m.id} size={20} />
                    <span className="truncate text-[12px] font-semibold text-muted group-hover:text-ink">{m.label}</span>
                  </div>
                  <p className="mt-2 text-[22px] font-bold text-ink">{m.count === null ? "—" : m.count}</p>
                </Link>
              ))}
            </div>
          </Container>
        )}

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
          <div className="lg:col-span-7">
            <Container title="Recently visited" description="Services you opened in this console">
              <RecentlyVisited
                known={services.map((s) => ({
                  id: s.id,
                  category: s.category,
                  href: s.firstResource ? `/${s.id}/${s.firstResource}` : `/${s.id}`,
                }))}
              />
            </Container>
          </div>
          <div className="lg:col-span-5">
            <Container title="Environment & Account" description="Live status from AWS Emulator STS">
              <dl className="grid grid-cols-1 gap-3 text-[13px] sm:grid-cols-2">
                <div>
                  <dt className="text-[12px] font-semibold text-muted">Account ID</dt>
                  <dd className="mt-0.5 font-mono text-ink">{status.ok ? status.account : "-"}</dd>
                </div>
                <div>
                  <dt className="text-[12px] font-semibold text-muted">Region</dt>
                  <dd className="mt-0.5 text-ink" data-testid="home-region">
                    {regionName(region)} · {region}
                  </dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-[12px] font-semibold text-muted">Caller ARN</dt>
                  <dd className="mt-0.5 font-mono text-[12px] break-all text-ink">{status.ok ? status.arn : "-"}</dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-[12px] font-semibold text-muted">Emulator endpoint</dt>
                  <dd className="mt-0.5 font-mono text-[12px] text-ink">{endpoint}</dd>
                </div>
              </dl>
            </Container>
          </div>
        </div>

        <Container
          title="All services"
          counter={`(${services.length})`}
          description="Every service below calls the local AWS Emulator API directly. Click ★ to pin services to the top favorites bar."
        >
          <ServicesCatalog services={services} />
        </Container>

        <p className="text-[12px] text-muted">
          A local practice console for AWS Emulator. Not affiliated with or endorsed by Amazon Web Services.
        </p>
      </main>
    </div>
  );
}
