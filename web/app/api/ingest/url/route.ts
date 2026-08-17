import { NextResponse } from "next/server";
import { workerBase } from "@/lib/worker";

export const dynamic = "force-dynamic";

/** URL ingest: forwards to the worker's form endpoint with the token
 * injected server-side. */
export async function POST(req: Request) {
  const w = workerBase();
  if (!w) {
    return NextResponse.json(
      { error: "worker not connected — set WORKER_URL and INGEST_TOKEN" },
      { status: 503 },
    );
  }
  const body = await req.json().catch(() => ({}));
  const url = String(body.url ?? "").trim();
  const source = body.source === "ad_creative" ? "ad_creative" : "longform";
  if (!/^https?:\/\//.test(url)) {
    return NextResponse.json({ error: "source URL must be http(s)" }, { status: 400 });
  }
  const form = new URLSearchParams({
    key: w.token,
    url,
    source,
    title: String(body.title ?? ""),
  });
  const res = await fetch(`${w.base}/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    redirect: "manual",
  });
  if (res.status !== 303) {
    return NextResponse.json({ error: `worker refused (${res.status})` }, { status: 502 });
  }
  const loc = res.headers.get("location") ?? "";
  const queued = /queued=([0-9a-f-]+)/.exec(loc)?.[1] ?? null;
  return NextResponse.json({ video_id: queued });
}
