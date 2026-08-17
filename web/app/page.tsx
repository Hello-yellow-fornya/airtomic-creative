import Link from "next/link";
import { q } from "@/lib/db";
import { Topbar } from "./ui";

export const dynamic = "force-dynamic";

type VideoRow = {
  id: string;
  title: string | null;
  status: string;
  status_detail: string | null;
  duration_s: string | null;
  ingested_at: string;
  n_words: string;
  n_scenes: string;
};

function statusTag(status: string) {
  if (status === "ready") return "tag ok";
  if (status === "failed") return "tag flag";
  return "tag";
}

function fmtDur(s: string | null) {
  if (!s) return "—";
  const secs = Math.round(parseFloat(s));
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
}

export default async function VideosPage() {
  const videos = await q<VideoRow>(`
    SELECT v.id, v.title, v.status::text, v.status_detail, v.duration_s::text,
           v.ingested_at::text,
           (SELECT count(*) FROM transcript_words w
            JOIN transcripts t ON t.id = w.transcript_id
            WHERE t.video_id = v.id)::text AS n_words,
           (SELECT count(*) FROM scenes s WHERE s.video_id = v.id)::text AS n_scenes
    FROM videos v ORDER BY v.ingested_at DESC LIMIT 100`);

  return (
    <>
      <Topbar
        title="Library"
        sub="Long-form source material. Open a video to browse the transcript and cut clips."
      />
      <section className="screen">
        <h2 className="sec">Long-form source</h2>
        {videos.length === 0 && (
          <div className="card qempty">Nothing ingested yet.</div>
        )}
        <div className="grid-assets">
          {videos.map((v) => (
            <Link key={v.id} href={`/videos/${v.id}`} className="card asset">
              <div className="thumb">
                <div className="head" />
                <div className="head b" />
                <span className="dur mono">{fmtDur(v.duration_s)}</span>
              </div>
              <div className="asset-meta">
                <h3>{v.title ?? "untitled"}</h3>
                <div className="m">
                  {v.n_words} words · {v.n_scenes} scenes
                </div>
                <div style={{ marginTop: 7 }}>
                  <span
                    className={statusTag(v.status)}
                    title={v.status_detail ?? undefined}
                  >
                    {v.status}
                    {v.status_detail && v.status !== "ready"
                      ? ` · ${v.status_detail}`
                      : ""}
                  </span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      </section>
    </>
  );
}
