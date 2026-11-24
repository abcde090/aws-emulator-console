/**
 * AWS Budgets: cost and usage budgets, their alert thresholds and subscribers, budget
 * history and budget actions. Amounts are what the emulator reports (CalculatedSpend and
 * DescribeBudgetPerformanceHistory); nothing is estimated here.
 */

import {
  CreateBudgetActionCommand,
  CreateBudgetCommand,
  CreateNotificationCommand,
  DeleteBudgetActionCommand,
  DeleteBudgetCommand,
  DeleteNotificationCommand,
  DescribeBudgetActionsForBudgetCommand,
  DescribeBudgetCommand,
  DescribeBudgetPerformanceHistoryCommand,
  DescribeBudgetsCommand,
  DescribeNotificationsForBudgetCommand,
  DescribeSubscribersForNotificationCommand,
  ExecuteBudgetActionCommand,
  UpdateBudgetCommand,
  type Budget,
  type ComparisonOperator,
  type Notification,
  type NotificationType,
  type Subscriber,
  type ThresholdType,
  type TimeUnit,
} from "@aws-sdk/client-budgets";
import { ListRolesCommand } from "@aws-sdk/client-iam";
import { ListTopicsCommand } from "@aws-sdk/client-sns";
import type { Ctx, FieldDef, FieldValues, Option, ResourceDef, Row } from "../../console/types.ts";
import { decodeNotification, encodeNotification, invalidEmails, money, percentOf, splitList } from "./helpers.ts";

const BUDGET_NAME = "[^:\\\\]{1,100}";
const PERIODS: Option[] = [
  { value: "DAILY", label: "Daily" },
  { value: "MONTHLY", label: "Monthly" },
  { value: "QUARTERLY", label: "Quarterly" },
  { value: "ANNUALLY", label: "Annually" },
];
const periodLabel = (t: string | undefined) => PERIODS.find((p) => p.value === t)?.label ?? t ?? null;
const typeLabel = (t: string | undefined) => (t === "COST" ? "Cost budget" : t === "USAGE" ? "Usage budget" : t ?? null);

async function listBudgets(ctx: Ctx): Promise<Budget[]> {
  const out: Budget[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.budgets.send(new DescribeBudgetsCommand({ AccountId: ctx.accountId, NextToken: token }));
    out.push(...(r.Budgets ?? []));
    token = r.NextToken;
  } while (token);
  return out;
}

async function budgetActionOptions(ctx: Ctx, name?: string): Promise<Option[]> {
  if (!name) return [];
  const out: Option[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.budgets.send(new DescribeBudgetActionsForBudgetCommand({ AccountId: ctx.accountId, BudgetName: name, NextToken: token }));
    for (const a of r.Actions ?? []) if (a.ActionId) out.push({ value: a.ActionId, label: `${a.ActionId} (${a.Status ?? "unknown status"})` });
    token = r.NextToken;
  } while (token);
  return out;
}

async function describeBudget(ctx: Ctx, name: string): Promise<Budget> {
  const r = await ctx.clients.budgets.send(new DescribeBudgetCommand({ AccountId: ctx.accountId, BudgetName: name }));
  if (!r.Budget) throw new Error(`Budget ${name} was not returned.`);
  return r.Budget;
}

async function notifications(ctx: Ctx, name: string): Promise<Notification[]> {
  const out: Notification[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.budgets.send(new DescribeNotificationsForBudgetCommand({ AccountId: ctx.accountId, BudgetName: name, NextToken: token }));
    out.push(...(r.Notifications ?? []));
    token = r.NextToken;
  } while (token);
  return out;
}

async function subscribers(ctx: Ctx, name: string, n: Notification): Promise<Subscriber[]> {
  const r = await ctx.clients.budgets.send(new DescribeSubscribersForNotificationCommand({ AccountId: ctx.accountId, BudgetName: name, Notification: n }));
  return r.Subscribers ?? [];
}

function budgetRow(b: Budget, alerts: number | null): Row {
  const actual = b.CalculatedSpend?.ActualSpend;
  return {
    name: b.BudgetName ?? "",
    type: typeLabel(b.BudgetType),
    period: periodLabel(b.TimeUnit),
    budgeted: money(b.BudgetLimit),
    actual: money(actual),
    forecasted: money(b.CalculatedSpend?.ForecastedSpend),
    percent: percentOf(actual, b.BudgetLimit),
    health: b.HealthStatus?.Status ?? null,
    alerts,
  };
}

