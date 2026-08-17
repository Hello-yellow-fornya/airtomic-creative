import { NextResponse } from "next/server";

/** Shared presign-proxy plumbing: ask the worker for a presigned URL and
 * 302 the browser to it. The ingest token stays server-side; the browser
 * only ever sees a time-limited presigned R2 URL. */
export function workerBase(): { base: string; token: string } | null {
  const base = process.env.WORKER_URL?.replace(/\/$/, "");
  const token = process.env.INGEST_TOKEN;
  if (!base || !token) return null;
  return { base, token };
}

export async function presignRedirect(path: string): Promise<NextResponse> {
  const w = workerBase();
  if (!w) return new NextResponse("worker not configured", { status: 404 });
  const res = await fetch(
    `${w.base}${path}${path.includes("?") ? "&" : "?"}key=${encodeURIComponent(w.token)}`,
    { redirect: "manual" },
  );
  const loc = res.headers.get("location");
  if ((res.status !== 303 && res.status !== 302) || !loc) {
    return new NextResponse("not available", { status: res.status === 409 ? 409 : 404 });
  }
  return NextResponse.redirect(loc, 302);
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
