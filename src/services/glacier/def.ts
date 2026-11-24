/**
 * Amazon S3 Glacier (the original vault-based service): vaults, archives and retrieval jobs.
 * Every value comes from a Glacier API response. accountId "-" means "the caller's account".
 */

import {
  CreateVaultCommand,
  DeleteArchiveCommand,
  DeleteVaultCommand,
  DescribeJobCommand,
  DescribeVaultCommand,
  GetJobOutputCommand,
  InitiateJobCommand,
  ListJobsCommand,
  ListVaultsCommand,
  UploadArchiveCommand,
  type DescribeVaultOutput,
  type GlacierJobDescription,
} from "@aws-sdk/client-glacier";
import { errorMessage } from "../../console/serialize.ts";
import type { Ctx, ResourceDef, Row, ServiceDef } from "../../console/types.ts";
import { text } from "../../console/values.ts";

const ACCOUNT = "-";
const VAULT_NAME = "[A-Za-z0-9_.-]{1,255}";
const MAX_INLINE_OUTPUT = 200_000;

function vaultRow(v: DescribeVaultOutput): Row {
  return {
    name: v.VaultName ?? null,
    created: v.CreationDate ?? null,
    archives: v.NumberOfArchives ?? 0,
    size: v.SizeInBytes ?? 0,
    lastInventory: v.LastInventoryDate ?? null,
    arn: v.VaultARN ?? null,
  };
}

function jobRow(j: GlacierJobDescription): Row {
  return {
    jobId: j.JobId ?? null,
    action: j.Action ?? null,
    status: j.StatusCode ?? null,
    tier: j.Tier ?? null,
    created: j.CreationDate ?? null,
    completed: j.CompletionDate ?? null,
    archiveId: j.ArchiveId ?? null,
    size: j.Action === "InventoryRetrieval" ? j.InventorySizeInBytes ?? null : j.ArchiveSizeInBytes ?? null,
    description: j.JobDescription ?? null,
  };
}

async function listJobs(ctx: Ctx, vault: string): Promise<GlacierJobDescription[]> {
  const out: GlacierJobDescription[] = [];
  let marker: string | undefined;
  do {
    const r = await ctx.clients.glacier.send(new ListJobsCommand({ accountId: ACCOUNT, vaultName: vault, marker }));
    out.push(...(r.JobList ?? []));
    marker = r.Marker;
  } while (marker);
  return out;
}

const jobColumns = [
  { key: "jobId", label: "Job ID", kind: "code" as const },
  { key: "action", label: "Job type", kind: "text" as const },
  { key: "status", label: "Status", kind: "status" as const },
  { key: "tier", label: "Retrieval tier", kind: "text" as const },
  { key: "created", label: "Created", kind: "date" as const },
  { key: "completed", label: "Completed", kind: "date" as const },
  { key: "archiveId", label: "Archive ID", kind: "code" as const },
  { key: "size", label: "Size", kind: "bytes" as const },
];

