"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Card = {
  id: string; videoId: string; videoTitle: string | null; rank: number;
  start: number; end: number; score: number | null; quote: string | null;
  why: string | null; tags: string[]; n: number | null; stat: string | null;
  evidence: string | null; flag: boolean;
};

const fmt = (t: number) => {
  const h = String(Math.floor(t / 3600)).padStart(2, "0");
  const m = String(Math.floor((t % 3600) / 60)).padStart(2, "0");
  const s = String(Math.floor(t % 60)).padStart(2, "0");
  return `${h}:${m}:${s}`;
};

export default function CutCards({ cards }: { cards: Card[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function open(c: Card) {
    setBusy(c.id);
    setError(null);
    try {
      const res = await fetch("/api/clips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          video_id: c.videoId, start_s: c.start, end_s: c.end,
          candidate_id: c.id, name: null,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? res.statusText);
      router.push(`/variants/${body.variant_id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  }

  return (
    <>
      {error && <p className="hint">{error}</p>}
      <div className="recs">
        {cards.map((c) => (
          <div key={c.id} className="card rc">
            <div className="rc-top">
              <div>
                <div className="rc-time">{fmt(c.start)} → {fmt(c.end)}</div>
                <div className="rc-dur">
                  {(c.end - c.start).toFixed(1)}s · rank {c.rank}
                  {c.videoTitle ? ` · ${c.videoTitle}` : ""}
                </div>
              </div>
              <span className={`tag ${c.flag ? "flag" : "hot"}`}>
                {c.flag ? "compliance" : c.score !== null ? `score ${c.score.toFixed(2)}` : "unscored"}
              </span>
            </div>
            {c.quote && <div className="rc-q">&ldquo;{c.quote}&rdquo;</div>}
            {c.why && <div className="rc-why">{c.why}</div>}
            {c.tags.length > 0 && (
              <div className="rc-tags">
                {c.tags.map((t) => (
                  <span key={t}
                    className={`tag${t.startsWith("claim") || t === "compliance" ? " flag" : ""}`}>
                    {t}
                  </span>
                ))}
              </div>
            )}
            <div className="rc-foot">
              <span className="evidence">
                {c.n !== null
                  ? `n=${c.n}${c.stat ? ` · ${c.stat}` : ""}${c.n < 3 ? " — weak evidence" : ""}`
                  : c.evidence ?? "n=? · evidence not recorded — treat as unranked"}
              </span>
              <button className="btn sm" disabled={busy !== null} onClick={() => void open(c)}>
                {busy === c.id ? "Opening…" : "Open"}
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
