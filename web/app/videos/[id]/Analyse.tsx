"use client";

/** 02 Transcript — the prototype's analyse screen on real data.
 * Timeline with scene-boundary, speaker and suggested-cut lanes plus a
 * playhead; word-level transcript below with click-to-seek on rows and
 * click-first/click-last word selection to cut a clip.
 *
 * Yellow in the cuts lane and on marked rows is the machine speaking —
 * suggested segments. The human selection stays neutral ink. */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type SceneT = { id: string; idx: number; start: number; end: number; hasKf: boolean };
type Segment = { id: string; speaker: string | null; start: number; end: number };
type Word = { idx: number; word: string; start: number | null; end: number | null; seg: string | null };
type Candidate = { id: string; rank: number; start: number; end: number; score: number | null };

const SPK_COLOURS = ["#25627F", "#8FA6B4", "#5F7F62", "#A08BA8"];

const fmt = (t: number) => {
  const h = String(Math.floor(t / 3600)).padStart(2, "0");
  const m = String(Math.floor((t % 3600) / 60)).padStart(2, "0");
  const s = String(Math.floor(t % 60)).padStart(2, "0");
  return `${h}:${m}:${s}`;
};
const mmss = (t: number) =>
  `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

export default function Analyse({
  videoId, title, duration, nSpeakers, scenes, segments, words, candidates,
  speakers, kfEnabled,
}: {
  videoId: string; title: string; duration: number; nSpeakers: number;
  scenes: SceneT[]; segments: Segment[]; words: Word[]; candidates: Candidate[];
  speakers: string[]; kfEnabled: boolean;
}) {
  const router = useRouter();
  const [playhead, setPlayhead] = useState(candidates[0]?.start ?? 0);
  const [activeCut, setActiveCut] = useState<string | null>(null);

  // selection for clip creation
  const [selStart, setSelStart] = useState<number | null>(null);
  const [selEnd, setSelEnd] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pct = (t: number) => (t / duration) * 100;

  const bySegment = useMemo(() => {
    const map = new Map<string | null, Word[]>();
    for (const w of words) {
      const list = map.get(w.seg) ?? [];
      list.push(w);
      map.set(w.seg, list);
    }
    return map;
  }, [words]);

  const spkColour = (spk: string | null) =>
    spk ? SPK_COLOURS[speakers.indexOf(spk) % SPK_COLOURS.length] : "#B9BABF";

  const [lo, hi] =
    selStart === null ? [null, null]
    : selEnd === null ? [selStart, selStart]
    : [Math.min(selStart, selEnd), Math.max(selStart, selEnd)];

  function clickWord(idx: number) {
    setError(null);
    if (selStart === null || selEnd !== null) {
      setSelStart(idx);
      setSelEnd(null);
    } else {
      setSelEnd(idx);
    }
  }

  const selWords = lo === null ? [] : words.filter((w) => w.idx >= lo! && w.idx <= hi!);
  const timed = selWords.filter((w) => w.start !== null && w.end !== null);
  const startS = timed.length ? Math.min(...timed.map((w) => w.start!)) : null;
  const endS = timed.length ? Math.max(...timed.map((w) => w.end!)) : null;

  async function createClip(from?: { start: number; end: number; candidateId?: string }) {
    const a = from?.start ?? startS;
    const b = from?.end ?? endS;
    if (a === null || b === null || a === undefined || b === undefined) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/clips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          video_id: videoId, start_s: a, end_s: b, name: name || null,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? res.statusText);
      router.push(`/variants/${body.variant_id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  const segInCut = (s: Segment) =>
    candidates.some((c) => s.end > c.start && s.start < c.end);

  return (
    <div className="stack">
      <div className="tl-wrap">
        <div className="tl-head">
          <div>
            <div className="eyebrow">Timeline</div>
            <div style={{ fontWeight: 600, fontSize: 14, marginTop: 2 }}>{title}</div>
          </div>
          <div className="mono" style={{ fontSize: 11.5, color: "var(--muted)" }}>
            {mmss(duration)} · {scenes.length} scenes · {nSpeakers} speaker{nSpeakers === 1 ? "" : "s"}
          </div>
        </div>
        <div className="ruler">
          {[0, 0.2, 0.4, 0.6, 0.8, 1].map((f) => (
            <span key={f}>{mmss(duration * f)}</span>
          ))}
        </div>
        <div className="tl">
          <div className="lane-tag">Scenes</div>
          <div className="lane" style={{ "--h": "16px" } as React.CSSProperties}>
            {scenes.length ? (
              scenes.slice(1).map((s) => (
                <div key={s.id} className="scene" style={{ left: `${pct(s.start)}%` }} />
              ))
            ) : (
              <span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center",
                paddingLeft: 8, fontSize: 9.5, color: "var(--faint)" }}>
                no scenes detected yet
              </span>
            )}
          </div>
          <div className="lane-tag">Speakers</div>
          <div className="lane" style={{ "--h": "22px" } as React.CSSProperties}>
            {segments.map((s) => (
              <div key={s.id} className="spk" style={{
                left: `${pct(s.start)}%`,
                width: `${Math.max(pct(s.end - s.start), 0.15)}%`,
                background: spkColour(s.speaker),
              }} />
            ))}
          </div>
          <div className="lane-tag">Suggested cuts</div>
          <div className="lane" style={{ "--h": "30px", overflow: "visible" } as React.CSSProperties}>
            {candidates.map((c) => (
              <span key={`band-${c.id}`} style={{
                position: "absolute", top: 3, bottom: 3,
                left: `${pct(c.start)}%`, width: `${Math.max(pct(c.end - c.start), 0.4)}%`,
                background: "rgba(255,198,41,.35)",
                borderLeft: "1px solid var(--signal-deep)",
                borderRight: "1px solid var(--signal-deep)",
                borderRadius: 2, pointerEvents: "none",
              }} />
            ))}
            {candidates.map((c) => (
              <button key={c.id} className="rec"
                data-on={activeCut === c.id ? "1" : "0"}
                style={{ left: `${pct((c.start + c.end) / 2)}%` }}
                title={`${fmt(c.start)} → ${fmt(c.end)} · ${(c.end - c.start).toFixed(1)}s`}
                onClick={() => { setActiveCut(c.id); setPlayhead(c.start); }}>
                <span>{c.rank}</span>
              </button>
            ))}
            {!candidates.length && (
              <span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center",
                paddingLeft: 8, fontSize: 9.5, color: "var(--faint)" }}>
                none yet — the recommendation engine hasn&apos;t run on this video
              </span>
            )}
          </div>
          <div className="playhead" style={{ left: `${pct(playhead)}%` }} />
        </div>
        <div style={{ display: "flex", gap: 16, marginTop: 10, fontSize: 11,
          color: "var(--muted)", flexWrap: "wrap" }}>
          {speakers.map((s) => (
            <span key={s}>
              <span style={{ display: "inline-block", width: 9, height: 9,
                background: spkColour(s), borderRadius: 2, verticalAlign: "middle",
                marginRight: 4 }} />
              {s}
            </span>
          ))}
          <span>
            <span style={{ display: "inline-block", width: 9, height: 9,
              background: "var(--signal)", borderRadius: 2, verticalAlign: "middle",
              marginRight: 4 }} />
            Machine-suggested segment
          </span>
        </div>
      </div>

      <div>
        <h2 className="sec">Transcript</h2>
        {segments.length === 0 && (
          <div className="card qempty">
            No transcript yet — this video hasn&apos;t finished processing.
          </div>
        )}
        {segments.length > 0 && (
          <div className="tx">
            {segments.map((seg) => {
              const segWords = bySegment.get(seg.id) ?? [];
              if (!segWords.length) return null;
              const marked = segInCut(seg);
              return (
                <div key={seg.id}
                  className={`tx-line clickable${marked ? " mark" : ""}`}
                  onClick={(e) => {
                    if ((e.target as Element).closest(".w")) return;
                    setPlayhead(seg.start);
                  }}>
                  <span className="tx-t">{fmt(seg.start)}</span>
                  <span className="tx-s">{seg.speaker ?? ""}</span>
                  <div className="tx-x">
                    {segWords.map((w) => {
                      const inSel = lo !== null && w.idx >= lo && w.idx <= hi!;
                      const isEdge = w.idx === selStart || w.idx === selEnd;
                      return (
                        <span key={w.idx}
                          className={`w${inSel ? " insel" : ""}${isEdge ? " edge" : ""}`}
                          onClick={() => clickWord(w.idx)}>
                          {w.word}{" "}
                        </span>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <p style={{ marginTop: 8, fontSize: 11.5, color: "var(--muted)" }}>
          Word-level timing from WhisperX. Click a line to move the playhead.
          Click the first word, then the last word of a passage to cut a clip.
          {candidates.length > 0 && " Highlighted lines fall inside a suggested cut."}
        </p>
      </div>

      {startS !== null && endS !== null && (
        <div className="selbar">
          <span className="t">
            {selWords.length} words · {startS.toFixed(1)}s – {endS.toFixed(1)}s (
            {(endS - startS).toFixed(1)}s)
            {selEnd === null ? " — click the last word of the passage" : ""}
          </span>
          <input
            placeholder="Clip name (optional)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button className="go" onClick={() => void createClip()} disabled={busy || selEnd === null}>
            {busy ? "Creating…" : "Create clip"}
          </button>
          {error && <span className="err">{error}</span>}
        </div>
      )}
    </div>
  );
}
