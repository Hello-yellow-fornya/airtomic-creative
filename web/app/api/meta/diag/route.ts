import { NextResponse } from "next/server";
import { workerBase } from "@/lib/worker";

export const dynamic = "force-dynamic";

/** Read-only Meta credential diagnostics, proxied to the worker (which
 * holds the Meta env). Token scopes, API version check, campaigns and ad
 * sets — proves the credentials end to end without creating anything. */
export async function GET() {
  const w = workerBase();
  if (!w)
    return NextResponse.json({ error: "worker not configured" }, { status: 404 });
  try {
    const res = await fetch(
      `${w.base}/meta/diag?key=${encodeURIComponent(w.token)}`,
      { cache: "no-store", signal: AbortSignal.timeout(120_000) },
    );
    const body = await res.json().catch(() => ({ error: "bad worker response" }));
    return NextResponse.json(body, { status: res.status });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}