function notificationText(n: Notification): string {
  const op = n.ComparisonOperator === "GREATER_THAN" ? ">" : n.ComparisonOperator === "LESS_THAN" ? "<" : "=";
  const value = n.ThresholdType === "ABSOLUTE_VALUE" ? `${n.Threshold ?? "?"} (absolute)` : `${n.Threshold ?? "?"}%`;
  return `${n.NotificationType === "FORECASTED" ? "Forecasted" : "Actual"} ${op} ${value}`;
}

async function snsTopicOptions(ctx: Ctx): Promise<Option[]> {
  const out: Option[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.sns.send(new ListTopicsCommand({ NextToken: token }));
    for (const t of r.Topics ?? []) if (t.TopicArn) out.push({ value: t.TopicArn, label: t.TopicArn.split(":").pop() ?? t.TopicArn });
    token = r.NextToken;
  } while (token);
  return out;
}

async function roleOptions(ctx: Ctx): Promise<Option[]> {
  const out: Option[] = [];
  let marker: string | undefined;
  do {
    const r = await ctx.clients.iam.send(new ListRolesCommand({ Marker: marker }));
    for (const role of r.Roles ?? []) if (role.Arn) out.push({ value: role.Arn, label: role.RoleName ?? role.Arn });
    marker = r.IsTruncated ? r.Marker : undefined;
  } while (marker);
  return out;
}

/** Subscribers from the email list and SNS topic fields; throws on bad input. */
function subscribersFrom(v: FieldValues): Subscriber[] {
  const emails = splitList(v.emails);
  const bad = invalidEmails(emails);
  if (bad.length) throw new Error(`Not a valid email address: ${bad.join(", ")}`);
  const subs: Subscriber[] = emails.map((Address) => ({ SubscriptionType: "EMAIL", Address }));
  if (typeof v.snsTopic === "string" && v.snsTopic !== "") subs.push({ SubscriptionType: "SNS", Address: v.snsTopic });
  if (subs.length === 0) throw new Error("Add at least one email recipient or an Amazon SNS topic.");
  if (subs.length > 11) throw new Error("An alert can have at most 10 email recipients and 1 SNS topic.");
  return subs;
}

function notificationFrom(v: FieldValues): Notification {
  const threshold = typeof v.threshold === "number" ? v.threshold : NaN;
  if (!Number.isFinite(threshold) || threshold <= 0) throw new Error("Enter a threshold greater than 0.");
  return {
    NotificationType: (v.notificationType === "FORECASTED" ? "FORECASTED" : "ACTUAL") as NotificationType,
    ComparisonOperator: "GREATER_THAN" as ComparisonOperator,
    Threshold: threshold,
    ThresholdType: (v.thresholdType === "ABSOLUTE_VALUE" ? "ABSOLUTE_VALUE" : "PERCENTAGE") as ThresholdType,
  };
}

function alertFields(section?: string, showIf?: { field: string; equals: unknown }): FieldDef[] {
  return [
    { name: "threshold", label: "Threshold", kind: "number", default: 80, help: "Alert when spend passes this value.", validate: { min: 0, max: 1_000_000_000, message: "Enter a positive number." }, section, showIf },
    { name: "thresholdType", label: "Threshold type", kind: "select", default: "PERCENTAGE", options: [{ value: "PERCENTAGE", label: "% of budgeted amount" }, { value: "ABSOLUTE_VALUE", label: "Absolute value" }], section, showIf },
    { name: "notificationType", label: "Trigger", kind: "radio", default: "ACTUAL", options: [{ value: "ACTUAL", label: "Actual" }, { value: "FORECASTED", label: "Forecasted" }], section, showIf },
    { name: "emails", label: "Email recipients", kind: "text", placeholder: "name@example.com, other@example.com", help: "Up to 10 addresses, separated by commas.", section, showIf },
    { name: "snsTopic", label: "Amazon SNS alerts", kind: "select", options: snsTopicOptions, help: "Also publish the alert to this SNS topic.", section, showIf },
  ];
}

