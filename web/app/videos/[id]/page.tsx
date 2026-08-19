import { notFound } from "next/navigation";
import { q } from "@/lib/db";
import { Topbar } from "../../ui";
import Find from "./Find";
import RenameButton from "./RenameButton";

export const dynamic = "force-dynamic";

const mmss = (t: number) =>
  `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

export default async function VideoPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [video] = await q<{
    id: string; title: string | null; status: string; duration_s: string | null;
    width: number | null; height: number | null;
  }>(
    "SELECT id, title, status::text, duration_s::text, width, height FROM videos WHERE id = $1",
    [id],
  );
  if (!video) notFound();

  const segments = await q<{
    id: string; idx: number; speaker: string | null; start_s: string; end_s: string;
  }>(
    `SELECT s.id::text, s.idx, s.speaker, s.start_s::text, s.end_s::text
     FROM transcript_segments s JOIN transcripts t ON t.id = s.transcript_id
     WHERE t.video_id = $1 ORDER BY s.idx`,
    [id],
  );
  const words = await q<{
    word: string; start_s: string | null; end_s: string | null; segment_id: string | null;
  }>(
    `SELECT w.word, w.start_s::text, w.end_s::text, w.segment_id::text
     FROM transcript_words w JOIN transcripts t ON t.id = w.transcript_id
     WHERE t.video_id = $1 ORDER BY w.idx`,
    [id],
  );
  const candidates = await q<{
    id: string; start_s: string; end_s: string; score: string | null;
    rationale: string | null; matched_tags: Record<string, unknown> | null;
  }>(
    `SELECT id::text, start_s::text, end_s::text, score::text, rationale, matched_tags
     FROM clip_candidates WHERE video_id = $1 AND status = 'suggested'
     ORDER BY score DESC NULLS LAST`,
    [id],
  );
  const [{ n_scenes }] = await q<{ n_scenes: string }>(
    "SELECT count(*)::text AS n_scenes FROM scenes WHERE video_id = $1",
    [id],
  );

  const duration = parseFloat(video.duration_s ?? "0") || 1;
  const speakers = [...new Set(segments.map((s) => s.speaker).filter(Boolean))] as string[];
  const workerUp = !!(process.env.WORKER_URL && process.env.INGEST_TOKEN);

  return (
    <>
      <Topbar
        title={video.title ?? "untitled"}
        sub={
          <span className="mono">
            {mmss(duration)} · {n_scenes} scenes · {speakers.length} speaker
            {speakers.length === 1 ? "" : "s"} · {candidates.length} suggested cut
            {candidates.length === 1 ? "" : "s"}
          </span>
        }
      >
        <RenameButton videoId={video.id} current={video.title} />
      </Topbar>
      <section className="screen" style={{ padding: "13px 22px 40px" }}>
        <Find
          video={{
            id: video.id,
            duration,
            srcAr: (video.width ?? 16) / Math.max(video.height ?? 9, 1),
          }}
          lines={segments.map((s) => ({
            id: s.id,
            speaker: s.speaker,
            start: parseFloat(s.start_s),
            end: parseFloat(s.end_s),
            words: words
              .filter((w) => w.segment_id === s.id && w.start_s && w.end_s)
              .map((w) => ({ w: w.word, s: parseFloat(w.start_s!), e: parseFloat(w.end_s!) })),
          }))}
          cuts={candidates.map((c, i) => {
            const tags = (c.matched_tags ?? {}) as {
              n?: number; stat?: string; flag?: boolean; evidence?: string;
            };
            return {
              id: c.id,
              rank: i + 1,
              start: parseFloat(c.start_s),
              end: parseFloat(c.end_s),
              score: c.score ? parseFloat(c.score) : null,
              why: c.rationale,
              n: typeof tags.n === "number" ? tags.n : null,
              stat: tags.stat ?? null,
              evidence: typeof tags.evidence === "string" ? tags.evidence : null,
              flag: !!tags.flag,
            };
          })}
          speakers={speakers}
          workerUp={workerUp}
        />
      </section>
    </>
  );
}
