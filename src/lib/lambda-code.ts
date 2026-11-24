/**
 * Helpers for showing a Lambda function's deployed code in the editor.
 */

export interface EditableFile {
  file: string | null;
  editable: boolean;
}

/**
 * Picks the handler's source file from a deployment package. Only a single-file package is
 * editable, because Deploy uploads just that one file and would drop the rest.
 */
export function pickEditableFile(entries: string[], handler: string): EditableFile {
  const files = entries.filter((name) => !name.endsWith("/"));
  const moduleName = handler.split(".")[0];
  const match = files.find((name) => baseName(name).replace(/\.[^.]+$/, "") === moduleName);
  const file = match ?? (files.length === 1 ? files[0] : null);
  return { file, editable: file !== null && files.length === 1 };
}

/** True when the code download URL points at the emulator itself, never anywhere else. */
export function isEmulatorLocation(location: string | undefined, endpoint: string): boolean {
  if (!location) return false;
  try {
    return new URL(location).origin === new URL(endpoint).origin;
  } catch {
    return false;
  }
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export interface LambdaReport {
  durationMs: number | null;
  billedDurationMs: number | null;
  memorySizeMb: number | null;
  maxMemoryUsedMb: number | null;
}

/** Reads the figures from the REPORT line in Lambda's log tail. A figure the log lacks is null. */
export function parseLambdaReport(logs: string): LambdaReport {
  const report = logs.split("\n").find((line) => line.startsWith("REPORT ")) ?? "";
  const pick = (label: string): number | null => {
    const m = report.match(new RegExp(`(?:^|\\t)${label}: ([\\d.]+)`));
    return m ? Number(m[1]) : null;
  };
  return {
    durationMs: pick("Duration"),
    billedDurationMs: pick("Billed Duration"),
    memorySizeMb: pick("Memory Size"),
    maxMemoryUsedMb: pick("Max Memory Used"),
  };
}
