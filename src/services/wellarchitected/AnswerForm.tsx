"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, ErrorBanner, Flash } from "@/console/ui/primitives";
import { saveAnswer } from "./answer-actions";
import { MAX_NOTES, NOT_APPLICABLE_REASONS, RISK_LABELS, toggleChoice } from "./helpers";

export interface ChoiceView {
  id: string;
  title: string;
  description: string | null;
}

interface AnswerFormProps {
  workloadId: string;
  lens: string;
  questionId: string;
  choices: ChoiceView[];
  initialSelected: string[];
  initialNotes: string;
  initialApplicable: boolean;
  initialReason: string | null;
}

export function AnswerForm({ workloadId, lens, questionId, choices, initialSelected, initialNotes, initialApplicable, initialReason }: AnswerFormProps) {
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>(initialSelected);
  const [notes, setNotes] = useState(initialNotes);
  const [applicable, setApplicable] = useState(initialApplicable);
  const [reason, setReason] = useState(initialReason ?? "OUT_OF_SCOPE");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const choiceLikes = choices.map((c) => ({ ChoiceId: c.id, Title: c.title }));

  async function save() {
    setBusy(true);
    setError(null);
    setNotice(null);
    const r = await saveAnswer(workloadId, lens, questionId, { selected, notes, applicable, reason });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setNotice(`Answer saved. Risk: ${r.data.risk ? RISK_LABELS[r.data.risk] ?? r.data.risk : "-"}`);
    router.refresh();
  }

  return (
    <div className="space-y-4" data-testid="answer-form">
      {notice && <Flash kind="success" message={notice} onDismiss={() => setNotice(null)} />}
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      <label className="flex items-start gap-2">
        <input type="checkbox" className="mt-1" checked={!applicable} onChange={(e) => setApplicable(!e.target.checked)} />
        <span className="font-bold">Question does not apply to this workload</span>
      </label>
      {!applicable && (
        <div>
          <label htmlFor="na-reason" className="block font-bold">
            Reason
          </label>
          <select id="na-reason" className="mt-1 rounded-[4px] border border-[#879596] bg-white px-2 py-1" value={reason} onChange={(e) => setReason(e.target.value)}>
            {NOT_APPLICABLE_REASONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
      )}
      <fieldset disabled={!applicable} className={applicable ? "" : "opacity-50"}>
        <legend className="font-bold">Choices</legend>
        <ul className="mt-2 space-y-2">
          {choices.map((c) => (
            <li key={c.id}>
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={selected.includes(c.id)}
                  onChange={(e) => setSelected(toggleChoice(choiceLikes, selected, c.id, e.target.checked))}
                />
                <span>
                  <span className="font-bold">{c.title}</span>
                  {c.description && <span className="block text-[13px] text-muted">{c.description}</span>}
                </span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
      <div>
        <label htmlFor="answer-notes" className="block font-bold">
          Notes <span className="font-normal italic text-muted">- optional</span>
        </label>
        <textarea
          id="answer-notes"
          className="mt-1 min-h-24 w-full rounded-[4px] border border-[#879596] bg-white px-2.5 py-1"
          maxLength={MAX_NOTES}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
        <p className="text-[13px] text-muted">{MAX_NOTES - notes.length} characters left.</p>
      </div>
      <Button variant="primary" disabled={busy} onClick={() => void save()} data-testid="save-answer">
        {busy ? "Saving…" : "Save"}
      </Button>
    </div>
  );
}
