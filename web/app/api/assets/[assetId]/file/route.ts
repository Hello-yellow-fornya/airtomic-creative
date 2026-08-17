import { NextResponse } from "next/server";
import { presignRedirect, UUID_RE } from "@/lib/worker";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ assetId: string }> },
) {
  const { assetId } = await params;
  if (!UUID_RE.test(assetId)) return new NextResponse("bad id", { status: 400 });
  return presignRedirect(`/asset/${assetId}`);
}
