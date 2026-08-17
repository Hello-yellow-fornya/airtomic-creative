import { NextResponse } from "next/server";
import { workerBase } from "@/lib/worker";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const w = workerBase();
  if (!w) {
    return NextResponse.json(
      { error: "worker not connected — set WORKER_URL and INGEST_TOKEN" },
      { status: 503 },
    );
  }
  const body = await req.json().catch(() => ({}));
  const res = await fetch(`${w.base}/upload/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, key: w.token }),
  });
  return NextResponse.json(await res.json().catch(() => ({})), { status: res.status });
}
