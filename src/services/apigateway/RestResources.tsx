"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Option } from "@/console/types";
import { KeyValue } from "@/console/ui/KeyValue";
import { Modal } from "@/console/ui/Modal";
import { Button, Container, EmptyState, ErrorBanner, Flash, Spinner } from "@/console/ui/primitives";
import { FormDialog } from "./FormDialog";
import { deployFields, methodFields, resourceFields, testFields } from "./forms";
import { functionName, orderTree } from "./helpers";
import {
  createRestMethod,
  createRestResource,
  deleteRestMethod,
  deleteRestResource,
  deployRestApi,
  getRestMethod,
  listRestResources,
  listRestStages,
  testRestMethod,
  type MethodView,
  type RestResourceView,
  type TestView,
} from "./rest-actions";

interface RestResourcesProps {
  apiId: string;
  initial: RestResourceView[] | null;
  initialError: string | null;
  lambda: Option[];
  lambdaError: string | null;
}

type Selection = { resourceId: string; method: string | null };
type Dialog = "resource" | "method" | "delete" | "deploy" | "test" | null;

const INTEGRATION_LABEL: Record<string, string> = { AWS_PROXY: "Lambda proxy", AWS: "Lambda (custom)", HTTP_PROXY: "HTTP proxy", HTTP: "HTTP", MOCK: "Mock" };

