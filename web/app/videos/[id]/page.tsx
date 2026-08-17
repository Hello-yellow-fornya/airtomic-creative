import Link from "next/link";
import { notFound } from "next/navigation";
import { q } from "@/lib/db";
import { Topbar } from "../../ui";
import Analyse from "./Analyse";

export const dynamic = "force-dynamic";

export default async function VideoPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [video] = await q<{
    id: string; title: string | null; status: string; duration_s: string | null;
  }>(
    "SELECT id, title, status::text, duration_s::text FROM videos WHERE id = $1",
    [id],
  );
  if (!video) notFound();

  const scenes = await q<{ id: string; idx: number; start_s: string; end_s: string; has_kf: boolean }>(
    `SELECT id::text, idx, start_s::text, end_s::text,
            (keyframe_uri IS NOT NULL) AS has_kf
     FROM scenes WHERE video_id = $1 ORDER BY idx`,
    [id],
  );

  const segments = await q<{
    id: string; idx: number; speaker: string | null; start_s: string; end_s: string;
  }>(
    `SELECT s.id::text, s.idx, s.speaker, s.start_s::text, s.end_s::text
     FROM transcript_segments s JOIN transcripts t ON t.id = s.transcript_id
     WHERE t.video_id = $1 ORDER BY s.idx`,
    [id],
  );
  const words = await q<{
    idx: number; word: string; start_s: string | null; end_s: string | null;
    segment_id: string | null;
  }>(
    `SELECT w.idx, w.word, w.start_s::text, w.end_s::text, w.segment_id::text
     FROM transcript_words w JOIN transcripts t ON t.id = w.transcript_id
     WHERE t.video_id = $1 ORDER BY w.idx`,
    [id],
  );

  // Suggested cuts, if the recommendation engine has produced any.
  const candidates = await q<{
    id: string; start_s: string; end_s: string; score: string | null;
    rationale: string | null;
  }>(
    `SELECT id::text, start_s::text, end_s::text, score::text, rationale
     FROM clip_candidates WHERE video_id = $1 AND status = 'suggested'
     ORDER BY score DESC NULLS LAST`,
    [id],
  );

  const kfEnabled = !!(process.env.WORKER_URL && process.env.INGEST_TOKEN);
  const duration = parseFloat(video.duration_s ?? "0") || 1;
  const speakers = [...new Set(segments.map((s) => s.speaker).filter(Boolean))] as string[];

  return (
    <>
      <Topbar
        title={video.title ?? "untitled"}
        sub="Word-level timing, speakers and scene boundaries"
      >
        <Link className="btn ghost sm" href={`/cuts?video=${video.id}`}>
          See suggested cuts
        </Link>
      </Topbar>
      <section className="screen">
        <Analyse
          videoId={video.id}
          title={video.title ?? "untitled"}
          duration={duration}
          nSpeakers={speakers.length}
          scenes={scenes.map((s) => ({
            id: s.id, idx: s.idx,
            start: parseFloat(s.start_s), end: parseFloat(s.end_s),
            hasKf: s.has_kf,
          }))}
          segments={segments.map((s) => ({
            id: s.id, speaker: s.speaker,
            start: parseFloat(s.start_s), end: parseFloat(s.end_s),
          }))}
          words={words.map((w) => ({
            idx: w.idx, word: w.word,
            start: w.start_s ? parseFloat(w.start_s) : null,
            end: w.end_s ? parseFloat(w.end_s) : null,
            seg: w.segment_id,
          }))}
          candidates={candidates.map((c, i) => ({
            id: c.id, rank: i + 1,
            start: parseFloat(c.start_s), end: parseFloat(c.end_s),
            score: c.score ? parseFloat(c.score) : null,
          }))}
          speakers={speakers}
          kfEnabled={kfEnabled}
        />
      </section>
    </>
  );
}
