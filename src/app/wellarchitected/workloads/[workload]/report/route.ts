/**
 * Downloads a lens review report (PDF) through the permission-checked client.
 * GET /wellarchitected/workloads/<id>/report?lens=<alias>[&milestone=<n>]
 */

import { GetLensReviewReportCommand, GetWorkloadCommand } from "@aws-sdk/client-wellarchitected";
import { clients } from "@/lib/aws";
import { errorMessage } from "@/console/serialize";
import { LENS_ALIAS, parseMilestone, reportFileName, WORKLOAD_ID } from "@/services/wellarchitected/helpers";

const textResponse = (message: string, status: number): Response => new Response(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

export async function GET(request: Request, { params }: { params: Promise<{ workload: string }> }): Promise<Response> {
  const workloadId = (await params).workload;
  const url = new URL(request.url);
  const lens = url.searchParams.get("lens") ?? "";
  const milestone = parseMilestone(url.searchParams.get("milestone"));
  if (!WORKLOAD_ID.test(workloadId) || !LENS_ALIAS.test(lens) || milestone === "invalid") {
    return textResponse("Bad request: a workload ID, a lens alias and an optional milestone number (1-100) are required.", 400);
  }
  try {
    const wa = clients.wellarchitected;
    const r = await wa.send(new GetLensReviewReportCommand({ WorkloadId: workloadId, LensAlias: lens, MilestoneNumber: milestone ?? undefined }));
    const b64 = r.LensReviewReport?.Base64String;
    if (!b64) return textResponse("Well-Architected returned no report.", 502);
    const name = (await wa.send(new GetWorkloadCommand({ WorkloadId: workloadId }))).Workload?.WorkloadName ?? workloadId;
    return new Response(Buffer.from(b64, "base64"), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${reportFileName(name, lens, milestone)}"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      },
    });
  } catch (err: unknown) {
    const message = errorMessage(err);
    return textResponse(message, message.startsWith("AccessDenied") ? 403 : 502);
  }
}
