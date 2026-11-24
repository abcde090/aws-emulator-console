# AWS Emulator Console: design

A local web console for [AWS Emulator](https://github.com/aws/aws-emulator), written from scratch. It looks and works like the AWS Management Console, and every value on screen comes from the emulator. It is built for learning AWS, so fidelity to the real console matters.

## Rules every screen follows

1. **Only real data.** Everything shown comes from an emulator API response. No sample rows, no invented IDs, no made-up metrics, no fake success messages.
2. **No dead controls.** Every button and field calls a real API. If the emulator lacks an API, the screen says so plainly ("AWS Emulator doesn't support X yet") and the control is not offered.
3. **Errors are shown, never swallowed or crashed on.** Empty lists show the console's empty state. Denied calls show the IAM simulator's AccessDenied message.
4. **Every AWS call goes through a permission-checked client** (`src/lib/aws.ts`), so the IAM simulator sees it.
5. **Local only and safe.** Binds to 127.0.0.1, checks the Host header (`src/proxy.ts`), never runs a shell string (`execFile` with argument lists only), runs the AWS CLI for CloudShell inside a deny-by-default sandbox (writes only to its own empty temp folder, reads only system and CLI install folders, no network but the emulator).

## Stack

Next.js 16 (App Router, server actions), React 19, TypeScript (strict), Tailwind CSS 4, AWS SDK for JavaScript v3. Tests: `node:test` for library code, Playwright for end-to-end runs against the emulator.

## Layout

```
src/
  proxy.ts                    Host check on every request
  lib/                        safety core and AWS plumbing (no React)
    aws.ts                    one permission-checked client per service and Region
    regions.ts, selected-region.ts   the Regions offered, global services, the chosen-Region cookie
    permissions.ts            policy evaluation (explicit deny, implicit deny, unknown resource)
    iam-action.ts             SDK call / CLI command -> IAM action + resource
    iam-enforce.ts            runs the check (SDK middleware and simulatedDenial)
    identity.ts, identity-cookie.ts   "act as" identity: cookie, policy loading
    iam-resources.ts, iam-lookup.ts   identifying fields -> resource ARNs (secrets looked up for their real ARN)
    cli-args.ts, cloudshell-guard.ts, cli-runner.ts, cloudshell-exec.ts, cloudshell-sandbox.ts   CloudShell
  console/                    the generic console engine
    types.ts                  ServiceDef / ResourceDef / FieldDef / ActionDef
    registry.ts               all service definitions, by id
    actions.ts                the ONLY server actions the engine needs (list/get/create/run/delete)
    secondary.ts              secondary(), valueOr(), unavailableText(), unavailableTab(), secondaryOr(), optionalRead(): side lookups that never fail the page
    tags.ts                   tagDiff() / recordTagDiff() / tagDiffMessage(), tag adapters, manageTagsAction(): every "Manage tags" dialog
    values.ts                 form-value and API-text helpers (text, numberOr, strList, joinId/splitId, JSON text, S3 URIs)
    ui/                       ResourceTable, ResourceDetail, CreateForm, KeyValue, StatusBadge, JsonView, EmptyState, ErrorBanner …
  services/<service>/         one folder per service
    def.ts                    its ServiceDef (resources, columns, forms, actions) — server only
    *.tsx                     optional hand-built screens (wizards, browsers, editors)
  app/
    layout.tsx, page.tsx      console shell and Console Home
    [service]/[[...path]]/page.tsx   generic routes: /<service>, /<service>/<resource>, /<service>/<resource>/<id>, /<service>/<resource>/create
    <service>/…               only where a hand-built screen replaces a generic one
  components/shell/           top bar, services menu, search, identity menu, CloudShell drawer, side nav
tests/                        node:test unit tests
e2e/                          Playwright tests
```

## The engine

A service is data, not pages. `services/<id>/def.ts` exports a `ServiceDef`; the engine draws the console from it.

```ts
interface ServiceDef {
  id: string;                    // url segment, e.g. "sqs"
  name: string;                  // "Amazon SQS"
  category: string;              // services menu group, e.g. "Application Integration"
  description: string;
  resources: ResourceDef[];      // left nav, in order
  notSupported?: string[];       // honest list of console features the emulator lacks
  extraNav?: { label: string; href: string }[];  // left-nav entries for hand-built pages ("/x/y" or relative to the service)
}

interface ResourceDef {
  id: string;                    // url segment, e.g. "queues"
  name: string;                  // "Queues"
  singular: string;              // "queue"
  idField: string;               // field used in URLs
  nameField?: string;            // shown as the title
  list(ctx): Promise<Row[]>;     // calls the emulator; Row = Record<string, unknown>
  columns: ColumnDef[];          // key, label, kind: "text" | "link" | "status" | "date" | "bytes" | "count" | "arn" | "tags" | "boolean" | "code"
                                 //   href?: "/ecs/services/{cluster}/{serviceName}" makes the cell a link (values URL-encoded; list, detail-tab and result tables)
  get?(ctx, id): Promise<Detail>;// Detail = { summary: Row, tabs?: { id, label, kind: "keyvalue" | "table" | "json" | "text", data }[] }
  create?: { title: string; fields: FieldDef[]; run(ctx, values): Promise<string /* new id */> };
  actions?: ActionDef[];         // { id, label, danger?, confirm?, fields?: FieldDef[], hidden?, run(ctx, id, values),
                                 //   initialValues?(ctx, id) -> current values for "Edit …" dialogs,
                                 //   availableFor?(row) -> false hides the action for that row (list row / detail summary),
                                 //   runOnOpen? -> a read-only action with no fields or confirm runs as its dialog opens, e.g. EC2 "Connect" }
  pageActions?: PageActionDef[]; // header buttons that need no selected row: { id, label, danger?, confirm?, fields?, run(ctx, values) }
  delete?: { confirmText?: "name" | "delete"; fields?: FieldDef[]; availableFor?(row): boolean; run(ctx, id, values): Promise<void> };
                                 //   "name" asks for the nameField value when there is one, else the id
                                 //   availableFor(row) false hides Delete for that row (list and detail), e.g. a "Default" that can't be deleted
  emptyText?: string;
}

interface FieldDef {
  name: string; label: string; help?: string;
  kind: "text" | "number" | "select" | "multiselect" | "checkbox" | "textarea" | "json" | "tags" | "radio" | "password";
  required?: boolean; default?: unknown; placeholder?: string;
  options?: { value: string; label: string }[] | ((ctx, id?) => Promise<{ value: string; label: string }[]>);  // live options; id = the resource, for action/delete fields
  showIf?: { field: string; equals: unknown | unknown[] };  // a list means "any of"; a hidden parent hides its dependants
  validate?: { pattern?: string; min?: number; max?: number; message: string };
}
```

`ctx` gives the permission-checked clients (`ctx.clients.sqs` …), `ctx.clientsIn(region)` (the same checked clients signing for another Region, for cross-Region copies), the region and the acting identity. `ctx.region` is the Region chosen in the top bar (cookie, checked against the allowlist in `src/lib/regions.ts`); on a global service's pages (IAM, Organizations, Route 53, CloudFront, S3, Billing, IAM Identity Center) it is us-east-1 and the top bar shows "Global". Global services' clients always sign for us-east-1. Definitions run on the server only; the engine sends the browser plain, serialisable metadata (labels, columns, field specs with resolved options) and calls back into `console/actions.ts` with `(serviceId, resourceId, …)` ids. There is one generic set of server actions, so every service gets the same error handling, permission checks and revalidation.

Engine behaviour every definition gets:

- Optional selects start at "-" (nothing) and submit ""; required selects start at their first option. An optional select with a non-empty `default` starts there and has no "-"; one whose options include an empty-value choice ("None") shows only that.
- Every server-action call from the browser goes through `callServer` (`src/console/call.ts`): a transport failure shows in the error banner and re-enables the control. A dialog or create form whose fields or option lists failed to load cannot be submitted.
- Secondary lookups use `secondary()` (`src/console/secondary.ts`), so a denied or failed side call shows "Not available" in its cell or "Unavailable: <error>" in its tab (`unavailableText`, `unavailableTab`), never an empty page.
- "Manage tags" dialogs open with the current tags and save only the difference: `tagDiff()` / `recordTagDiff()` from `src/console/tags.ts` (keys trimmed, blank keys ignored, a repeated key is an error), and the result message is `tagDiffMessage()` ("No tag changes." / "Added or changed N tags, removed M."). `manageTagsAction({ read, tag, untag })` builds the whole action.
- `ResourceDetail` takes `headerActions` (a hand-built control placed before Actions and Delete, e.g. CloudFormation's "Update stack" menu); use it instead of a separate bar above the page.
- Number inputs accept decimals (`step="any"`). Password fields are masked, never prefilled and never quoted in errors.
- Every form control has `data-testid="field-<name>"`. The Actions menu (`data-testid="actions-menu"`), page actions and form submits stay disabled until the page has hydrated.
- Every SDK client uses an HTTP/1.1 handler (the emulator refuses HTTP/2) and trims the emulator's nanosecond epoch timestamps in JSON responses before the SDK parses them (only timestamp-named members with values between 2001 and 2100; other numbers are never touched) (`src/lib/sdk-middleware.ts`). Don't add per-service workarounds for either.
- Resource ids may contain "/": detail URLs encode the id as one segment, and the generic route also joins an id spread over several segments.
- Hand-built tabs (`extraTabs`) come first unless they set `after: "<definition tab id>"` (or `"$end"`).

## Look and feel

Match today's AWS console (2025–2026, Cloudscape design): dark top bar (services menu, search, region, CloudShell, identity), service left nav, breadcrumbs, page header with counts and primary action, tables with selection, filter box, pagination, preferences-free, action dropdown, status indicators with coloured dots, key-value detail panels, tabs, split create forms with containers and help text, confirmation modals that ask you to type the name for deletes. Use AWS service names, but no AWS logos or claims of being official.

## Quality bar

- TypeScript strict, no `any` in new code.
- Every service: Playwright test that opens the list page, creates a resource through the form, sees it in the list and in `aws` CLI output, opens its detail page, and deletes it.
- `npm test`, `npx tsc --noEmit`, `npm run build` and the e2e suite pass before anything is committed.