export function RestResources({ apiId, initial, initialError, lambda, lambdaError }: RestResourcesProps) {
  const [resources, setResources] = useState<RestResourceView[]>(initial ?? []);
  const [error, setError] = useState<string | null>(initialError);
  const [notice, setNotice] = useState<string | null>(null);
  const [sel, setSel] = useState<Selection | null>(() => {
    const root = (initial ?? []).find((r) => r.path === "/");
    return root ? { resourceId: root.id, method: null } : null;
  });
  const [method, setMethod] = useState<MethodView | null>(null);
  const [methodError, setMethodError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [stageOptions, setStageOptions] = useState<Option[] | null>(null);
  const [test, setTest] = useState<TestView | null>(null);

  const tree = useMemo(() => orderTree(resources), [resources]);
  const current = resources.find((r) => r.id === sel?.resourceId) ?? null;

  const reload = useCallback(async () => {
    const r = await listRestResources(apiId);
    if (!r.ok) return setError(r.error);
    setResources(r.data);
    setError(null);
    setSel((s) => {
      const still = s && r.data.find((x) => x.id === s.resourceId);
      if (still) return s.method && !still.methods.includes(s.method) ? { resourceId: still.id, method: null } : s;
      const root = r.data.find((x) => x.path === "/");
      return root ? { resourceId: root.id, method: null } : null;
    });
  }, [apiId]);

  // The tab remounts when shown again; reload so changes made elsewhere appear.
  useEffect(() => {
    let live = true;
    listRestResources(apiId).then((r) => {
      if (live && r.ok) setResources(r.data);
    });
    return () => {
      live = false;
    };
  }, [apiId]);

  useEffect(() => {
    if (!sel?.method) return;
    let live = true;
    getRestMethod(apiId, sel.resourceId, sel.method).then((r) => {
      if (!live) return;
      if (r.ok) {
        setMethod(r.data);
        setMethodError(null);
      } else {
        setMethod(null);
        setMethodError(r.error);
      }
    });
    return () => {
      live = false;
    };
  }, [apiId, sel]);

  async function openDeploy() {
    const r = await listRestStages(apiId);
    if (!r.ok) return setError(r.error);
    setStageOptions(r.data.map((s) => ({ value: s.name, label: s.name })));
    setDialog("deploy");
  }

  async function removeSelected() {
    if (!sel || !current) return;
    const r = sel.method ? await deleteRestMethod(apiId, sel.resourceId, sel.method) : await deleteRestResource(apiId, sel.resourceId);
    setDialog(null);
    if (!r.ok) return setError(r.error);
    setNotice(sel.method ? `Deleted ${sel.method} method on ${current.path}.` : `Deleted resource ${current.path} and everything under it.`);
    setSel(null);
    setMethod(null);
    await reload();
  }

  const done = (message: string) => {
    setDialog(null);
    setNotice(message);
    void reload();
  };
  const isMethod = Boolean(sel?.method);
  const methodShown = isMethod && method && method.httpMethod === sel?.method ? method : null;

  return (
    <div className="space-y-4" data-testid="rest-resources">
      {notice && <Flash kind="success" message={notice} onDismiss={() => setNotice(null)} />}
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      <div className="grid gap-4 lg:grid-cols-[minmax(16rem,22rem)_1fr]">
        <Container
          title="Resources"
          actions={
            <>
              <Button aria-label="Refresh resources" onClick={() => void reload()}>
                ⟳
              </Button>
              <Button disabled={!current} onClick={() => setDialog("resource")}>
                Create resource
              </Button>
            </>
          }
        >
          <ul className="space-y-0.5 font-mono text-[13px]" aria-label="Resource tree">
            {tree.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  className={`block w-full rounded px-2 py-1 text-left ${sel?.resourceId === r.id && !sel.method ? "bg-[#f2f8fd] font-bold text-primary" : "hover:bg-shade"}`}
                  style={{ paddingLeft: `${0.5 + r.depth}rem` }}
                  onClick={() => setSel({ resourceId: r.id, method: null })}
                >
                  {r.path === "/" ? "/" : r.path.split("/").pop()}
                </button>
                {r.methods.map((m) => (
                  <button
                    key={m}
                    type="button"
                    data-testid={`method-${r.path}-${m}`}
                    className={`block w-full rounded px-2 py-0.5 text-left ${sel?.resourceId === r.id && sel.method === m ? "bg-[#f2f8fd] font-bold text-primary" : "text-muted hover:bg-shade"}`}
                    style={{ paddingLeft: `${1.5 + r.depth}rem` }}
                    onClick={() => setSel({ resourceId: r.id, method: m })}
                  >
                    {m}
                  </button>
                ))}
              </li>
            ))}
          </ul>
          {tree.length === 0 && !error && <EmptyState title="No resources" />}
        </Container>

        <Container
          title={current ? (isMethod ? `${current.path} - ${sel?.method}` : "Resource details") : "Resource details"}
          actions={
            <>
              {isMethod && (
                <Button onClick={() => { setTest(null); setDialog("test"); }}>
                  Test
                </Button>
              )}
              <Button disabled={!current || (!isMethod && current.path === "/")} onClick={() => setDialog("delete")}>
                {isMethod ? "Delete method" : "Delete resource"}
              </Button>
              {!isMethod && (
                <Button disabled={!current} onClick={() => setDialog("method")}>
                  Create method
                </Button>
              )}
              <Button variant="primary" onClick={() => void openDeploy()}>
                Deploy API
              </Button>
            </>
          }
        >
          {!current && <EmptyState title="Select a resource or method" />}
          {current && !isMethod && (
            <div className="space-y-4">
              <KeyValue data={{ Path: current.path, "Resource ID": current.id, Methods: current.methods.join(", ") || "None" }} />
              {current.methods.length === 0 && <p className="text-muted">This resource has no methods. Use Create method to add one.</p>}
            </div>
          )}
          {current && isMethod && !methodShown && !methodError && <Spinner />}
          {methodError && <ErrorBanner message={methodError} />}
          {methodShown && <MethodPanel m={methodShown} />}
        </Container>
      </div>

      {dialog === "resource" && current && (
        <FormDialog
          title="Create resource"
          submitLabel="Create resource"
          fields={resourceFields}
          intro={<p className="text-muted">Resource path: {current.path} (the parent)</p>}
          onSubmit={(v) => createRestResource(apiId, current.id, v)}
          onClose={() => setDialog(null)}
          onDone={(d) => done(`Created resource ${(d as { path: string }).path}.`)}
        />
      )}
      {dialog === "method" && current && (
        <FormDialog
          title={`Create method on ${current.path}`}
          submitLabel="Create method"
          fields={methodFields(lambda, lambdaError ?? undefined)}
          onSubmit={(v) => createRestMethod(apiId, current.id, current.path, v)}
          onClose={() => setDialog(null)}
          onDone={(d) => done((d as { message: string }).message)}
        />
      )}
      {dialog === "deploy" && stageOptions && (
        <FormDialog
          title="Deploy API"
          submitLabel="Deploy"
          fields={deployFields(stageOptions)}
          intro={<p className="text-muted">Creates a deployment (a snapshot of the resources and methods) and points the stage at it.</p>}
          onSubmit={(v) => deployRestApi(apiId, v)}
          onClose={() => setDialog(null)}
          onDone={(d) => done(`${(d as { message: string }).message} See the Stages tab for its invoke URL.`)}
        />
      )}
      {dialog === "test" && current && sel?.method && (
        <TestDialog apiId={apiId} resourceId={current.id} path={current.path} method={sel.method} result={test} onResult={setTest} onClose={() => setDialog(null)} />
      )}
      {dialog === "delete" && current && (
        <Modal
          title={isMethod ? `Delete ${sel?.method} method` : `Delete resource ${current.path}`}
          onClose={() => setDialog(null)}
          footer={
            <>
              <Button variant="link" onClick={() => setDialog(null)}>
                Cancel
              </Button>
              <Button variant="danger" data-testid="dialog-submit" onClick={() => void removeSelected()}>
                Delete
              </Button>
            </>
          }
        >
          <p>{isMethod ? "The method and its integration are deleted. Deploy the API for the change to reach a stage." : "The resource, its child resources and all their methods are deleted."}</p>
        </Modal>
      )}
    </div>
  );
}