export const budgets: ResourceDef = {
  id: "budgets",
  name: "Budgets",
  singular: "budget",
  idField: "name",
  nameField: "Name",
  description: "Set custom budgets and get alerts when costs or usage exceed, or are forecast to exceed, the budgeted amount.",
  emptyText: "No budgets. Create a budget to track your costs or usage.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "alerts", label: "Thresholds", kind: "count" },
    { key: "budgeted", label: "Budget", kind: "text" },
    { key: "actual", label: "Amount used", kind: "text" },
    { key: "forecasted", label: "Forecasted amount", kind: "text" },
    { key: "percent", label: "Current vs. budgeted", kind: "text" },
    { key: "type", label: "Budget type", kind: "text" },
    { key: "period", label: "Period", kind: "text" },
    { key: "health", label: "Health", kind: "status" },
  ],

  async list(ctx) {
    const all = await listBudgets(ctx);
    // DescribeBudgets leaves out CalculatedSpend on AWS Emulator; DescribeBudget includes it.
    return Promise.all(
      all.map(async (b) => {
        const name = b.BudgetName ?? "";
        const [full, alerts] = await Promise.all([describeBudget(ctx, name).catch(() => b), notifications(ctx, name).then((n) => n.length).catch(() => null)]);
        return budgetRow(full, alerts);
      })
    );
  },

  async get(ctx, name) {
    const b = await describeBudget(ctx, name);
    const notes = await notifications(ctx, name);
    const alertRows = await Promise.all(
      notes.map(async (n) => {
        const subs = await subscribers(ctx, name, n);
        return {
          threshold: notificationText(n),
          state: n.NotificationState ?? null,
          email: subs.filter((s) => s.SubscriptionType === "EMAIL").map((s) => s.Address).join(", ") || null,
          sns: subs.filter((s) => s.SubscriptionType === "SNS").map((s) => s.Address).join(", ") || null,
        };
      })
    );
    const history = await ctx.clients.budgets.send(new DescribeBudgetPerformanceHistoryCommand({ AccountId: ctx.accountId, BudgetName: name }));
    const actions = await ctx.clients.budgets.send(new DescribeBudgetActionsForBudgetCommand({ AccountId: ctx.accountId, BudgetName: name }));
    const row = budgetRow(b, notes.length);
    return {
      summary: { Name: row.name, "Budget type": row.type, Period: row.period, "Budgeted amount": row.budgeted, "Amount used": row.actual, "Forecasted amount": row.forecasted, "Current vs. budgeted": row.percent, Health: row.health },
      tabs: [
        {
          id: "details",
          label: "Details",
          kind: "keyvalue",
          data: {
            "Start date": b.TimePeriod?.Start ? new Date(b.TimePeriod.Start).toISOString() : null,
            "End date": b.TimePeriod?.End ? new Date(b.TimePeriod.End).toISOString() : null,
            "Last updated": b.LastUpdatedTime ? new Date(b.LastUpdatedTime).toISOString() : null,
            "Budget renewal type": b.AutoAdjustData ? "Auto-adjusting" : "Fixed",
            "Cost filters": b.CostFilters && Object.keys(b.CostFilters).length ? JSON.stringify(b.CostFilters) : "None",
            "Include tax": b.CostTypes?.IncludeTax ?? null,
            "Include credits": b.CostTypes?.IncludeCredit ?? null,
            "Include refunds": b.CostTypes?.IncludeRefund ?? null,
            "Use amortized costs": b.CostTypes?.UseAmortized ?? null,
            "Use blended costs": b.CostTypes?.UseBlended ?? null,
          },
        },
        {
          id: "alerts",
          label: "Alerts",
          kind: "table",
          columns: [
            { key: "threshold", label: "Threshold", kind: "text" },
            { key: "state", label: "State", kind: "status" },
            { key: "email", label: "Email recipients", kind: "text" },
            { key: "sns", label: "SNS topic", kind: "arn" },
          ],
          data: alertRows,
          emptyText: "No alerts. Use Actions > Add alert threshold.",
        },
        {
          id: "history",
          label: "Budget history",
          kind: "table",
          description: "Budgeted and actual amounts per period, from DescribeBudgetPerformanceHistory.",
          columns: [
            { key: "period", label: "Period", kind: "text" },
            { key: "budgeted", label: "Budgeted", kind: "text" },
            { key: "actual", label: "Actual", kind: "text" },
            { key: "percent", label: "Actual vs. budgeted", kind: "text" },
          ],
          data: (history.BudgetPerformanceHistory?.BudgetedAndActualAmountsList ?? []).map((h) => ({
            period: `${h.TimePeriod?.Start ? new Date(h.TimePeriod.Start).toISOString().slice(0, 10) : "?"} – ${h.TimePeriod?.End ? new Date(h.TimePeriod.End).toISOString().slice(0, 10) : "?"}`,
            budgeted: money(h.BudgetedAmount),
            actual: money(h.ActualAmount),
            percent: percentOf(h.ActualAmount, h.BudgetedAmount),
          })),
          emptyText: "No history yet.",
        },
        {
          id: "actions",
          label: "Budget actions",
          kind: "table",
          columns: [
            { key: "id", label: "Action ID", kind: "code" },
            { key: "type", label: "Action type", kind: "text" },
            { key: "threshold", label: "Threshold", kind: "text" },
            { key: "approval", label: "Approval", kind: "text" },
            { key: "status", label: "Status", kind: "status" },
            { key: "role", label: "Execution role", kind: "arn" },
          ],
          data: (actions.Actions ?? []).map((a) => ({
            id: a.ActionId,
            type: a.ActionType,
            threshold: `${a.NotificationType ?? ""} ${a.ActionThreshold?.ActionThresholdValue ?? "?"}${a.ActionThreshold?.ActionThresholdType === "PERCENTAGE" ? "%" : ""}`,
            approval: a.ApprovalModel === "AUTOMATIC" ? "Automatic" : "Manual",
            status: a.Status ?? null,
            role: a.ExecutionRoleArn ?? null,
          })),
          emptyText: "No budget actions.",
        },
      ],
    };
  },

  create: {
    title: "Create budget",
    description: "Track costs or usage against an amount you set, and get alerts as you approach it.",
    fields: [
      {
        name: "budgetType",
        label: "Budget type",
        kind: "radio",
        required: true,
        default: "COST",
        options: [
          { value: "COST", label: "Cost budget - monitor your costs against a specified dollar amount" },
          { value: "USAGE", label: "Usage budget - monitor your usage of one or more usage types" },
        ],
        section: "Budget type",
      },
      { name: "name", label: "Budget name", kind: "text", required: true, placeholder: "My Monthly Cost Budget", help: "Up to 100 characters; no colons (:) or backslashes (\\).", validate: { pattern: BUDGET_NAME, message: "1-100 characters, without : or \\." }, section: "Details" },
      { name: "period", label: "Period", kind: "select", required: true, default: "MONTHLY", options: PERIODS, section: "Set budget amount" },
      { name: "amount", label: "Budgeted amount", kind: "number", required: true, help: "For a cost budget, in USD.", validate: { min: 0, max: 1_000_000_000, message: "Enter an amount greater than 0." }, section: "Set budget amount" },
      { name: "unit", label: "Usage unit", kind: "text", default: "Hrs", help: "Unit of the usage type, e.g. Hrs or GB.", validate: { pattern: "[A-Za-z-]{1,20}", message: "Letters only, up to 20." }, showIf: { field: "budgetType", equals: "USAGE" }, section: "Set budget amount" },
      { name: "usageTypeGroup", label: "Usage type group", kind: "text", placeholder: "EC2: Running Hours", help: "A filter: the usage type group to track.", showIf: { field: "budgetType", equals: "USAGE" }, section: "Set budget amount" },
      { name: "addAlert", label: "Add an alert threshold", kind: "checkbox", default: true, help: "Notify recipients when spend passes a threshold.", section: "Alert thresholds" },
      ...alertFields("Alert thresholds", { field: "addAlert", equals: true }),
    ],
    async run(ctx, v) {
      const name = String(v.name);
      const usage = v.budgetType === "USAGE";
      const amount = typeof v.amount === "number" ? v.amount : NaN;
      if (!Number.isFinite(amount) || amount <= 0) throw new Error("Enter a budgeted amount greater than 0.");
      const group = typeof v.usageTypeGroup === "string" && v.usageTypeGroup !== "" ? v.usageTypeGroup : null;
      const budget: Budget = {
        BudgetName: name,
        BudgetType: usage ? "USAGE" : "COST",
        TimeUnit: String(v.period) as TimeUnit,
        BudgetLimit: { Amount: String(amount), Unit: usage ? String(v.unit || "Hrs") : "USD" },
        CostFilters: usage && group ? { UsageTypeGroup: [group] } : undefined,
      };
      const alerts = v.addAlert === true ? [{ Notification: notificationFrom(v), Subscribers: subscribersFrom(v) }] : undefined;
      await ctx.clients.budgets.send(new CreateBudgetCommand({ AccountId: ctx.accountId, Budget: budget, NotificationsWithSubscribers: alerts }));
      return name;
    },
  },

  actions: [
    {
      id: "edit-amount",
      label: "Edit budgeted amount",
      fields: [{ name: "amount", label: "Budgeted amount", kind: "number", required: true, validate: { min: 0, max: 1_000_000_000, message: "Enter an amount greater than 0." } }],
      async initialValues(ctx, name): Promise<FieldValues> {
        const amount = Number((await describeBudget(ctx, name)).BudgetLimit?.Amount);
        return Number.isFinite(amount) ? { amount } : {};
      },
      async run(ctx, name, v) {
        const b = await describeBudget(ctx, name);
        const amount = typeof v.amount === "number" ? v.amount : NaN;
        if (!Number.isFinite(amount) || amount <= 0) throw new Error("Enter an amount greater than 0.");
        if (Number(b.BudgetLimit?.Amount) === amount) return { message: `No changes: the budgeted amount for ${name} is still ${money(b.BudgetLimit)}.` };
        // UpdateBudget replaces the whole budget: send it back with only the amount changed.
        const next: Budget = { ...b, CalculatedSpend: undefined, LastUpdatedTime: undefined, BudgetLimit: { Amount: String(amount), Unit: b.BudgetLimit?.Unit ?? "USD" } };
        await ctx.clients.budgets.send(new UpdateBudgetCommand({ AccountId: ctx.accountId, NewBudget: next }));
        return { message: `Budgeted amount for ${name} is now ${money(next.BudgetLimit)}.` };
      },
    },
    {
      id: "add-alert",
      label: "Add alert threshold",
      fields: alertFields(),
      async run(ctx, name, v) {
        const n = notificationFrom(v);
        await ctx.clients.budgets.send(new CreateNotificationCommand({ AccountId: ctx.accountId, BudgetName: name, Notification: n, Subscribers: subscribersFrom(v) }));
        return { message: `Added alert: ${notificationText(n)}.` };
      },
    },
    {
      id: "manage-alerts",
      label: "Delete alert thresholds",
      async run(ctx, name) {
        const notes = await notifications(ctx, name);
        return {
          message: `${notes.length} alert threshold${notes.length === 1 ? "" : "s"}. Select the ones to delete.`,
          table: {
            rowKey: "key",
            columns: [
              { key: "threshold", label: "Threshold", kind: "text" },
              { key: "state", label: "State", kind: "status" },
            ],
            rows: notes.map((n) => ({ key: encodeNotification(n), threshold: notificationText(n), state: n.NotificationState ?? null })),
            emptyText: "No alert thresholds.",
            selectionAction: { actionId: "delete-alerts", label: "Delete", danger: true, valuesField: "keys" },
          },
        };
      },
    },
    {
      id: "delete-alerts",
      label: "Delete alerts",
      hidden: true,
      danger: true,
      fields: [{ name: "keys", label: "Alerts", kind: "multiselect", required: true }],
      async run(ctx, name, v) {
        const keys = Array.isArray(v.keys) ? v.keys.filter((k): k is string => typeof k === "string") : [];
        let deleted = 0;
        for (const key of keys) {
          const n = decodeNotification(key);
          if (!n) throw new Error(`Not an alert threshold: ${key}`);
          await ctx.clients.budgets.send(
            new DeleteNotificationCommand({ AccountId: ctx.accountId, BudgetName: name, Notification: { ...n, NotificationType: n.NotificationType as NotificationType, ComparisonOperator: n.ComparisonOperator as ComparisonOperator, ThresholdType: n.ThresholdType as ThresholdType } })
          );
          deleted++;
        }
        return { message: `Deleted ${deleted} alert threshold${deleted === 1 ? "" : "s"}.` };
      },
    },
    {
      id: "create-action",
      label: "Add budget action",
      fields: [
        { name: "notificationType", label: "Trigger", kind: "radio", default: "ACTUAL", options: [{ value: "ACTUAL", label: "Actual" }, { value: "FORECASTED", label: "Forecasted" }] },
        { name: "threshold", label: "Threshold (% of budgeted amount)", kind: "number", required: true, default: 100, validate: { min: 0, max: 1000, message: "Between 0 and 1000." } },
        { name: "policyArn", label: "IAM policy to apply", kind: "text", required: true, default: "arn:aws:iam::aws:policy/AWSDenyAll", help: "Policy ARN attached when the action runs.", validate: { pattern: "arn:aws:iam::(aws|\\d{12}):policy/[\\w+=,.@/-]+", message: "Enter an IAM policy ARN." } },
        { name: "roles", label: "Target roles", kind: "text", help: "Role names, separated by commas." },
        { name: "users", label: "Target users", kind: "text", help: "User names, separated by commas." },
        { name: "groups", label: "Target groups", kind: "text", help: "Group names, separated by commas." },
        { name: "executionRole", label: "Execution role", kind: "select", required: true, options: roleOptions, help: "A role that budgets.amazonaws.com can assume." },
        { name: "approval", label: "Approval", kind: "radio", default: "MANUAL", options: [{ value: "MANUAL", label: "Manual - requires approval to run" }, { value: "AUTOMATIC", label: "Automatic" }] },
        { name: "emails", label: "Email recipients", kind: "text", required: true, help: "Notified when the action runs." },
      ],
      async run(ctx, name, v) {
        const targets = { Roles: splitList(v.roles), Users: splitList(v.users), Groups: splitList(v.groups) };
        if (targets.Roles.length + targets.Users.length + targets.Groups.length === 0) throw new Error("Add at least one target role, user or group.");
        const emails = splitList(v.emails);
        const bad = invalidEmails(emails);
        if (bad.length) throw new Error(`Not a valid email address: ${bad.join(", ")}`);
        const r = await ctx.clients.budgets.send(
          new CreateBudgetActionCommand({
            AccountId: ctx.accountId,
            BudgetName: name,
            NotificationType: v.notificationType === "FORECASTED" ? "FORECASTED" : "ACTUAL",
            ActionType: "APPLY_IAM_POLICY",
            ActionThreshold: { ActionThresholdValue: typeof v.threshold === "number" ? v.threshold : 100, ActionThresholdType: "PERCENTAGE" },
            Definition: {
              IamActionDefinition: {
                PolicyArn: String(v.policyArn),
                Roles: targets.Roles.length ? targets.Roles : undefined,
                Users: targets.Users.length ? targets.Users : undefined,
                Groups: targets.Groups.length ? targets.Groups : undefined,
              },
            },
            ExecutionRoleArn: String(v.executionRole),
            ApprovalModel: v.approval === "AUTOMATIC" ? "AUTOMATIC" : "MANUAL",
            Subscribers: emails.map((Address) => ({ SubscriptionType: "EMAIL", Address })),
          })
        );
        return { message: `Created budget action ${r.ActionId ?? ""}.` };
      },
    },
    {
      id: "manage-actions",
      label: "Run or delete budget actions",
      async run(ctx, name) {
        const r = await ctx.clients.budgets.send(new DescribeBudgetActionsForBudgetCommand({ AccountId: ctx.accountId, BudgetName: name }));
        const rows = (r.Actions ?? []).map((a) => ({ id: a.ActionId ?? "", type: a.ActionType ?? null, status: a.Status ?? null, approval: a.ApprovalModel ?? null }));
        return {
          message: "Select budget actions to delete. Approving runs only from the PENDING status; the emulator answers with its own error otherwise.",
          table: {
            rowKey: "id",
            columns: [
              { key: "id", label: "Action ID", kind: "code" },
              { key: "type", label: "Action type", kind: "text" },
              { key: "status", label: "Status", kind: "status" },
              { key: "approval", label: "Approval", kind: "text" },
            ],
            rows,
            emptyText: "No budget actions.",
            selectionAction: { actionId: "delete-actions", label: "Delete", danger: true, valuesField: "ids" },
          },
        };
      },
    },
    {
      id: "approve-action",
      label: "Approve budget action",
      fields: [{ name: "actionId", label: "Budget action", kind: "select", required: true, options: budgetActionOptions }],
      async run(ctx, name, v) {
        await ctx.clients.budgets.send(new ExecuteBudgetActionCommand({ AccountId: ctx.accountId, BudgetName: name, ActionId: String(v.actionId), ExecutionType: "APPROVE_BUDGET_ACTION" }));
        return { message: `Approved budget action ${String(v.actionId)}.` };
      },
    },
    {
      id: "delete-actions",
      label: "Delete budget actions",
      hidden: true,
      danger: true,
      fields: [{ name: "ids", label: "Budget actions", kind: "multiselect", required: true }],
      async run(ctx, name, v) {
        const ids = Array.isArray(v.ids) ? v.ids.filter((k): k is string => typeof k === "string" && /^[a-f0-9-]{36}$/.test(k)) : [];
        for (const id of ids) await ctx.clients.budgets.send(new DeleteBudgetActionCommand({ AccountId: ctx.accountId, BudgetName: name, ActionId: id }));
        return { message: `Deleted ${ids.length} budget action${ids.length === 1 ? "" : "s"}.` };
      },
    },
  ],

  delete: {
    confirmText: "name",
    async run(ctx, name) {
      await ctx.clients.budgets.send(new DeleteBudgetCommand({ AccountId: ctx.accountId, BudgetName: name }));
    },
  },
};
