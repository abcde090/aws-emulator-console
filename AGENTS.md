# Agent instructions: AWS Emulator Console

Read [DESIGN.md](DESIGN.md) first. It is the contract; follow it exactly. [README.md](README.md) has run commands and the safety model.

## Design rules (from DESIGN.md)

1. **Only real data.** Every value on screen comes from an emulator API response. No sample rows, invented IDs, made-up metrics or fake success messages.
2. **No dead controls.** Every button calls a real API. If the emulator lacks one, say so ("AWS Emulator doesn't support X yet", `ServiceDef.notSupported`) and don't offer the control. Check the emulator before claiming a gap.
3. **Errors are shown, never swallowed.** Server code returns `{ ok, data }` or `{ ok: false, error }`; it never throws to the client. Empty lists show the empty state; denied calls show the simulator's AccessDenied text.
4. **Every AWS call goes through `ctx.clients` / `clients` from `src/lib/aws.ts`** (permission-checked). `uncheckedIam()` / `uncheckedS3()` are for the IAM simulator itself only (loading policies, listing identities, expanding recursive S3 CLI commands). Never give them to a service definition.
5. **Local and safe**: see the safety rules below.

## How the engine works

- `src/services/<id>/def.ts` exports a `ServiceDef` (types in `src/console/types.ts`) and is registered in `src/console/registry.ts`. Definitions are server-only.
- `src/console/server.ts` runs definitions and wraps results; `src/console/actions.ts` holds the only generic server actions (list, get, fields, create, run action, delete). Form values are validated on the server against the field specs (`src/console/validate.ts`) before a definition sees them; hidden actions must declare their fields too.
- The browser gets plain metadata (`src/console/meta.ts`), never functions. Live `options` loaders run on the server.
- Generic routes: `src/app/[service]/[[...path]]/page.tsx`. Hand-built screens go in `src/services/<id>/*.tsx` plus a route under `src/app/<id>/`, reusing `src/console/ui/pages.tsx`.
- Reference services: `src/services/sqs/def.ts` (generic engine only) and `src/services/s3/` (definition plus a hand-built object browser).

### Engine conventions

- The engine adds " - optional" to the label of every non-required field (except checkboxes, radios and tags). Don't write "optional" in labels yourself.
- Optional selects submit "" when untouched; required selects default to their first option. Use `default` for anything else.
- Use the engine features instead of workarounds: `ActionDef.initialValues` (prefilled "Edit …" dialogs), option loaders' `id` argument (pickers scoped to the resource), `availableFor(row)` (on actions and on `delete`, which hides Delete for that row), `ResourceDetail`'s `headerActions` slot (hand-built header controls), `pageActions`, `delete.fields`, `ColumnDef.href`, `extraNav`, `extraTabs[].after`, `ctx.clientsIn(region)`, the `"password"` field kind. Timestamp precision and HTTP/1.1 are fixed for every client in `src/lib/aws.ts`.
- Optional selects with a non-empty `default` start at it and offer no "-" (the server turns a stray "" into the default). Don't add your own `{ value: "", label: "None" }` unless "None" is a real choice; when you do, the engine drops its "-".
- Secondary lookups in `list()`/`get()` (status checks, Elastic IPs, versions, aliases, tags…) must not fail the whole page for a restricted identity. Wrap them in `secondary()` from `src/console/secondary.ts` and show `UNAVAILABLE` in the cell (`valueOr`) or `unavailableTab(...)` for a tab. Only the primary call's error is the page's error. For a table tab use `emptyText: unavailableText(r, "No tags.")`; when a value must always render use `secondaryOr(call, fallback)`; for settings that may simply not be set (PolicyNotFound…) use `optionalRead`. Never write a per-service `settle`/`partial` helper.
- Tags: every "Manage tags" uses `src/console/tags.ts` — `tagDiff` (`{ Key, Value }[]` APIs) or `recordTagDiff` (`{ key: value }` map APIs), `fieldTags(v.tags)` for the form value, `tagDiffMessage` for the result, or `manageTagsAction({ read, tag, untag })` for the whole action. Don't write another diff.
- Generic helpers live in `src/console/` (`values.ts`, `tags.ts`, `secondary.ts`). A service never imports a generic helper from another service's folder; put it in `src/console/` instead (service-specific option loaders such as role or bucket pickers may be shared).
- The IAM simulator maps common identifying fields to ARNs (`src/lib/iam-resources.ts`): SecretId, TopicArn, logGroupName, SSM parameter Name(s), EC2 InstanceId/VolumeId/GroupId, RDS identifiers, EventBridge rule/bus names, StreamName, ECS cluster/service, StackName, AlarmName(s), UserPoolId, plus any top-level `…Arn` field holding an ARN of the same service. Anything else is an unknown resource (only a `"*"` Allow matches). Add a mapping there, with a test, when a service needs resource-scoped permissions.
- Tests select form controls by `data-testid="field-<name>"`.

## Safety rules

1. Every shell command that calls AWS must start with `source ~/projects/aws-emulator/emulator-env.sh && ...`, and before creating resources check `aws sts get-caller-identity` returns account `000000000000`. This machine has **real** AWS credentials. E2e tests use `e2e/aws-cli.ts`, which does both.
2. Never use the SDK default credential chain, never point anything at a non-loopback endpoint, never publish the emulator port beyond `127.0.0.1`.
3. Never run a shell string: `execFile`/`spawn` with argument lists only. Any new `exec`, `execSync` or `shell: true` is a blocker.
4. Keep `src/proxy.ts` (Host allowlist), `src/lib/cli-args.ts`, `src/lib/cloudshell-guard.ts`, `src/lib/cloudshell-sandbox.ts`, `src/lib/cloudshell-exec.ts` and the IAM simulator (`permissions.ts`, `iam-action.ts`, `iam-resources.ts`, `iam-lookup.ts`, `iam-enforce.ts`, `identity.ts`) intact; changes there need tests. The CloudShell sandbox is deny-by-default for files: the CLI may write only to its run's empty `home/` folder (its cwd) and read only system/CLI install folders and its own `conf/` copy of the emulator keys. Never widen it.
5. Stopping or rebuilding the emulator container wipes all emulated state: say so before doing it.
6. Don't commit or push unless asked; the lead reviews and commits.
7. Probes and tests must never run bulk or remediation actions (purge, delete-all, "remediate", "disable all", account-wide settings…) against resources they did not create. Create your own uniquely named resources, act only on those, and clean them up. The emulator is shared with other agents and with its owner.

## How to verify

All of these must pass before anything is committed:

```bash
npm test                 # node:test unit tests in tests/
npx tsc --noEmit
npm run lint
npm run build
npx playwright test      # needs the emulator running (./scripts/emulator.sh start); uses/starts the dev server on 127.0.0.1:3001
                         # output goes to $TMPDIR/aws-emulator-console-e2e/<run id>/; E2E_TRACE=1 keeps traces of failures
```

Every new service needs an e2e test that opens the list page, creates a resource through the form, sees it in the list and in `aws` CLI output, opens its detail page and deletes it. Any new logic in `src/lib` or `src/console` needs unit tests.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
