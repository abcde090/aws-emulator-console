"use client";

import { useEffect, useRef, useState } from "react";
import { runCloudShellCommand } from "./actions";
import { emptyHistory, moveHistory, pushHistory, type History } from "./history";

interface Entry {
  id: number;
  command: string;
  output: string;
  ok: boolean | null;
}

const QUICK_COMMANDS = [
  "aws --version",
  "aws sts get-caller-identity",
  "aws s3 ls",
  "aws sqs list-queues",
  "aws iam list-users",
];

interface CloudShellProps {
  open: boolean;
  onClose: () => void;
  identityLabel: string;
  /** The Region chosen in the top bar: commands run there (AWS_REGION). */
  region: string;
}

export function CloudShell({ open, onClose, identityLabel, region }: CloudShellProps) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [line, setLine] = useState("");
  const [history, setHistory] = useState<History>(emptyHistory);
  const [running, setRunning] = useState(false);
  const [tall, setTall] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const nextId = useRef(1);

  // OG-10: the input is disabled while a command runs, which drops focus; take it back after.
  useEffect(() => {
    if (open && !running) input.current?.focus();
  }, [open, running]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [entries]);

  async function runLine(raw: string) {
    const command = raw.trim();
    if (command === "" || running) return;
    setHistory((h) => pushHistory(h, command));
    setLine("");
    if (command === "clear") return setEntries([]);
    const id = nextId.current++;
    setEntries((e) => [...e, { id, command, output: "", ok: null }]);
    setRunning(true);
    try {
      const r = await runCloudShellCommand(command);
      setEntries((e) => e.map((x) => (x.id === id ? { ...x, output: r.output, ok: r.ok } : x)));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setEntries((e) =>
        e.map((x) => (x.id === id ? { ...x, output: `CloudShell request failed (reload the page if the server restarted): ${msg}`, ok: false } : x))
      );
    } finally {
      setRunning(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      void runLine(line);
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const moved = moveHistory(history, e.key === "ArrowUp" ? "up" : "down");
      setHistory(moved.history);
      setLine(moved.line);
    }
  }

  if (!open) return null;
  return (
    <section
      aria-label="CloudShell"
      className={`fixed inset-x-0 bottom-0 z-40 flex flex-col border-t-2 border-[#ff9900] bg-[#0f141a] text-[#e9ebed] shadow-2xl transition-all ${
        tall ? "h-[72vh]" : "h-[40vh]"
      }`}
      data-testid="cloudshell"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#2a3441] bg-[#161e2d] px-4 py-1.5 text-[13px]">
        <span className="flex items-center gap-2 font-semibold">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ff9900" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="4 17 10 11 4 5" />
            <line x1="12" y1="19" x2="20" y2="19" />
          </svg>
          <span>AWS CloudShell</span>
          <span className="font-normal text-[#9ba7b6]">
            <span data-testid="cloudshell-region">{region}</span> · as {identityLabel} · aws commands only, sandboxed
          </span>
        </span>
        <div className="flex items-center gap-2 text-[12px]">
          <button
            type="button"
            className="rounded px-2 py-0.5 text-[#d5dbdb] hover:bg-white/10 hover:text-white"
            onClick={() => setTall((t) => !t)}
          >
            {tall ? "Restore" : "Expand"}
          </button>
          <button type="button" className="rounded px-2 py-0.5 text-[#d5dbdb] hover:bg-white/10 hover:text-white" onClick={() => setEntries([])}>
            Clear
          </button>
          <button
            type="button"
            aria-label="Close CloudShell"
            className="rounded px-1.5 py-0.5 text-[#d5dbdb] hover:bg-white/10 hover:text-white"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
      </div>

      {/* Quick-run command chips */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-[#1f2937] bg-[#121821] px-4 py-1 text-[11px]">
        <span className="text-[#879596]">Try:</span>
        {QUICK_COMMANDS.map((cmd) => (
          <button
            key={cmd}
            type="button"
            disabled={running}
            onClick={() => void runLine(cmd)}
            className="rounded border border-[#2a3441] bg-[#161e2d] px-2 py-0.5 font-mono text-[#d5dbdb] hover:border-[#539fe5] hover:text-white disabled:opacity-50"
          >
            {cmd}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-auto px-4 py-2.5 font-mono text-[13px] leading-5" onClick={() => input.current?.focus()}>
        {entries.length === 0 && (
          <p className="mb-2 text-[#9ba7b6]">
            Run <code className="text-[#e9ebed]">aws</code> CLI commands against the local emulator (e.g. <code className="text-[#e9ebed]">aws s3 ls</code>,{" "}
            <code className="text-[#e9ebed]">aws --version</code>, <code className="text-[#e9ebed]">aws s3 help</code>). Use Up/Down arrows for history.
          </p>
        )}
        {entries.map((e) => (
          <div key={e.id} className="mb-2">
            <p>
              <span className="text-[#7ee787]">[cloudshell-user@emulator ~]$</span> {e.command}
            </p>
            {e.ok === null ? (
              <p className="text-[#9ba7b6]">running…</p>
            ) : (
              <pre className={`whitespace-pre-wrap break-words ${e.ok ? "text-[#e9ebed]" : "text-[#ff7b72]"}`} data-testid="cloudshell-output">
                {e.output || (e.ok ? "" : "(no output)")}
              </pre>
            )}
          </div>
        ))}
        <div className="flex items-center gap-2" ref={bottom}>
          <span className="shrink-0 text-[#7ee787]">[cloudshell-user@emulator ~]$</span>
          <input
            ref={input}
            aria-label="CloudShell command"
            className="flex-1 !border-0 !bg-transparent font-mono text-[13px] !text-white outline-none"
            value={line}
            disabled={running}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setLine(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
      </div>
    </section>
  );
}
