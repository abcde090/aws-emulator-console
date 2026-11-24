/** CodeBuild build projects. The project screen is hand-built (src/app/codebuild/build-projects/[name]) to link its build history. */

import {
  BatchGetBuildsCommand,
  BatchGetProjectsCommand,
  CreateProjectCommand,
  DeleteProjectCommand,
  InvalidateProjectCacheCommand,
  ListBuildsForProjectCommand,
  ListProjectsCommand,
  StartBuildCommand,
  UpdateProjectCommand,
  type CodeBuildClient,
  type ComputeType,
  type Project,
  type ProjectArtifacts,
  type ProjectEnvironment,
  type ProjectSource,
} from "@aws-sdk/client-codebuild";
import { ListRepositoriesCommand } from "@aws-sdk/client-codecommit";
import { CreateRoleCommand, ListRolesCommand, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import { ListBucketsCommand } from "@aws-sdk/client-s3";
import type { Ctx, FieldDef, FieldValues, Option, ResourceDef, Row, Tag } from "../../console/types.ts";
import {
  CODEBUILD_TRUST_POLICY,
  codebuildBasePolicy,
  codecommitUrl,
  COMPUTE_TYPES,
  DEFAULT_BUILDSPEC,
  defaultRoleName,
  envVarsFromTags,
  MANAGED_IMAGES,
  PROJECT_NAME,
  sourceLabel,
  sourceRepository,
} from "./helpers.ts";

const optional = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const numberOr = (v: unknown, d: number): number => (typeof v === "number" ? v : d);

async function projectNames(cb: CodeBuildClient): Promise<string[]> {
  const names: string[] = [];
  let token: string | undefined;
  do {
    const page = await cb.send(new ListProjectsCommand({ nextToken: token, sortBy: "NAME", sortOrder: "ASCENDING" }));
    names.push(...(page.projects ?? []));
    token = page.nextToken;
  } while (token);
  return names;
}

export async function getProjects(cb: CodeBuildClient, names: string[]): Promise<Project[]> {
  const out: Project[] = [];
  for (let i = 0; i < names.length; i += 100) {
    const r = await cb.send(new BatchGetProjectsCommand({ names: names.slice(i, i + 100) }));
    out.push(...(r.projects ?? []));
  }
  return out;
}

export async function getProject(cb: CodeBuildClient, name: string): Promise<Project> {
  const [p] = await getProjects(cb, [name]);
  if (!p) throw new Error(`Project ${name} was not found.`);
  return p;
}

export async function projectOptions(ctx: Ctx): Promise<Option[]> {
  return (await projectNames(ctx.clients.codebuild)).map((n) => ({ value: n, label: n }));
}

async function repoOptions(ctx: Ctx): Promise<Option[]> {
  const out: Option[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.codecommit.send(new ListRepositoriesCommand({ sortBy: "repositoryName", order: "ascending", nextToken: token }));
    for (const x of r.repositories ?? []) if (x.repositoryName) out.push({ value: x.repositoryName, label: x.repositoryName });
    token = r.nextToken;
  } while (token);
  return out;
}

export async function bucketOptions(ctx: Ctx): Promise<Option[]> {
  const r = await ctx.clients.s3.send(new ListBucketsCommand({}));
  return (r.Buckets ?? []).filter((b) => b.Name).map((b) => ({ value: b.Name as string, label: b.Name as string }));
}

/** IAM roles a service may assume, for "Existing service role". */
export function roleOptions(service: string) {
  return async (ctx: Ctx): Promise<Option[]> => {
    const roles: Option[] = [];
    let marker: string | undefined;
    do {
      const r = await ctx.clients.iam.send(new ListRolesCommand({ Marker: marker }));
      for (const role of r.Roles ?? []) {
        const doc = decodeURIComponent(role.AssumeRolePolicyDocument ?? "");
        if (role.Arn && doc.includes(service)) roles.push({ value: role.Arn, label: role.RoleName ?? role.Arn });
      }
      marker = r.IsTruncated ? r.Marker : undefined;
    } while (marker);
    return roles;
  };
}

async function createServiceRole(ctx: Ctx, project: string, requested: string | undefined): Promise<string> {
  const roleName = requested ?? defaultRoleName(project);
  const r = await ctx.clients.iam.send(new CreateRoleCommand({ RoleName: roleName, Path: "/service-role/", AssumeRolePolicyDocument: CODEBUILD_TRUST_POLICY, Description: `Service role for CodeBuild project ${project}` }));
  await ctx.clients.iam.send(
    new PutRolePolicyCommand({ RoleName: roleName, PolicyName: `CodeBuildBasePolicy-${project}-${ctx.region}`.slice(0, 128), PolicyDocument: codebuildBasePolicy(ctx.region, ctx.accountId, project) })
  );
  if (!r.Role?.Arn) throw new Error("IAM returned no ARN for the new service role.");
  return r.Role.Arn;
}

function sourceFrom(ctx: Ctx, v: FieldValues): ProjectSource {
  const inline = v.buildspecMode !== "file";
  const buildspec = inline ? optional(v.buildspec) : optional(v.buildspecFile);
  switch (v.sourceType) {
    case "CODECOMMIT":
      if (!optional(v.repository)) throw new Error("Choose a CodeCommit repository.");
      return { type: "CODECOMMIT", location: codecommitUrl(ctx.region, String(v.repository)), buildspec };
    case "S3":
      if (!optional(v.sourceBucket) || !optional(v.sourceKey)) throw new Error("Choose a bucket and enter the S3 object key of the source zip.");
      return { type: "S3", location: `${String(v.sourceBucket)}/${String(v.sourceKey)}`, buildspec };
    default:
      if (!inline || !buildspec) throw new Error("A project with no source needs build commands: choose \"Insert build commands\".");
      return { type: "NO_SOURCE", buildspec };
  }
}

function artifactsFrom(v: FieldValues): ProjectArtifacts {
  if (v.artifactType !== "S3") return { type: "NO_ARTIFACTS" };
  if (!optional(v.artifactBucket)) throw new Error("Choose an artifacts bucket.");
  return { type: "S3", location: String(v.artifactBucket), name: optional(v.artifactName), packaging: v.packaging === "ZIP" ? "ZIP" : "NONE" };
}

/** The managed images, plus the project's current image when it isn't one of them. */
async function imageOptions(ctx: Ctx, id?: string): Promise<Option[]> {
  if (!id) return MANAGED_IMAGES;
  const image = (await getProject(ctx.clients.codebuild, id)).environment?.image;
  return image && !MANAGED_IMAGES.some((o) => o.value === image) ? [...MANAGED_IMAGES, { value: image, label: image }] : MANAGED_IMAGES;
}

const environmentFields = (section?: string): FieldDef[] => [
  { name: "image", label: "Image", kind: "select", required: true, options: imageOptions, default: MANAGED_IMAGES[0].value, section, help: "Managed images maintained by CodeBuild." },
  { name: "computeType", label: "Compute", kind: "select", required: true, options: COMPUTE_TYPES, default: "BUILD_GENERAL1_SMALL", section },
  { name: "privileged", label: "Privileged: enable this flag if you want to build Docker images", kind: "checkbox", default: false, section },
  { name: "envVars", label: "Environment variables", kind: "tags", section, help: "Plaintext variables: Key is the variable name, Value its value." },
];

function environmentFrom(v: FieldValues) {
  const image = optional(v.image) ?? MANAGED_IMAGES[0].value;
  return {
    type: image.includes("aarch64") ? ("ARM_CONTAINER" as const) : ("LINUX_CONTAINER" as const),
    image,
    computeType: (optional(v.computeType) ?? "BUILD_GENERAL1_SMALL") as ComputeType,
    privilegedMode: v.privileged === true,
    environmentVariables: envVarsFromTags(v.envVars),
  };
}

/**
 * The edited environment applied to the project's current one: settings the dialog doesn't
 * show (certificate, pull credentials, Parameter Store / Secrets Manager variables) are kept.
 */
function editedEnvironment(current: ProjectEnvironment | undefined, v: FieldValues): ProjectEnvironment {
  const edited = environmentFrom(v);
  const image = edited.image;
  const sameImage = current?.image === image;
  const secretVars = (current?.environmentVariables ?? []).filter((e) => e.type && e.type !== "PLAINTEXT");
  return {
    ...current,
    ...edited,
    type: sameImage && current?.type ? current.type : edited.type,
    environmentVariables: [...edited.environmentVariables, ...secretVars],
  };
}

function plaintextVars(p: Project): Tag[] {
  return (p.environment?.environmentVariables ?? []).filter((e) => !e.type || e.type === "PLAINTEXT").map((e) => ({ Key: e.name ?? "", Value: e.value ?? "" }));
}

function configTab(p: Project): Row {
  return {
    "Source provider": sourceLabel(p.source?.type),
    "Source location": p.source?.location ?? null,
    "Source version": p.sourceVersion ?? null,
    "Buildspec": p.source?.buildspec && p.source.buildspec.includes("\n") ? "Inserted build commands (see Buildspec)" : p.source?.buildspec ?? "buildspec.yml (from source)",
    "Environment type": p.environment?.type ?? null,
    Image: p.environment?.image ?? null,
    "Compute type": p.environment?.computeType ?? null,
    "Privileged mode": p.environment?.privilegedMode ? "Enabled" : "Disabled",
    "Image pull credentials": p.environment?.imagePullCredentialsType ?? null,
    "Service role": p.serviceRole ?? null,
    "Timeout (minutes)": p.timeoutInMinutes ?? null,
    "Queued timeout (minutes)": p.queuedTimeoutInMinutes ?? null,
    "Encryption key": p.encryptionKey ?? null,
    Cache: p.cache?.type ?? null,
    "Build badge": p.badge?.badgeEnabled ? p.badge.badgeRequestUrl ?? "Enabled" : "Disabled",
    "Project visibility": p.projectVisibility ?? null,
  };
}

export const projects: ResourceDef = {
  id: "build-projects",
  name: "Build projects",
  singular: "build project",
  idField: "name",
  nameField: "name",
  description: "A build project defines how CodeBuild runs a build: source, environment, buildspec and artifacts.",
  emptyText: "No build projects. Create a build project to get started.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "sourceProvider", label: "Source provider", kind: "text" },
    { key: "repository", label: "Repository", kind: "text" },
    { key: "latestBuildStatus", label: "Latest build status", kind: "status" },
    { key: "description", label: "Description", kind: "text" },
    { key: "lastModified", label: "Last modified", kind: "date" },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],

  async list(ctx) {
    const cb = ctx.clients.codebuild;
    const ps = await getProjects(cb, await projectNames(cb));
    // The latest build status is secondary: a denied lookup leaves the column empty, not the page.
    const latestIds = await Promise.all(
      ps.map(async (p) => {
        try {
          return (await cb.send(new ListBuildsForProjectCommand({ projectName: p.name, sortOrder: "DESCENDING" }))).ids?.[0];
        } catch {
          return undefined;
        }
      })
    );
    const ids = latestIds.filter((x): x is string => typeof x === "string");
    const builds = ids.length ? await cb.send(new BatchGetBuildsCommand({ ids })).then((r) => r.builds ?? [], () => []) : [];
    const statusById = new Map(builds.map((b) => [b.id, b.buildStatus]));
    return ps.map((p, i) => ({
      name: p.name ?? "",
      sourceProvider: sourceLabel(p.source?.type),
      repository: sourceRepository(p.source?.type, p.source?.location),
      latestBuildStatus: latestIds[i] ? statusById.get(latestIds[i]) ?? null : null,
      description: p.description ?? null,
      lastModified: p.lastModified ?? null,
      arn: p.arn ?? null,
    }));
  },

  async get(ctx, name) {
    const p = await getProject(ctx.clients.codebuild, name);
    const logs = p.logsConfig;
    return {
      summary: {
        name: p.name ?? name,
        arn: p.arn ?? null,
        description: p.description ?? "-",
        source: sourceLabel(p.source?.type),
        serviceRole: p.serviceRole ?? null,
        created: p.created ?? null,
        lastModified: p.lastModified ?? null,
      },
      summaryLabels: { name: "Project name", arn: "ARN", description: "Description", source: "Source provider", serviceRole: "Service role", created: "Created", lastModified: "Last modified" },
      tabs: [
        { id: "details", label: "Project details", kind: "keyvalue", data: configTab(p) },
        {
          id: "buildspec",
          label: "Buildspec",
          kind: "text",
          data: p.source?.buildspec ?? "",
          emptyText: "This project uses the buildspec.yml file in the root of its source.",
        },
        {
          id: "env",
          label: "Environment variables",
          kind: "table",
          columns: [
            { key: "name", label: "Name", kind: "text" },
            { key: "value", label: "Value", kind: "code" },
            { key: "type", label: "Type", kind: "text" },
          ],
          data: (p.environment?.environmentVariables ?? []).map((e) => ({ name: e.name ?? "", value: e.value ?? "", type: e.type ?? "PLAINTEXT" })),
          emptyText: "No environment variables.",
        },
        {
          id: "artifacts",
          label: "Artifacts",
          kind: "keyvalue",
          data: {
            Type: p.artifacts?.type ?? null,
            Location: p.artifacts?.location ?? null,
            Name: p.artifacts?.name ?? null,
            Packaging: p.artifacts?.packaging ?? null,
            "Encryption disabled": p.artifacts?.encryptionDisabled ?? null,
          },
        },
        {
          id: "logs",
          label: "Logs",
          kind: "keyvalue",
          data: {
            "CloudWatch Logs": logs?.cloudWatchLogs?.status ?? "ENABLED",
            "Group name": logs?.cloudWatchLogs?.groupName ?? `/aws/codebuild/${p.name ?? name} (default)`,
            "Stream name": logs?.cloudWatchLogs?.streamName ?? "Build ID (default)",
            "S3 logs": logs?.s3Logs?.status ?? "DISABLED",
          },
        },
        {
          id: "tags",
          label: "Tags",
          kind: "table",
          columns: [
            { key: "Key", label: "Key", kind: "text" },
            { key: "Value", label: "Value", kind: "text" },
          ],
          data: (p.tags ?? []).map((t) => ({ Key: t.key ?? "", Value: t.value ?? "" })),
          emptyText: "No tags.",
        },
      ],
    };
  },

  create: {
    title: "Create build project",
    description: "Creates a CodeBuild project with CreateProject. A new service role is created in IAM first if you choose one.",
    fields: [
      { name: "name", label: "Project name", kind: "text", required: true, section: "Project configuration", placeholder: "my-build", help: "2-255 letters, numbers, hyphens and underscores, starting with a letter or number.", validate: { pattern: PROJECT_NAME, message: "Use 2-255 letters, numbers, hyphens or underscores, starting with a letter or number." } },
      { name: "description", label: "Description", kind: "textarea", section: "Project configuration", validate: { max: 255, message: "At most 255 characters." } },
      { name: "badge", label: "Enable build badge", kind: "checkbox", default: false, section: "Project configuration" },
      { name: "tags", label: "Tags", kind: "tags", section: "Project configuration" },
      {
        name: "sourceType", label: "Source provider", kind: "select", required: true, default: "CODECOMMIT", section: "Source",
        options: [
          { value: "CODECOMMIT", label: "AWS CodeCommit" },
          { value: "S3", label: "Amazon S3" },
          { value: "NO_SOURCE", label: "No source" },
        ],
      },
      { name: "repository", label: "Repository", kind: "select", options: repoOptions, section: "Source", showIf: { field: "sourceType", equals: "CODECOMMIT" } },
      { name: "sourceVersion", label: "Branch or commit ID", kind: "text", section: "Source", showIf: { field: "sourceType", equals: "CODECOMMIT" }, help: "e.g. refs/heads/main. Leave empty for the default branch." },
      { name: "sourceBucket", label: "Bucket", kind: "select", options: bucketOptions, section: "Source", showIf: { field: "sourceType", equals: "S3" } },
      { name: "sourceKey", label: "S3 object key or S3 folder", kind: "text", section: "Source", showIf: { field: "sourceType", equals: "S3" }, placeholder: "source/app.zip" },
      ...environmentFields("Environment"),
      {
        name: "roleMode", label: "Service role", kind: "radio", default: "new", section: "Environment",
        options: [
          { value: "new", label: "New service role" },
          { value: "existing", label: "Existing service role" },
        ],
      },
      { name: "roleName", label: "Role name", kind: "text", section: "Environment", showIf: { field: "roleMode", equals: "new" }, help: "Leave empty for codebuild-<project name>-service-role.", validate: { pattern: "[\\w+=,.@-]{1,64}", message: "Up to 64 letters, numbers and +=,.@_- characters." } },
      { name: "roleArn", label: "Role ARN", kind: "select", options: roleOptions("codebuild.amazonaws.com"), section: "Environment", showIf: { field: "roleMode", equals: "existing" }, help: "Roles whose trust policy allows codebuild.amazonaws.com." },
      { name: "timeout", label: "Timeout (minutes)", kind: "number", default: 60, section: "Environment", validate: { min: 5, max: 2160, message: "Between 5 minutes and 36 hours (2160)." } },
      { name: "queuedTimeout", label: "Queued timeout (minutes)", kind: "number", default: 480, section: "Environment", validate: { min: 5, max: 480, message: "Between 5 minutes and 8 hours (480)." } },
      {
        name: "buildspecMode", label: "Build specifications", kind: "radio", default: "insert", section: "Buildspec",
        options: [
          { value: "insert", label: "Insert build commands" },
          { value: "file", label: "Use a buildspec file" },
        ],
      },
      { name: "buildspec", label: "Build commands (buildspec YAML)", kind: "textarea", default: DEFAULT_BUILDSPEC, section: "Buildspec", showIf: { field: "buildspecMode", equals: "insert" } },
      { name: "buildspecFile", label: "Buildspec name", kind: "text", section: "Buildspec", showIf: { field: "buildspecMode", equals: "file" }, help: "Leave empty for buildspec.yml in the source root." },
      {
        name: "artifactType", label: "Type", kind: "select", default: "NO_ARTIFACTS", section: "Artifacts",
        options: [
          { value: "NO_ARTIFACTS", label: "No artifacts" },
          { value: "S3", label: "Amazon S3" },
        ],
      },
      { name: "artifactBucket", label: "Bucket name", kind: "select", options: bucketOptions, section: "Artifacts", showIf: { field: "artifactType", equals: "S3" } },
      { name: "artifactName", label: "Name", kind: "text", section: "Artifacts", showIf: { field: "artifactType", equals: "S3" }, help: "Leave empty to use the project name." },
      {
        name: "packaging", label: "Artifacts packaging", kind: "radio", default: "NONE", section: "Artifacts", showIf: { field: "artifactType", equals: "S3" },
        options: [
          { value: "NONE", label: "None" },
          { value: "ZIP", label: "Zip" },
        ],
      },
      { name: "cwLogs", label: "CloudWatch logs", kind: "checkbox", default: true, section: "Logs" },
      { name: "logGroup", label: "Group name", kind: "text", section: "Logs", showIf: { field: "cwLogs", equals: true }, help: "Leave empty for /aws/codebuild/<project name>." },
      { name: "logStream", label: "Stream name prefix", kind: "text", section: "Logs", showIf: { field: "cwLogs", equals: true } },
    ],
    async run(ctx, v) {
      const name = String(v.name);
      const source = sourceFrom(ctx, v);
      const artifacts = artifactsFrom(v);
      let role: string;
      if (v.roleMode === "existing") {
        if (!optional(v.roleArn)) throw new Error("Choose an existing service role.");
        role = String(v.roleArn);
      } else role = await createServiceRole(ctx, name, optional(v.roleName));
      const tags = Array.isArray(v.tags) ? (v.tags as Tag[]).map((t) => ({ key: t.Key, value: t.Value })) : [];
      await ctx.clients.codebuild.send(
        new CreateProjectCommand({
          name,
          description: optional(v.description),
          source,
          sourceVersion: v.sourceType === "CODECOMMIT" ? optional(v.sourceVersion) : undefined,
          artifacts,
          environment: environmentFrom(v),
          serviceRole: role,
          timeoutInMinutes: numberOr(v.timeout, 60),
          queuedTimeoutInMinutes: numberOr(v.queuedTimeout, 480),
          badgeEnabled: v.badge === true,
          logsConfig: {
            cloudWatchLogs: v.cwLogs === false ? { status: "DISABLED" } : { status: "ENABLED", groupName: optional(v.logGroup), streamName: optional(v.logStream) },
          },
          tags: tags.length ? tags : undefined,
        })
      );
      return name;
    },
  },

  actions: [
    {
      id: "start-build",
      label: "Start build",
      fields: [
        { name: "sourceVersion", label: "Source version", kind: "text", help: "A branch (refs/heads/main), commit ID or S3 object version. Leave empty for the project's default." },
        { name: "buildspecOverride", label: "Buildspec override", kind: "textarea", help: "YAML build commands used for this build only." },
        { name: "envVars", label: "Environment variables override", kind: "tags", help: "Added to (or replacing) the project's variables for this build only." },
        { name: "timeout", label: "Timeout override (minutes)", kind: "number", validate: { min: 5, max: 2160, message: "Between 5 and 2160." } },
      ],
      async run(ctx, name, v) {
        const env = envVarsFromTags(v.envVars);
        const r = await ctx.clients.codebuild.send(
          new StartBuildCommand({
            projectName: name,
            sourceVersion: optional(v.sourceVersion),
            buildspecOverride: optional(v.buildspecOverride),
            environmentVariablesOverride: env.length ? env : undefined,
            timeoutInMinutesOverride: typeof v.timeout === "number" ? v.timeout : undefined,
          })
        );
        const b = r.build;
        return { message: `Started build ${b?.id ?? "(no ID returned)"} (build number ${b?.buildNumber ?? "-"}). It is ${b?.buildStatus ?? "unknown"}; open Build history to follow its phases and logs.` };
      },
    },
    {
      id: "edit-project",
      label: "Edit project configuration",
      fields: [
        { name: "description", label: "Description", kind: "textarea", validate: { max: 255, message: "At most 255 characters." } },
        { name: "timeout", label: "Timeout (minutes)", kind: "number", required: true, default: 60, validate: { min: 5, max: 2160, message: "Between 5 and 2160." } },
        { name: "queuedTimeout", label: "Queued timeout (minutes)", kind: "number", required: true, default: 480, validate: { min: 5, max: 480, message: "Between 5 and 480." } },
        { name: "badge", label: "Enable build badge", kind: "checkbox", default: false },
      ],
      async initialValues(ctx, name) {
        const p = await getProject(ctx.clients.codebuild, name);
        return { description: p.description ?? "", timeout: p.timeoutInMinutes ?? 60, queuedTimeout: p.queuedTimeoutInMinutes ?? 480, badge: p.badge?.badgeEnabled === true };
      },
      async run(ctx, name, v) {
        await ctx.clients.codebuild.send(
          new UpdateProjectCommand({ name, description: typeof v.description === "string" ? v.description : "", timeoutInMinutes: numberOr(v.timeout, 60), queuedTimeoutInMinutes: numberOr(v.queuedTimeout, 480), badgeEnabled: v.badge === true })
        );
        return { message: "Project configuration saved." };
      },
    },
    {
      id: "edit-environment",
      label: "Edit environment",
      fields: environmentFields(),
      async initialValues(ctx, name) {
        const p = await getProject(ctx.clients.codebuild, name);
        const env = p.environment;
        return {
          image: env?.image ?? MANAGED_IMAGES[0].value,
          computeType: env?.computeType ?? "BUILD_GENERAL1_SMALL",
          privileged: env?.privilegedMode === true,
          envVars: plaintextVars(p),
        };
      },
      async run(ctx, name, v) {
        const p = await getProject(ctx.clients.codebuild, name);
        await ctx.clients.codebuild.send(new UpdateProjectCommand({ name, environment: editedEnvironment(p.environment, v) }));
        return { message: "Environment saved. It applies to the next build." };
      },
    },
    {
      id: "edit-buildspec",
      label: "Edit buildspec",
      fields: [
        {
          name: "buildspec",
          label: "Buildspec",
          kind: "textarea",
          help: "Build commands (buildspec YAML), or the name of a buildspec file in the source. Leave empty to use buildspec.yml from the source root.",
        },
      ],
      async initialValues(ctx, name) {
        const p = await getProject(ctx.clients.codebuild, name);
        return { buildspec: p.source?.buildspec ?? "" };
      },
      async run(ctx, name, v) {
        const p = await getProject(ctx.clients.codebuild, name);
        if (!p.source?.type) throw new Error("The project has no source configuration.");
        const buildspec = optional(v.buildspec);
        if (!buildspec && p.source.type === "NO_SOURCE") throw new Error("A project with no source needs build commands.");
        await ctx.clients.codebuild.send(new UpdateProjectCommand({ name, source: { ...p.source, buildspec } }));
        return { message: buildspec ? "Buildspec saved." : "Buildspec cleared: builds use buildspec.yml from the source." };
      },
    },
    {
      id: "edit-tags",
      label: "Edit tags",
      fields: [{ name: "tags", label: "Tags", kind: "tags" }],
      async initialValues(ctx, name) {
        const p = await getProject(ctx.clients.codebuild, name);
        return { tags: (p.tags ?? []).map((t) => ({ Key: t.key ?? "", Value: t.value ?? "" })) };
      },
      async run(ctx, name, v) {
        // UpdateProject takes the project's complete tag list; the dialog starts from the current tags.
        const tags = Array.isArray(v.tags) ? (v.tags as Tag[]).map((t) => ({ key: t.Key, value: t.Value })) : [];
        await ctx.clients.codebuild.send(new UpdateProjectCommand({ name, tags }));
        return { message: `The project now has ${tags.length} tag${tags.length === 1 ? "" : "s"}.` };
      },
    },
    {
      id: "clear-cache",
      label: "Clear cache",
      confirm: "Clears the project's build cache (InvalidateProjectCache).",
      async run(ctx, name) {
        await ctx.clients.codebuild.send(new InvalidateProjectCacheCommand({ projectName: name }));
        return { message: "Cache cleared." };
      },
    },
  ],

  delete: {
    confirmText: "delete",
    async run(ctx, name) {
      await ctx.clients.codebuild.send(new DeleteProjectCommand({ name }));
    },
  },
  detailHref: "build-projects/{id}",
};
