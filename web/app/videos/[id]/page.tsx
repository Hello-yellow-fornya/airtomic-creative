import { notFound } from "next/navigation";
import { q } from "@/lib/db";
import Transcript from "./Transcript";

export const dynamic = "force-dynamic";

type SceneRow = { idx: number; start_s: string; end_s: string };

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

  const scenes = await q<SceneRow>(
    "SELECT idx, start_s::text, end_s::text FROM scenes WHERE video_id = $1 ORDER BY idx",
    [id],
  );

  const segments = await q<{
    id: string; idx: number; speaker: string | null; start_s: string;
  }>(
    `SELECT s.id::text, s.idx, s.speaker, s.start_s::text
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

  const duration = parseFloat(video.duration_s ?? "0") || 1;

  return (
    <>
      <h1>{video.title ?? "untitled"}</h1>
      <p className="sub">
        {scenes.length} scenes · {words.length} words · status {video.status}
      </p>

      <div className="timeline">
        {scenes.map((s) => {
          const d = parseFloat(s.end_s) - parseFloat(s.start_s);
          return (
            <div
              key={s.idx}
              className="scene"
              style={{ flex: Math.max(d / duration, 0.004) }}
              title={`scene ${s.idx} · ${s.start_s}s – ${s.end_s}s`}
            >
              s{s.idx}
            </div>
          );
        })}
      </div>
      <p className="hint">
        Scene timeline (widths proportional to duration). Select a passage below
        to cut a clip: click the first word, then the last word.
      </p>

      <Transcript
        videoId={video.id}
        segments={segments.map((s) => ({
          id: s.id, speaker: s.speaker,
        }))}
        words={words.map((w) => ({
          idx: w.idx, word: w.word,
          start: w.start_s ? parseFloat(w.start_s) : null,
          end: w.end_s ? parseFloat(w.end_s) : null,
          seg: w.segment_id,
        }))}
      />
    </>
  );
}
