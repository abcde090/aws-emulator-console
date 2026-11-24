/**
 * Downloads one S3 object through the permission-checked client (s3:GetObject is checked
 * for the acting identity). GET /api/s3/object?bucket=<bucket>&key=<key>[&versionId=<id>]
 * The body is streamed, never buffered whole in memory.
 */

import { GetObjectCommand } from "@aws-sdk/client-s3";
import { clients } from "@/lib/aws";
import { errorMessage } from "@/console/serialize";
import { attachmentHeader, isBucketName } from "@/services/s3/object-paths";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const bucket = url.searchParams.get("bucket");
  const key = url.searchParams.get("key");
  const versionId = url.searchParams.get("versionId") || undefined;
  if (!isBucketName(bucket) || !key || key.length > 1024 || (versionId !== undefined && versionId.length > 1024)) {
    return new Response("Bad request: bucket and key are required.", { status: 400 });
  }
  try {
    const r = await clients.s3.send(new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }));
    if (!r.Body) return new Response("S3 returned no body.", { status: 502 });
    return new Response(r.Body.transformToWebStream(), {
      headers: {
        ...(r.ContentLength !== undefined ? { "Content-Length": String(r.ContentLength) } : {}),
        // Always a download, never rendered: object content is untrusted.
        "Content-Type": "application/octet-stream",
        "Content-Disposition": attachmentHeader(key),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      },
    });
  } catch (err: unknown) {
    const message = errorMessage(err);
    return new Response(message, { status: message.startsWith("AccessDenied") ? 403 : 502, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
}
