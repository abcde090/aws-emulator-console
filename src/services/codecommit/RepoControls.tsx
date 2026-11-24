"use client";

/**
 * Client controls for the repository screen: the branch picker and the Create file /
 * Edit / Delete file dialogs. Commits go through the engine's runAction (the repository
 * definition's hidden put-file and delete-file actions), so values are validated on the server.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import { runAction } from "@/console/actions";
import { Modal } from "@/console/ui/Modal";
import { Button, ErrorBanner } from "@/console/ui/primitives";
import { repoHref } from "./helpers";


interface BranchPickerProps {
  repo: string;
  branches: string[];
  current: string;
}

export function BranchPicker({ repo, branches, current }: BranchPickerProps) {
  const router = useRouter();
  return (
    <label className="inline-flex items-center gap-2">
      <span className="font-bold">Branch</span>
      <select
        aria-label="Branch"
        className="rounded-[4px] border border-[#879596] bg-white px-2 py-1"
        value={branches.includes(current) ? current : ""}
        onChange={(e) => router.push(repoHref(repo, { ref: e.target.value }))}
      >
        {!branches.includes(current) && <option value="">{current.slice(0, 8)}</option>}
        {branches.map((b) => (
          <option key={b} value={b}>
            {b}
          </option>
        ))}
      </select>
    </label>
  );
}

type Mode = { kind: "create"; folder: string } | { kind: "edit"; path: string; content: string } | { kind: "delete"; path: string };

interface FileEditorProps {
  repo: string;
  branch: string;
  /** Head commit of the branch, or null for the first commit in an empty repository. */
  parentCommitId: string | null;
  mode: Mode;
  label: string;
  primary?: boolean;
}

const inputClass = "w-full rounded-[4px] border border-[#879596] bg-white px-2.5 py-1.5 text-[13px] focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary";

export function FileEditor({ repo, branch, parentCommitId, mode, label, primary = false }: FileEditorProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState(mode.kind === "create" ? (mode.folder ? `${mode.folder}/` : "") : mode.path);
  const [content, setContent] = useState(mode.kind === "edit" ? mode.content : "");
  const [branchName, setBranchName] = useState(branch);
  const [author, setAuthor] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    const common = { branch: branchName, filePath: path, parentCommitId: parentCommitId ?? "", authorName: author, email, message };
    const r =
      mode.kind === "delete"
        ? await runAction("codecommit", "repositories", repo, "delete-file", common)
        : await runAction("codecommit", "repositories", repo, "put-file", { ...common, content });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setOpen(false);
    const notice = r.data.message ?? "";
    router.push(mode.kind === "delete" ? repoHref(repo, { ref: branchName, notice }) : repoHref(repo, { ref: branchName, file: path.replace(/^\/+/, ""), notice }));
    router.refresh();
  }

  const title = mode.kind === "create" ? "Create a file" : mode.kind === "edit" ? `Edit ${mode.path}` : `Delete ${mode.path}`;
  return (
    <>
      <Button variant={primary ? "primary" : "normal"} onClick={() => setOpen(true)}>
        {label}
      </Button>
      {open && (
        <Modal
          title={title}
          wide={mode.kind !== "delete"}
          onClose={() => setOpen(false)}
          footer={
            <>
              <Button variant="link" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button variant="primary" disabled={busy || path.trim() === ""} onClick={() => void submit()} data-testid="commit-file">
                {busy ? "Committing…" : mode.kind === "delete" ? "Delete file" : "Commit changes"}
              </Button>
            </>
          }
        >
          {error && <ErrorBanner message={error} />}
          {mode.kind === "delete" && <p>Deleting the file creates a commit on {branch} that removes it.</p>}
          {mode.kind === "create" && (
            <label className="block space-y-1">
              <span className="font-bold">File name</span>
              <input aria-label="File name" className={inputClass} value={path} onChange={(e) => setPath(e.target.value)} placeholder="docs/readme.md" />
            </label>
          )}
          {mode.kind !== "delete" && (
            <label className="block space-y-1">
              <span className="font-bold">File content</span>
              <textarea aria-label="File content" rows={14} className={`${inputClass} font-mono text-[13px]`} value={content} onChange={(e) => setContent(e.target.value)} />
            </label>
          )}
          {parentCommitId === null && (
            <label className="block space-y-1">
              <span className="font-bold">Branch name</span>
              <input aria-label="Branch name" className={inputClass} value={branchName} onChange={(e) => setBranchName(e.target.value)} />
              <span className="text-muted">The repository is empty: this commit creates the branch.</span>
            </label>
          )}
          <div className="grid gap-3 md:grid-cols-2">
            <label className="block space-y-1">
              <span className="font-bold">Author name</span>
              <input aria-label="Author name" className={inputClass} value={author} onChange={(e) => setAuthor(e.target.value)} />
            </label>
            <label className="block space-y-1">
              <span className="font-bold">Email address</span>
              <input aria-label="Email address" className={inputClass} value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
          </div>
          <label className="block space-y-1">
            <span className="font-bold">Commit message - optional</span>
            <textarea aria-label="Commit message" rows={2} className={inputClass} value={message} onChange={(e) => setMessage(e.target.value)} />
          </label>
        </Modal>
      )}
    </>
  );
}
