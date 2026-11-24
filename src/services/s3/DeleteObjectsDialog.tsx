"use client";

import { useState } from "react";
import { Modal } from "@/console/ui/Modal";
import { Button } from "@/console/ui/primitives";
import type { VersioningStatus } from "./object-actions";

export type DeleteMode = "markers" | "permanent" | "versions";

interface DeleteObjectsDialogProps {
  mode: DeleteMode;
  items: string[];
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/** What the S3 console asks you to type: "delete" when only delete markers are added. */
export function confirmWord(mode: DeleteMode): string {
  return mode === "markers" ? "delete" : "permanently delete";
}

/** Which delete the browser does for this bucket and view. */
export function deleteMode(versioning: VersioningStatus | null, showVersions: boolean): DeleteMode {
  if (showVersions) return "versions";
  return versioning === "Enabled" || versioning === "Suspended" ? "markers" : "permanent";
}

export function DeleteObjectsDialog({ mode, items, busy, onCancel, onConfirm }: DeleteObjectsDialogProps) {
  const [text, setText] = useState("");
  const word = confirmWord(mode);
  return (
    <Modal
      title={mode === "versions" ? "Delete object versions" : "Delete objects"}
      onClose={onCancel}
      footer={
        <>
          <Button variant="link" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || text !== word} onClick={onConfirm} data-testid="confirm-delete-objects">
            {mode === "versions" ? "Delete versions" : "Delete objects"}
          </Button>
        </>
      }
    >
      {mode === "markers" && (
        <p data-testid="delete-explanation">
          This bucket has versioning. Deleting the specified objects adds delete markers to them; the object versions stay stored and can be restored by
          deleting the marker. To delete versions for good, turn on <strong>Show versions</strong> and select the versions.
        </p>
      )}
      {mode === "permanent" && (
        <p data-testid="delete-explanation">Deleting the specified objects can&apos;t be undone: this bucket has no versioning. Folders are deleted with every object in them.</p>
      )}
      {mode === "versions" && (
        <p data-testid="delete-explanation">Deleting the specified object versions permanently removes them. Deleting a delete marker makes the previous version current again.</p>
      )}
      <ul className="max-h-40 list-disc overflow-auto pl-5 font-mono text-[13px]">
        {items.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>
      <label className="block space-y-1">
        <span>
          To confirm deletion, type <strong>{word}</strong> in the field.
        </span>
        <input aria-label="Confirm object deletion" className="w-full rounded-[4px] border border-[#879596] bg-white px-2.5 py-1" value={text} onChange={(e) => setText(e.target.value)} />
      </label>
    </Modal>
  );
}
