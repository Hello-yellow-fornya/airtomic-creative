import Link from "next/link";
import { q } from "@/lib/db";

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

function badgeClass(status: string) {
  if (status === "ready") return "badge ready";
  if (status === "failed") return "badge failed";
  return "badge working";
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
      <h1>Videos</h1>
      <p className="sub">Ingested source videos. Open one to browse the transcript and cut clips.</p>
      {videos.length === 0 && <p className="hint">Nothing ingested yet.</p>}
      {videos.map((v) => (
        <Link key={v.id} href={`/videos/${v.id}`}>
          <div className="card">
            <div className="row">
              <strong>{v.title ?? "untitled"}</strong>
              <span className={badgeClass(v.status)}>{v.status}</span>
            </div>
            <div className="meta">
              {fmtDur(v.duration_s)} · {v.n_words} words · {v.n_scenes} scenes
              {v.status_detail ? ` · ${v.status_detail}` : ""}
            </div>
          </div>
        </Link>
      ))}
    </>
  );
}
