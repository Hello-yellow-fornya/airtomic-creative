"use client";

/** Colour picker for the Text style panel: saturation/brightness square +
 * hue strip, a hex field (3 or 6 digits, # optional), an eyedropper that
 * samples the preview frame, and the last 6 used colours (per user, in
 * localStorage) so a brand-adjacent custom colour doesn't need
 * re-entering. Values are #RRGGBB; opacity stays a separate control. */

import { useEffect, useRef, useState } from "react";

export const normalizeHex = (raw: string): string | null => {
  let h = raw.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(h)) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return `#${h.toUpperCase()}`;
};

function hexToHsv(hex: string): { h: number; s: number; v: number } {
  const n = normalizeHex(hex) ?? "#FFFFFF";
  const r = parseInt(n.slice(1, 3), 16) / 255;
  const g = parseInt(n.slice(3, 5), 16) / 255;
  const b = parseInt(n.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

function hsvToHex(h: number, s: number, v: number): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    const c = v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, "0");
  };
  return `#${f(5)}${f(3)}${f(1)}`.toUpperCase();
}

const RECENT_KEY = "recentColors";
export const getRecent = (): string[] => {
  try {
    const r = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(r) ? r.filter((x) => typeof x === "string") : [];
  } catch { return []; }
};
export const pushRecent = (hex: string) => {
  const n = normalizeHex(hex);
  if (!n) return;
  const r = [n, ...getRecent().filter((c) => c !== n)].slice(0, 6);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(r)); } catch {}
};

export default function ColorPicker({ value, onPick, onEyedrop }: {
  value: string;
  onPick: (hex: string) => void;
  /** parent enters sample mode; calls apply(hex) with the picked pixel */
  onEyedrop?: (apply: (hex: string) => void) => void;
}) {
  const [hsv, setHsv] = useState(() => hexToHsv(value));
  const [hexText, setHexText] = useState(() => normalizeHex(value) ?? value);
  const [bad, setBad] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  const editing = useRef(false);
  useEffect(() => { setRecent(getRecent()); }, []);
  // follow external changes (swatches, other pickers) unless mid-edit
  useEffect(() => {
    if (editing.current) return;
    const n = normalizeHex(value);
    if (n && n !== hsvToHex(hsv.h, hsv.s, hsv.v)) setHsv(hexToHsv(n));
    if (n) { setHexText(n); setBad(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const commit = (hex: string) => {
    onPick(hex);
    pushRecent(hex);
    setRecent(getRecent());
  };

  const sqRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);

  function dragSurface(
    e: React.PointerEvent, ref: React.RefObject<HTMLDivElement | null>,
    move: (fx: number, fy: number) => string,
  ) {
    e.preventDefault();
    const pid = e.pointerId;
    try { (e.currentTarget as Element).setPointerCapture(pid); } catch {}
    editing.current = true;
    let last = value;
    const apply = (ev: { clientX: number; clientY: number }) => {
      const r = ref.current!.getBoundingClientRect();
      const fx = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
      const fy = Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height));
      last = move(fx, fy);
      setHexText(last);
      setBad(false);
      onPick(last);
    };
    apply(e);
    const onMove = (ev: PointerEvent) => { if (ev.pointerId === pid) apply(ev); };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pid) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      editing.current = false;
      pushRecent(last);
      setRecent(getRecent());
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  const cur = hsvToHex(hsv.h, hsv.s, hsv.v);

  return (
    <div className="cpk">
      <div ref={sqRef} className="cpk-sq" role="slider" aria-label="Saturation and brightness"
        style={{ background: `linear-gradient(to top,#000,transparent),linear-gradient(to right,#fff,hsl(${hsv.h},100%,50%))` }}
        onPointerDown={(e) => dragSurface(e, sqRef, (fx, fy) => {
          const next = { ...hsv, s: fx, v: 1 - fy };
          setHsv(next);
          return hsvToHex(next.h, next.s, next.v);
        })}>
        <i className="cpk-dot" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }} />
      </div>
      <div ref={hueRef} className="cpk-hue" role="slider" aria-label="Hue"
        onPointerDown={(e) => dragSurface(e, hueRef, (fx) => {
          const next = { ...hsv, h: fx * 360 };
          setHsv(next);
          return hsvToHex(next.h, next.s, next.v);
        })}>
        <i className="cpk-hue-dot" style={{ left: `${(hsv.h / 360) * 100}%` }} />
      </div>
      <div className="cpk-row">
        <span className="cpk-chip" style={{ background: cur }} />
        <input className={`cpk-hex mono${bad ? " bad" : ""}`} value={hexText}
          spellCheck={false} aria-label="Hex colour"
          onFocus={() => { editing.current = true; }}
          onChange={(e) => { setHexText(e.target.value); setBad(false); }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              const n = normalizeHex(hexText);
              if (!n) { setBad(true); return; }
              setHsv(hexToHsv(n));
              setHexText(n);
              commit(n);
              (e.target as HTMLInputElement).blur();
            }
          }}
          onBlur={() => {
            editing.current = false;
            const n = normalizeHex(hexText);
            if (!n) { setBad(true); return; }
            if (n !== normalizeHex(value)) { setHsv(hexToHsv(n)); commit(n); }
            setHexText(n);
          }} />
        {onEyedrop && (
          <button className="btn ghost sm cpk-eye" title="Sample a colour from the preview frame"
            onClick={() => onEyedrop((hex) => {
              const n = normalizeHex(hex);
              if (!n) return;
              setHsv(hexToHsv(n));
              setHexText(n);
              commit(n);
            })}>
            ⧉ Pick from frame
          </button>
        )}
      </div>
      {recent.length > 0 && (
        <div className="swatches cpk-recent" aria-label="Recently used colours">
          {recent.map((c) => (
            <button key={c} className="sw" style={{ background: c }}
              data-on={normalizeHex(value) === c ? "1" : undefined}
              aria-label={`Recent ${c}`}
              onClick={() => { setHsv(hexToHsv(c)); setHexText(c); commit(c); }} />
          ))}
        </div>
      )}
    </div>
  );
}
