/** EC2 Auto Scaling groups: create from a launch template, capacity, scaling policies, activity. */

import {
  CreateAutoScalingGroupCommand,
  DeleteAutoScalingGroupCommand,
  DeletePolicyCommand,
  DescribeAutoScalingGroupsCommand,
  DescribePoliciesCommand,
  DescribeScalingActivitiesCommand,
  DescribeScheduledActionsCommand,
  ExecutePolicyCommand,
  PutScalingPolicyCommand,
  PutScheduledUpdateGroupActionCommand,
  SetDesiredCapacityCommand,
  StartInstanceRefreshCommand,
  UpdateAutoScalingGroupCommand,
  type AutoScalingGroup,
  type MetricType,
} from "@aws-sdk/client-auto-scaling";
import type { Ctx, Option, ResourceDef, Tag } from "../../console/types.ts";
import { errorText, strList } from "./helpers.ts";
import { launchTemplateOptions, subnetOptions, targetGroupOptions } from "./options.ts";

const ASG_NAME = "[\\x21-\\x7E][\\x20-\\x7E]{0,254}";

async function oneGroup(ctx: Ctx, name: string): Promise<AutoScalingGroup> {
  const g = (await ctx.clients.autoscaling.send(new DescribeAutoScalingGroupsCommand({ AutoScalingGroupNames: [name] }))).AutoScalingGroups?.[0];
  if (!g) throw new Error(`Auto Scaling group ${name} was not found.`);
  return g;
}

function templateText(g: AutoScalingGroup): string | null {
  const lt = g.LaunchTemplate ?? g.MixedInstancesPolicy?.LaunchTemplate?.LaunchTemplateSpecification;
  if (lt) return `${lt.LaunchTemplateName ?? lt.LaunchTemplateId} | Version ${lt.Version ?? "$Default"}`;
  return g.LaunchConfigurationName ?? null;
}

const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

/** The group's scaling policies of one type, for the Execute policy picker. */
async function policyOptions(ctx: Ctx, name?: string): Promise<Option[]> {
  if (!name) return [];
  const out: Option[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.autoscaling.send(new DescribePoliciesCommand({ AutoScalingGroupName: name, NextToken: token }));
    for (const p of r.ScalingPolicies ?? []) if (p.PolicyName && p.PolicyType !== "TargetTrackingScaling") out.push({ value: p.PolicyName, label: `${p.PolicyName} (${p.PolicyType ?? "SimpleScaling"})` });
    token = r.NextToken;
  } while (token);
  return out;
}

/** A secondary read for a detail tab: its data, or the error to show in place of it. */
async function tabRead<T>(p: Promise<T>): Promise<{ value: T | null; error: string | null }> {
  try {
    return { value: await p, error: null };
  } catch (err: unknown) {
    return { value: null, error: errorText(err) };
  }
}

