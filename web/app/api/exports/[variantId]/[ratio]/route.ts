import { NextResponse } from "next/server";
import { presignRedirect, UUID_RE } from "@/lib/worker";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ variantId: string; ratio: string }> },
) {
  const { variantId, ratio } = await params;
  if (!UUID_RE.test(variantId) || !/^[0-9a-z.x]+$/.test(ratio)) {
    return new NextResponse("bad id", { status: 400 });
  }
  return presignRedirect(`/export/${variantId}/${ratio}`);
}