function MethodPanel({ m }: { m: MethodView }) {
  return (
    <div className="space-y-5">
      <section>
        <h3 className="mb-2 font-bold">Method request</h3>
        <KeyValue data={{ Authorization: m.authorization === "NONE" ? "None" : m.authorization, "API key required": m.apiKeyRequired ? "True" : "False" }} />
      </section>
      <section>
        <h3 className="mb-2 font-bold">Integration request</h3>
        <KeyValue
          data={{
            "Integration type": m.integrationType ? INTEGRATION_LABEL[m.integrationType] ?? m.integrationType : "No integration",
            "Lambda function": m.lambdaFunction ? functionName(m.lambdaFunction) : null,
            "HTTP method": m.integrationMethod,
            "Endpoint / URI": m.uri,
            "Timeout (ms)": m.timeoutMs,
            "Request body passthrough": m.passthrough,
          }}
        />
        {Object.keys(m.requestTemplates).length > 0 && (
          <div className="mt-3">
            <p className="font-bold text-muted">Mapping templates</p>
            {Object.entries(m.requestTemplates).map(([ct, t]) => (
              <pre key={ct} className="mt-1 rounded bg-shade p-2 font-mono text-[13px] whitespace-pre-wrap">{`${ct}\n${t}`}</pre>
            ))}
          </div>
        )}
      </section>
      <section>
        <h3 className="mb-2 font-bold">Integration response</h3>
        {m.integrationResponses.length === 0 ? (
          <p className="text-muted">{m.integrationType === "AWS_PROXY" || m.integrationType === "HTTP_PROXY" ? "Proxy integrations return the back end's response unchanged." : "No integration responses."}</p>
        ) : (
          <ul className="list-disc pl-5">
            {m.integrationResponses.map((r) => (
              <li key={r.status}>
                {r.status} {r.pattern ? `(pattern ${r.pattern})` : "(default)"}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h3 className="mb-2 font-bold">Method response</h3>
        <p>{m.methodResponses.length ? m.methodResponses.map((s) => `HTTP status ${s}`).join(", ") : "No method responses."}</p>
      </section>
    </div>
  );
}

interface TestDialogProps {
  apiId: string;
  resourceId: string;
  path: string;
  method: string;
  result: TestView | null;
  onResult: (r: TestView) => void;
  onClose: () => void;
}

function TestDialog({ apiId, resourceId, path, method, result, onResult, onClose }: TestDialogProps) {
  return (
    <>
      {!result && (
        <FormDialog
          title={`Test ${method} ${path}`}
          submitLabel="Test"
          fields={testFields}
          initial={{ path }}
          intro={<p className="text-muted">Calls TestInvokeMethod: runs the method without deploying and returns the response and execution log.</p>}
          onSubmit={(v) => testRestMethod(apiId, resourceId, method, v)}
          onClose={onClose}
          onDone={(d) => onResult(d as TestView)}
        />
      )}
      {result && (
        <Modal title={`Test ${method} ${path}`} onClose={onClose} wide footer={<Button onClick={onClose}>Close</Button>}>
          <div data-testid="test-result" className="space-y-3">
            <KeyValue data={{ Status: result.status, "Latency (ms)": result.latency }} />
            <p className="font-bold">Response body</p>
            <pre className="max-h-64 overflow-auto rounded bg-shade p-2 font-mono text-[13px] whitespace-pre-wrap">{result.body || "(empty)"}</pre>
            <p className="font-bold">Response headers</p>
            <pre className="rounded bg-shade p-2 font-mono text-[13px] whitespace-pre-wrap">{JSON.stringify(result.headers, null, 2)}</pre>
            <p className="font-bold">Logs</p>
            <pre className="max-h-64 overflow-auto rounded bg-shade p-2 font-mono text-[12px] whitespace-pre-wrap">{result.log || "(no log)"}</pre>
          </div>
        </Modal>
      )}
    </>
  );
}