export const autoScalingGroups: ResourceDef = {
  id: "auto-scaling-groups",
  name: "Auto Scaling Groups",
  singular: "Auto Scaling group",
  idField: "name",
  nameField: "Name",
  description: "Groups of instances that scale between a minimum and maximum, replacing unhealthy instances.",
  emptyText: "You don't have any Auto Scaling groups.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "template", label: "Launch template/configuration", kind: "text" },
    { key: "instances", label: "Instances", kind: "count" },
    { key: "status", label: "Status", kind: "status" },
    { key: "desired", label: "Desired capacity", kind: "count" },
    { key: "min", label: "Min", kind: "count" },
    { key: "max", label: "Max", kind: "count" },
    { key: "azs", label: "Availability Zones", kind: "text" },
    { key: "created", label: "Creation time", kind: "date", hidden: true },
  ],
  async list(ctx) {
    const out = [];
    let token: string | undefined;
    do {
      const r = await ctx.clients.autoscaling.send(new DescribeAutoScalingGroupsCommand({ NextToken: token }));
      for (const g of r.AutoScalingGroups ?? [])
        out.push({ name: g.AutoScalingGroupName ?? "", template: templateText(g), instances: g.Instances?.length ?? 0, status: g.Status ?? null, desired: g.DesiredCapacity ?? null, min: g.MinSize ?? null, max: g.MaxSize ?? null, azs: (g.AvailabilityZones ?? []).join(", ") || null, created: g.CreatedTime ?? null });
      token = r.NextToken;
    } while (token);
    return out;
  },
  async get(ctx, name) {
    const g = await oneGroup(ctx, name);
    const [act, pol, sched] = await Promise.all([
      tabRead(ctx.clients.autoscaling.send(new DescribeScalingActivitiesCommand({ AutoScalingGroupName: name, MaxRecords: 50 }))),
      tabRead(ctx.clients.autoscaling.send(new DescribePoliciesCommand({ AutoScalingGroupName: name }))),
      tabRead(ctx.clients.autoscaling.send(new DescribeScheduledActionsCommand({ AutoScalingGroupName: name }))),
    ]);
    const activities = act.value ?? { Activities: [] };
    const policies = pol.value ?? { ScalingPolicies: [] };
    const scheduled = sched.value ?? { ScheduledUpdateGroupActions: [] };
    return {
      summary: { Name: name, "Desired capacity": g.DesiredCapacity ?? null, "Minimum capacity": g.MinSize ?? null, "Maximum capacity": g.MaxSize ?? null, "Launch template": templateText(g), "Date created": g.CreatedTime ?? null, ARN: g.AutoScalingGroupARN ?? null },
      tabs: [
        {
          id: "details",
          label: "Details",
          kind: "keyvalue",
          data: {
            "Availability Zones": (g.AvailabilityZones ?? []).join(", ") || null,
            Subnets: g.VPCZoneIdentifier || null,
            "Health check type": g.HealthCheckType ?? null,
            "Health check grace period": g.HealthCheckGracePeriod ?? null,
            "Default cooldown": g.DefaultCooldown ?? null,
            "Target groups": (g.TargetGroupARNs ?? []).map((a) => a.split("/")[1] ?? a).join(", ") || null,
            "Termination policies": (g.TerminationPolicies ?? []).join(", ") || null,
            "Capacity rebalance": g.CapacityRebalance ?? null,
            "Service-linked role": g.ServiceLinkedRoleARN ?? null,
          },
        },
        {
          id: "activity",
          label: "Activity",
          kind: "table",
          columns: [
            { key: "status", label: "Status", kind: "status" },
            { key: "description", label: "Description", kind: "text" },
            { key: "cause", label: "Cause", kind: "text" },
            { key: "start", label: "Start time", kind: "date" },
            { key: "end", label: "End time", kind: "date" },
          ],
          data: (activities.Activities ?? []).map((a) => ({ status: a.StatusCode ?? null, description: a.Description ?? null, cause: a.Cause ?? null, start: a.StartTime ?? null, end: a.EndTime ?? null })),
          emptyText: act.error ? `Activities could not be read: ${act.error}` : "No activities found.",
        },
        {
          id: "policies",
          label: "Automatic scaling",
          kind: "table",
          columns: [
            { key: "name", label: "Policy name", kind: "text" },
            { key: "type", label: "Policy type", kind: "text" },
            { key: "detail", label: "Settings", kind: "text" },
            { key: "enabled", label: "Enabled", kind: "boolean" },
            { key: "alarms", label: "Alarms", kind: "text" },
          ],
          data: (policies.ScalingPolicies ?? []).map((p) => ({
            name: p.PolicyName ?? null,
            type: p.PolicyType ?? null,
            detail: p.TargetTrackingConfiguration
              ? `${p.TargetTrackingConfiguration.PredefinedMetricSpecification?.PredefinedMetricType ?? "custom metric"} target ${p.TargetTrackingConfiguration.TargetValue}`
              : `${p.AdjustmentType ?? ""} ${p.ScalingAdjustment ?? ""}`.trim() || null,
            enabled: p.Enabled ?? null,
            alarms: (p.Alarms ?? []).map((a) => a.AlarmName).join(", ") || null,
          })),
          emptyText: pol.error ? `Scaling policies could not be read: ${pol.error}` : "No dynamic scaling policies. Use Actions › Create dynamic scaling policy.",
        },
        {
          id: "scheduled",
          label: "Scheduled actions",
          kind: "table",
          columns: [
            { key: "name", label: "Name", kind: "text" },
            { key: "recurrence", label: "Recurrence", kind: "code" },
            { key: "desired", label: "Desired", kind: "count" },
            { key: "min", label: "Min", kind: "count" },
            { key: "max", label: "Max", kind: "count" },
            { key: "start", label: "Start time", kind: "date" },
          ],
          data: (scheduled.ScheduledUpdateGroupActions ?? []).map((s) => ({ name: s.ScheduledActionName ?? null, recurrence: s.Recurrence ?? null, desired: s.DesiredCapacity ?? null, min: s.MinSize ?? null, max: s.MaxSize ?? null, start: s.StartTime ?? null })),
          emptyText: sched.error ? `Scheduled actions could not be read: ${sched.error}` : "No scheduled actions.",
        },
        {
          id: "instances",
          label: "Instance management",
          kind: "table",
          columns: [
            { key: "id", label: "Instance ID", kind: "text" },
            { key: "lifecycle", label: "Lifecycle", kind: "status" },
            { key: "type", label: "Instance type", kind: "text" },
            { key: "az", label: "Availability Zone", kind: "text" },
            { key: "health", label: "Health status", kind: "status" },
            { key: "protected", label: "Protected from scale in", kind: "boolean" },
          ],
          data: (g.Instances ?? []).map((i) => ({ id: i.InstanceId ?? null, lifecycle: i.LifecycleState ?? null, type: i.InstanceType ?? null, az: i.AvailabilityZone ?? null, health: i.HealthStatus ?? null, protected: i.ProtectedFromScaleIn ?? null })),
          emptyText: "No instances.",
        },
        { id: "tags", label: "Tags", kind: "table", columns: [{ key: "Key", label: "Key", kind: "text" }, { key: "Value", label: "Value", kind: "text" }, { key: "propagate", label: "Tag new instances", kind: "boolean" }], data: (g.Tags ?? []).map((t) => ({ Key: t.Key ?? "", Value: t.Value ?? "", propagate: t.PropagateAtLaunch ?? null })), emptyText: "No tags." },
      ],
    };
  },
  create: {
    title: "Create Auto Scaling group",
    description: "Creates an Auto Scaling group from a launch template with CreateAutoScalingGroup.",
    fields: [
      { name: "name", label: "Auto Scaling group name", kind: "text", required: true, section: "Choose launch template", validate: { pattern: ASG_NAME, message: "Up to 255 printable characters." } },
      { name: "launchTemplate", label: "Launch template", kind: "select", required: true, options: launchTemplateOptions, section: "Choose launch template", help: "The template needs an AMI and an instance type." },
      { name: "version", label: "Version", kind: "select", default: "$Default", section: "Choose launch template", options: [{ value: "$Default", label: "Default ($Default)" }, { value: "$Latest", label: "Latest ($Latest)" }] },
      { name: "subnets", label: "Availability Zones and subnets", kind: "multiselect", required: true, options: subnetOptions, section: "Choose instance launch options" },
      { name: "targetGroups", label: "Attach to existing load balancer target groups", kind: "multiselect", options: targetGroupOptions, section: "Integrate with other services" },
      { name: "healthCheckType", label: "Health check type", kind: "radio", default: "EC2", section: "Integrate with other services", options: [{ value: "EC2", label: "EC2 health checks (always on)" }, { value: "ELB", label: "Turn on Elastic Load Balancing health checks" }] },
      { name: "grace", label: "Health check grace period (seconds)", kind: "number", default: 300, section: "Integrate with other services", validate: { min: 0, max: 7200, message: "Between 0 and 7200." } },
      { name: "desired", label: "Desired capacity", kind: "number", default: 1, required: true, section: "Configure group size and scaling", validate: { min: 0, max: 100, message: "Between 0 and 100." } },
      { name: "min", label: "Min desired capacity", kind: "number", default: 1, required: true, section: "Configure group size and scaling", validate: { min: 0, max: 100, message: "Between 0 and 100." } },
      { name: "max", label: "Max desired capacity", kind: "number", default: 1, required: true, section: "Configure group size and scaling", validate: { min: 0, max: 100, message: "Between 0 and 100." } },
      { name: "cpuTarget", label: "Target tracking scaling policy: average CPU utilization target (%)", kind: "number", section: "Configure group size and scaling", help: "Leave empty for no scaling policy.", validate: { min: 1, max: 100, message: "Between 1 and 100." } },
      { name: "tags", label: "Tags (applied to new instances)", kind: "tags", section: "Add tags" },
    ],
    async run(ctx, v) {
      const name = String(v.name);
      const [desired, min, max] = [Number(v.desired), Number(v.min), Number(v.max)];
      if (!(min <= desired && desired <= max)) throw new Error("Desired capacity must be between the minimum and maximum capacity.");
      const tags = Array.isArray(v.tags) ? (v.tags as Tag[]) : [];
      const tgs = strList(v.targetGroups);
      await ctx.clients.autoscaling.send(
        new CreateAutoScalingGroupCommand({
          AutoScalingGroupName: name,
          LaunchTemplate: { LaunchTemplateId: String(v.launchTemplate), Version: String(v.version || "$Default") },
          VPCZoneIdentifier: strList(v.subnets).join(","),
          TargetGroupARNs: tgs.length ? tgs : undefined,
          HealthCheckType: v.healthCheckType === "ELB" ? "ELB" : "EC2",
          HealthCheckGracePeriod: num(v.grace),
          DesiredCapacity: desired,
          MinSize: min,
          MaxSize: max,
          Tags: tags.length ? tags.map((t) => ({ Key: t.Key, Value: t.Value, PropagateAtLaunch: true })) : undefined,
        })
      );
      if (typeof v.cpuTarget === "number") {
        await ctx.clients.autoscaling.send(
          new PutScalingPolicyCommand({ AutoScalingGroupName: name, PolicyName: "Target Tracking Policy", PolicyType: "TargetTrackingScaling", TargetTrackingConfiguration: { PredefinedMetricSpecification: { PredefinedMetricType: "ASGAverageCPUUtilization" }, TargetValue: v.cpuTarget } })
        );
      }
      return name;
    },
  },
  actions: [
    {
      id: "capacity",
      label: "Edit group size",
      fields: [
        { name: "desired", label: "Desired capacity", kind: "number", required: true, validate: { min: 0, max: 100, message: "Between 0 and 100." } },
        { name: "min", label: "Min desired capacity", kind: "number", required: true, validate: { min: 0, max: 100, message: "Between 0 and 100." } },
        { name: "max", label: "Max desired capacity", kind: "number", required: true, validate: { min: 0, max: 100, message: "Between 0 and 100." } },
      ],
      async initialValues(ctx, name) {
        const g = await oneGroup(ctx, name);
        return { desired: g.DesiredCapacity ?? null, min: g.MinSize ?? null, max: g.MaxSize ?? null };
      },
      async run(ctx, name, v) {
        const [desired, min, max] = [Number(v.desired), Number(v.min), Number(v.max)];
        if (!(min <= desired && desired <= max)) throw new Error("Desired capacity must be between the minimum and maximum capacity.");
        await ctx.clients.autoscaling.send(new UpdateAutoScalingGroupCommand({ AutoScalingGroupName: name, MinSize: min, MaxSize: max, DesiredCapacity: desired }));
        return { message: `Group size set: desired ${desired}, min ${min}, max ${max}. See the Activity tab.` };
      },
    },
    {
      id: "set-desired",
      label: "Set desired capacity",
      fields: [
        { name: "desired", label: "Desired capacity", kind: "number", required: true, validate: { min: 0, max: 100, message: "Between 0 and 100." } },
        { name: "honorCooldown", label: "Honor cooldown", kind: "checkbox", default: false },
      ],
      async initialValues(ctx, name) {
        return { desired: (await oneGroup(ctx, name)).DesiredCapacity ?? null };
      },
      async run(ctx, name, v) {
        await ctx.clients.autoscaling.send(new SetDesiredCapacityCommand({ AutoScalingGroupName: name, DesiredCapacity: Number(v.desired), HonorCooldown: v.honorCooldown === true }));
        return { message: `Desired capacity set to ${v.desired}.` };
      },
    },
    {
      id: "policy",
      label: "Create dynamic scaling policy",
      fields: [
        { name: "policyType", label: "Policy type", kind: "select", default: "TargetTrackingScaling", required: true, options: [{ value: "TargetTrackingScaling", label: "Target tracking scaling" }, { value: "SimpleScaling", label: "Simple scaling" }] },
        { name: "name", label: "Scaling policy name", kind: "text", required: true, default: "Target Tracking Policy", validate: { pattern: "[\\x20-\\x7E]{1,255}", message: "Up to 255 characters." } },
        {
          name: "metric", label: "Metric type", kind: "select", default: "ASGAverageCPUUtilization", required: true, showIf: { field: "policyType", equals: "TargetTrackingScaling" },
          options: [
            { value: "ASGAverageCPUUtilization", label: "Average CPU utilization" },
            { value: "ASGAverageNetworkIn", label: "Average network in (bytes)" },
            { value: "ASGAverageNetworkOut", label: "Average network out (bytes)" },
            { value: "ALBRequestCountPerTarget", label: "Application Load Balancer request count per target" },
          ],
        },
        { name: "target", label: "Target value", kind: "number", default: 50, required: true, showIf: { field: "policyType", equals: "TargetTrackingScaling" }, validate: { min: 0, max: 1000000000, message: "A positive number." } },
        { name: "resourceLabel", label: "Target group resource label (ALB request count only)", kind: "text", showIf: { field: "policyType", equals: "TargetTrackingScaling" }, help: "app/<lb-name>/<id>/targetgroup/<tg-name>/<id>" },
        { name: "adjustmentType", label: "Take the action", kind: "select", default: "ChangeInCapacity", required: true, showIf: { field: "policyType", equals: "SimpleScaling" }, options: [{ value: "ChangeInCapacity", label: "Add/remove capacity units" }, { value: "ExactCapacity", label: "Set to exact capacity" }, { value: "PercentChangeInCapacity", label: "Add/remove percent of group" }] },
        { name: "adjustment", label: "Scaling adjustment", kind: "number", default: 1, required: true, showIf: { field: "policyType", equals: "SimpleScaling" }, validate: { min: -100, max: 100, message: "Between -100 and 100." } },
      ],
      async run(ctx, name, v) {
        const target = v.policyType === "TargetTrackingScaling";
        if (target && !(typeof v.metric === "string" && v.metric)) throw new Error("Choose a metric type.");
        if (!target && !(typeof v.adjustmentType === "string" && v.adjustmentType)) throw new Error("Choose how to take the action.");
        if (target && v.metric === "ALBRequestCountPerTarget" && !(typeof v.resourceLabel === "string" && v.resourceLabel)) throw new Error("ALB request count per target needs the target group resource label.");
        const r = await ctx.clients.autoscaling.send(
          new PutScalingPolicyCommand({
            AutoScalingGroupName: name,
            PolicyName: String(v.name),
            PolicyType: target ? "TargetTrackingScaling" : "SimpleScaling",
            TargetTrackingConfiguration: target
              ? { PredefinedMetricSpecification: { PredefinedMetricType: String(v.metric) as MetricType, ResourceLabel: typeof v.resourceLabel === "string" && v.resourceLabel ? v.resourceLabel : undefined }, TargetValue: Number(v.target) }
              : undefined,
            AdjustmentType: target ? undefined : String(v.adjustmentType),
            ScalingAdjustment: target ? undefined : Number(v.adjustment),
          })
        );
        return { message: `Created policy ${v.name}${r.Alarms?.length ? ` with alarms ${r.Alarms.map((a) => a.AlarmName).join(", ")}` : ""}.` };
      },
    },
    {
      id: "manage-policies",
      label: "Manage scaling policies",
      async run(ctx, name) {
        const p = (await ctx.clients.autoscaling.send(new DescribePoliciesCommand({ AutoScalingGroupName: name }))).ScalingPolicies ?? [];
        return {
          message: `${p.length} polic${p.length === 1 ? "y" : "ies"}. Select policies to delete them.`,
          table: {
            rowKey: "name",
            columns: [{ key: "name", label: "Policy name", kind: "text" }, { key: "type", label: "Policy type", kind: "text" }],
            rows: p.map((x) => ({ name: x.PolicyName ?? "", type: x.PolicyType ?? null })),
            emptyText: "No scaling policies.",
            selectionAction: { actionId: "delete-policies", label: "Delete", danger: true, valuesField: "names" },
          },
        };
      },
    },
    {
      id: "delete-policies",
      label: "Delete policies",
      hidden: true,
      danger: true,
      fields: [{ name: "names", label: "Policies", kind: "multiselect", required: true }],
      async run(ctx, name, v) {
        const names = strList(v.names);
        for (const n of names) await ctx.clients.autoscaling.send(new DeletePolicyCommand({ AutoScalingGroupName: name, PolicyName: n }));
        return { message: `Deleted ${names.length} polic${names.length === 1 ? "y" : "ies"}.` };
      },
    },
    {
      id: "execute-policy",
      label: "Execute simple scaling policy",
      fields: [{ name: "policy", label: "Scaling policy", kind: "select", required: true, options: policyOptions, help: "Simple and step scaling policies of this group." }],
      async run(ctx, name, v) {
        await ctx.clients.autoscaling.send(new ExecutePolicyCommand({ AutoScalingGroupName: name, PolicyName: String(v.policy), HonorCooldown: false }));
        return { message: `Executed policy ${v.policy}. See the Activity tab.` };
      },
    },
    {
      id: "scheduled",
      label: "Create scheduled action",
      fields: [
        { name: "name", label: "Name", kind: "text", required: true },
        { name: "recurrence", label: "Recurrence (cron, UTC)", kind: "text", required: true, default: "0 9 * * *", help: "Five fields: minute hour day-of-month month day-of-week." },
        { name: "desired", label: "Desired capacity", kind: "number", validate: { min: 0, max: 100, message: "Between 0 and 100." } },
        { name: "min", label: "Min", kind: "number", validate: { min: 0, max: 100, message: "Between 0 and 100." } },
        { name: "max", label: "Max", kind: "number", validate: { min: 0, max: 100, message: "Between 0 and 100." } },
      ],
      async run(ctx, name, v) {
        if ([v.desired, v.min, v.max].every((x) => typeof x !== "number")) throw new Error("Set at least one of desired capacity, min or max.");
        await ctx.clients.autoscaling.send(
          new PutScheduledUpdateGroupActionCommand({ AutoScalingGroupName: name, ScheduledActionName: String(v.name), Recurrence: String(v.recurrence), DesiredCapacity: num(v.desired), MinSize: num(v.min), MaxSize: num(v.max) })
        );
        return { message: `Created scheduled action ${v.name}.` };
      },
    },
    {
      id: "instance-refresh",
      label: "Start instance refresh",
      confirm: "Replaces the group's instances with new ones launched from the current launch template.",
      fields: [{ name: "minHealthy", label: "Minimum healthy percentage", kind: "number", default: 90, validate: { min: 0, max: 100, message: "Between 0 and 100." } }],
      async run(ctx, name, v) {
        const r = await ctx.clients.autoscaling.send(new StartInstanceRefreshCommand({ AutoScalingGroupName: name, Preferences: { MinHealthyPercentage: num(v.minHealthy) } }));
        return { message: `Instance refresh started: ${r.InstanceRefreshId ?? "-"}.` };
      },
    },
  ],
  delete: {
    confirmText: "delete",
    async run(ctx, name) {
      await ctx.clients.autoscaling.send(new DeleteAutoScalingGroupCommand({ AutoScalingGroupName: name, ForceDelete: true }));
    },
  },
};
