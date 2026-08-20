import { NextResponse } from "next/server";
import { presignRedirect, UUID_RE } from "@/lib/worker";

export const dynamic = "force-dynamic";

/** Presign proxy for finished exports. `ratio` may carry an extension —
 * 9x16, 9x16.mp4, 9x16.srt (the subtitle sidecar). ?dl=<name> forces a
 * download under an ad-convention filename instead of a UUID. */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ variantId: string; ratio: string }> },
) {
  const { variantId, ratio } = await params;
  if (!UUID_RE.test(variantId) || !/^[0-9a-z.x]+(\.(mp4|srt))?$/.test(ratio)) {
    return new NextResponse("bad id", { status: 400 });
  }
  const dl = new URL(req.url).searchParams.get("dl");
  const safe = dl ? dl.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 150) : null;
  return presignRedirect(
    `/export/${variantId}/${ratio}${safe ? `?dl=${encodeURIComponent(safe)}` : ""}`,
  );
}
