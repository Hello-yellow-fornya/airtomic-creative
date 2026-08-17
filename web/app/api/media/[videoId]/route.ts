import { NextResponse } from "next/server";
import { presignRedirect, UUID_RE } from "@/lib/worker";

export const dynamic = "force-dynamic";

/** Source-video proxy for the builder's player. Same pattern as keyframes:
 * worker presigns, browser follows a short-lived R2 URL. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ videoId: string }> },
) {
  const { videoId } = await params;
  if (!UUID_RE.test(videoId)) return new NextResponse("bad id", { status: 400 });
  return presignRedirect(`/media/${videoId}`);
}