const vaults: ResourceDef = {
  id: "vaults",
  name: "Vaults",
  singular: "vault",
  idField: "name",
  nameField: "Vault name",
  description: "Containers for archives. Data is read back with retrieval jobs that take minutes to hours.",
  emptyText: "No vaults. Create a vault to get started.",
  columns: [
    { key: "name", label: "Vault name", kind: "link" },
    { key: "created", label: "Creation date", kind: "date" },
    { key: "archives", label: "Archives", kind: "count" },
    { key: "size", label: "Size", kind: "bytes" },
    { key: "lastInventory", label: "Last inventory", kind: "date" },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],

  async list(ctx) {
    const out: Row[] = [];
    let marker: string | undefined;
    do {
      const r = await ctx.clients.glacier.send(new ListVaultsCommand({ accountId: ACCOUNT, marker }));
      out.push(...(r.VaultList ?? []).map(vaultRow));
      marker = r.Marker;
    } while (marker);
    return out;
  },

  async get(ctx, name) {
    const v = await ctx.clients.glacier.send(new DescribeVaultCommand({ accountId: ACCOUNT, vaultName: name }));
    // A denied ListJobs must not hide the vault itself.
    let jobsError: string | null = null;
    const jobs = await listJobs(ctx, name).catch((err: unknown) => {
      jobsError = errorMessage(err);
      return [] as GlacierJobDescription[];
    });
    return {
      summary: {
        "Vault name": v.VaultName ?? name,
        ARN: v.VaultARN ?? null,
        "Creation date": v.CreationDate ?? null,
        "Number of archives": v.NumberOfArchives ?? 0,
        "Size (bytes)": v.SizeInBytes ?? 0,
        "Last inventory": v.LastInventoryDate ?? "Not yet inventoried",
      },
      tabs: [
        {
          id: "jobs",
          label: "Jobs",
          kind: "table",
          columns: jobColumns,
          data: jobs.map(jobRow),
          description: "Archive and inventory retrieval jobs. Vault counts and sizes are updated by inventory, about once a day on AWS.",
          emptyText: jobsError ? `Could not list jobs: ${jobsError}` : "No jobs. Use Actions → Initiate inventory retrieval to list the archives in this vault.",
        },
      ],
    };
  },

  create: {
    title: "Create vault",
    description: "Creates a vault with CreateVault.",
    fields: [
      {
        name: "name", label: "Vault name", kind: "text", required: true, section: "Vault details", placeholder: "my-vault",
        help: "Up to 255 characters: letters, numbers, hyphens, underscores and periods. Must be unique in this Region.",
        validate: { pattern: VAULT_NAME, message: "Use up to 255 letters, numbers, hyphens, underscores or periods." },
      },
    ],
    async run(ctx, v) {
      const name = String(v.name);
      await ctx.clients.glacier.send(new CreateVaultCommand({ accountId: ACCOUNT, vaultName: name }));
      return name;
    },
  },

  actions: [
    {
      id: "upload-archive",
      label: "Upload archive",
      fields: [
        { name: "body", label: "Archive content (text)", kind: "textarea", required: true, help: "Small text archives only here; use the CLI or an SDK for files.", validate: { max: 1_000_000, message: "At most 1 MB here." } },
        { name: "description", label: "Archive description", kind: "text", validate: { max: 1024, message: "At most 1024 characters." } },
      ],
      async run(ctx, vault, v) {
        const r = await ctx.clients.glacier.send(
          new UploadArchiveCommand({ accountId: ACCOUNT, vaultName: vault, body: Buffer.from(String(v.body), "utf8"), archiveDescription: text(v.description) })
        );
        return { message: `Archive uploaded. Archive ID: ${r.archiveId ?? "(none returned)"}. Keep this ID: Glacier lists archives only through an inventory job.`, json: { archiveId: r.archiveId, checksum: r.checksum, location: r.location } };
      },
    },
    {
      id: "inventory",
      label: "Initiate inventory retrieval",
      fields: [{ name: "format", label: "Output format", kind: "radio", required: true, default: "JSON", options: [{ value: "JSON", label: "JSON" }, { value: "CSV", label: "CSV" }] }],
      async run(ctx, vault, v) {
        const r = await ctx.clients.glacier.send(new InitiateJobCommand({ accountId: ACCOUNT, vaultName: vault, jobParameters: { Type: "inventory-retrieval", Format: v.format === "CSV" ? "CSV" : "JSON" } }));
        return { message: `Inventory retrieval job started. Job ID: ${r.jobId ?? "-"}. When it shows Succeeded on the Jobs tab, use Get job output.` };
      },
    },
    {
      id: "retrieve-archive",
      label: "Initiate archive retrieval",
      fields: [
        { name: "archiveId", label: "Archive ID", kind: "text", required: true },
        {
          name: "tier", label: "Retrieval tier", kind: "radio", required: true, default: "Standard",
          options: [
            { value: "Expedited", label: "Expedited: typically 1-5 minutes" },
            { value: "Standard", label: "Standard: typically 3-5 hours" },
            { value: "Bulk", label: "Bulk: typically 5-12 hours, lowest cost" },
          ],
        },
      ],
      async run(ctx, vault, v) {
        const r = await ctx.clients.glacier.send(
          new InitiateJobCommand({ accountId: ACCOUNT, vaultName: vault, jobParameters: { Type: "archive-retrieval", ArchiveId: String(v.archiveId), Tier: typeof v.tier === "string" && v.tier !== "" ? v.tier : "Standard" } })
        );
        return { message: `Archive retrieval job started. Job ID: ${r.jobId ?? "-"}.` };
      },
    },
    {
      id: "job-output",
      label: "Get job output",
      fields: [{ name: "jobId", label: "Job ID", kind: "text", required: true, help: "Copy it from the Jobs tab. The job must have succeeded." }],
      async run(ctx, vault, v) {
        const jobId = String(v.jobId);
        const job = await ctx.clients.glacier.send(new DescribeJobCommand({ accountId: ACCOUNT, vaultName: vault, jobId }));
        if (!job.Completed) return { message: `Job ${jobId} is ${job.StatusCode ?? "not complete"}. Try again when it has succeeded.` };
        const out = await ctx.clients.glacier.send(new GetJobOutputCommand({ accountId: ACCOUNT, vaultName: vault, jobId }));
        const body = out.body ? await out.body.transformToString() : "";
        const shown = body.length > MAX_INLINE_OUTPUT ? `${body.slice(0, MAX_INLINE_OUTPUT)}\n… (truncated, ${body.length} characters)` : body;
        if (job.Action === "InventoryRetrieval" && out.contentType?.includes("json")) {
          try {
            return { message: `Inventory output (${out.contentType}).`, json: JSON.parse(body) };
          } catch {
            // fall through to plain text
          }
        }
        return { message: `Job output (${out.contentType ?? "unknown type"}, ${body.length} characters):`, json: shown };
      },
    },
    {
      id: "delete-archive",
      label: "Delete archive",
      danger: true,
      fields: [{ name: "archiveId", label: "Archive ID", kind: "text", required: true }],
      async run(ctx, vault, v) {
        await ctx.clients.glacier.send(new DeleteArchiveCommand({ accountId: ACCOUNT, vaultName: vault, archiveId: String(v.archiveId) }));
        return { message: "Archive deleted. The vault's archive count changes after the next inventory." };
      },
    },
  ],

  delete: {
    confirmText: "name",
    async run(ctx, name) {
      await ctx.clients.glacier.send(new DeleteVaultCommand({ accountId: ACCOUNT, vaultName: name }));
    },
  },
};

export const glacierService: ServiceDef = {
  id: "glacier",
  name: "Amazon S3 Glacier",
  category: "Storage",
  description: "Vault-based archive storage for data you rarely read, retrieved through jobs.",
  resources: [vaults],
  notSupported: [
    "Vault notifications (SetVaultNotifications / GetVaultNotifications)",
    "Vault access policies",
    "Vault Lock",
    "Vault tags",
    "Multipart uploads",
    "Data retrieval policies",
    "Provisioned capacity",
  ],
};
