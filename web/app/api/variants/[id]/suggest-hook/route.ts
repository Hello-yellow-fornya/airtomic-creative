import { NextResponse } from "next/server";
import { workerBase, UUID_RE } from "@/lib/worker";

export const dynamic = "force-dynamic";

/** "Suggest hook": one Claude call on the worker (which holds the API key)
 * with the transcript slice for the overlay's time range plus the video's
 * creative tags. Returns three options with distinct angles. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!UUID_RE.test(id))
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  const w = workerBase();
  if (!w)
    return NextResponse.json({ error: "worker not configured" }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  try {
    const res = await fetch(`${w.base}/overlay/suggest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: w.token, variant_id: id,
        start_s: +body.start_s || 0, end_s: +body.end_s || 3,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const out = await res.json().catch(() => ({ error: "bad worker response" }));
    return NextResponse.json(out, { status: res.status });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
