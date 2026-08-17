import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Keyframe proxy: asks the worker for a presigned URL and 302s the browser
 * to it. The ingest token stays server-side (never in page HTML); the
 * browser only ever sees a time-limited presigned R2 URL. Requires
 * WORKER_URL + INGEST_TOKEN env — optional, thumbnails just don't render
 * without them. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ sceneId: string }> },
) {
  const { sceneId } = await params;
  const base = process.env.WORKER_URL?.replace(/\/$/, "");
  const token = process.env.INGEST_TOKEN;
  if (!base || !token || !/^\d+$/.test(sceneId)) {
    return new NextResponse("not configured", { status: 404 });
  }
  const res = await fetch(
    `${base}/kf/${sceneId}?key=${encodeURIComponent(token)}`,
    { redirect: "manual" },
  );
  const loc = res.headers.get("location");
  if ((res.status !== 303 && res.status !== 302) || !loc) {
    return new NextResponse("no keyframe", { status: 404 });
  }
  return NextResponse.redirect(loc, 302);
}
