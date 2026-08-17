"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type Word = { idx: number; word: string; start: number | null; end: number | null; seg: string | null };
type Segment = { id: string; speaker: string | null; start: number | null };

function fmtTs(s: number | null) {
  if (s === null) return "";
  const secs = Math.floor(s);
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
}

export default function Transcript({
  videoId,
  segments,
  words,
}: {
  videoId: string;
  segments: Segment[];
  words: Word[];
}) {
  const router = useRouter();
  const [selStart, setSelStart] = useState<number | null>(null);
  const [selEnd, setSelEnd] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const bySegment = useMemo(() => {
    const map = new Map<string | null, Word[]>();
    for (const w of words) {
      const list = map.get(w.seg) ?? [];
      list.push(w);
      map.set(w.seg, list);
    }
    return map;
  }, [words]);

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

  async function createClip() {
    if (startS === null || endS === null) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/clips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          video_id: videoId,
          start_s: startS,
          end_s: endS,
          name: name || null,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
      router.push("/clips");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <>
      <div className="tx">
        {segments.map((seg) => {
          const segWords = bySegment.get(seg.id) ?? [];
          if (!segWords.length) return null;
          return (
            <div className="tx-line" key={seg.id}>
              <span className="tx-t">{fmtTs(seg.start)}</span>
              <span className="tx-s">{seg.speaker ?? ""}</span>
              <div className="tx-x">
                {segWords.map((w) => {
                  const inSel = lo !== null && w.idx >= lo && w.idx <= hi!;
                  const isEdge = w.idx === selStart || w.idx === selEnd;
                  return (
                    <span
                      key={w.idx}
                      className={`w${inSel ? " insel" : ""}${isEdge ? " edge" : ""}`}
                      onClick={() => clickWord(w.idx)}
                    >
                      {w.word}{" "}
                    </span>
                  );
                })}
              </div>
            </div>
          );
        })}
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
          <button className="go" onClick={createClip} disabled={busy || selEnd === null}>
            {busy ? "Creating…" : "Create clip + render"}
          </button>
          {error && <span className="err">{error}</span>}
        </div>
      )}
    </>
  );
}
