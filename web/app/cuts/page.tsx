import { q } from "@/lib/db";
import { Topbar } from "../ui";
import CutCards from "./CutCards";

export const dynamic = "force-dynamic";

/** 03 Suggested cuts. Every card carries n= and its evidence line —
 * CLAUDE.md §5: recommendations without sample context are worse than no
 * ranking. If the engine hasn't produced candidates, this page says so
 * instead of inventing cards. */
export default async function CutsPage({
  searchParams,
}: {
  searchParams: Promise<{ video?: string }>;
}) {
  const { video } = await searchParams;

  const candidates = await q<{
    id: string; video_id: string; video_title: string | null;
    start_s: string; end_s: string; score: string | null;
    rationale: string | null; matched_tags: Record<string, unknown> | null;
    model_version: string | null;
  }>(
    `SELECT cc.id::text, cc.video_id::text, v.title AS video_title,
            cc.start_s::text, cc.end_s::text, cc.score::text,
            cc.rationale, cc.matched_tags, cc.model_version
     FROM clip_candidates cc JOIN videos v ON v.id = cc.video_id
     WHERE cc.status = 'suggested' ${video ? "AND cc.video_id = $1" : ""}
     ORDER BY cc.score DESC NULLS LAST
     LIMIT 60`,
    video ? [video] : [],
  );

  // Words inside each candidate range, for the quote on the card.
  const quotes = new Map<string, string>();
  for (const c of candidates.slice(0, 24)) {
    const words = await q<{ word: string }>(
      `SELECT w.word FROM transcript_words w
       JOIN transcripts t ON t.id = w.transcript_id
       WHERE t.video_id = $1 AND w.start_s >= $2 AND w.end_s <= $3
       ORDER BY w.idx LIMIT 40`,
      [c.video_id, parseFloat(c.start_s), parseFloat(c.end_s)],
    );
    if (words.length)
      quotes.set(c.id, words.map((w) => w.word).join(" ") + (words.length === 40 ? "…" : ""));
  }

  const corpus = await q<{ n: string }>(
    "SELECT count(DISTINCT meta_video_id)::text AS n FROM ad_performance",
  );
  const corpusN = parseInt(corpus[0]?.n ?? "0", 10);

  return (
    <>
      <Topbar
        title="Suggested cuts"
        sub="Segments worth a look, with the evidence behind each"
      />
      <section className="screen">
        <div className="stack">
          {candidates.length > 0 && (
            <div className="note">
              <strong>These are prompts, not verdicts.</strong>{" "}
              {corpusN > 0 ? (
                <>Scored against {corpusN} Klira creatives with performance
                data — enough to spot patterns, not enough to prove causation.
                Sample size is shown on every card.</>
              ) : (
                <>Ranked on content features only — hook structure, complete
                thoughts, single-speaker openings. No performance data has
                been imported yet, so there is no sample size to show. When
                the ad back catalogue lands, a performance term is added and
                every card gains a real n=.</>
              )}{" "}
              Check the evidence before you trust the ranking.
            </div>
          )}
          {candidates.length === 0 ? (
            <div className="card qempty" style={{ padding: "44px 20px" }}>
              <div style={{ fontWeight: 600, fontSize: 13.5, color: "var(--ink)", marginBottom: 6 }}>
                No suggested cuts yet.
              </div>
              <p style={{ maxWidth: 480, margin: "0 auto", lineHeight: 1.6 }}>
                The scorer hasn&apos;t run{video ? " on this video" : ""}. It
                needs a transcript on the source video; new ingests are scored
                automatically as the last pipeline stage, and older videos have
                a &ldquo;Generate suggested cuts&rdquo; button on their Find
                screen. Scoring is content-based for now
                {corpusN === 0 ? " — the performance import hasn't run yet, so there's no n= to show" : ""}.
                You can always cut clips by selecting a passage in the
                transcript.
              </p>
            </div>
          ) : (
            <CutCards
              cards={candidates.map((c, i) => {
                const tags = (c.matched_tags ?? {}) as {
                  tags?: string[]; features?: string[]; n?: number;
                  stat?: string; flag?: boolean; evidence?: string;
                };
                return {
                  id: c.id,
                  videoId: c.video_id,
                  videoTitle: c.video_title,
                  rank: i + 1,
                  start: parseFloat(c.start_s),
                  end: parseFloat(c.end_s),
                  score: c.score ? parseFloat(c.score) : null,
                  quote: quotes.get(c.id) ?? null,
                  why: c.rationale,
                  tags: tags.tags ?? tags.features ?? [],
                  n: typeof tags.n === "number" ? tags.n : null,
                  stat: tags.stat ?? null,
                  evidence: typeof tags.evidence === "string" ? tags.evidence : null,
                  flag: !!tags.flag,
                };
              })}
            />
          )}
        </div>
      </section>
    </>
  );
}
