"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type Row = {
  id: string; label: string; name: string; slug: string;
  status: string; rawStatus: string;
  by: string | null; when: string | null;
  clipName: string | null; videoTitle: string | null;
  nScenes: number; duration: number | null; pushStatus: string | null;
};

const TABS = [
  { key: "in_review", label: "In review" },
  { key: "approved", label: "Approved" },
  { key: "sent", label: "Sent" },
] as const;

export default function Queue({ rows }: { rows: Row[] }) {
  const router = useRouter();
  const [tab, setTab] = useState<string>("in_review");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const counts = useMemo(() => ({
    in_review: rows.filter((r) => r.status === "in_review").length,
    approved: rows.filter((r) => r.status === "approved").length,
    sent: rows.filter((r) => r.status === "sent").length,
  }), [rows]);

  const visible = rows.filter((r) => r.status === tab);
  const nSel = visible.filter((r) => sel.has(r.id)).length;
  const allSel = visible.length > 0 && visible.every((r) => sel.has(r.id));

  async function move(to: string) {
    setBusy(true);
    const ids = visible.filter((r) => sel.has(r.id)).map((r) => r.id);
    await fetch("/api/variants/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, to }),
    });
    setBusy(false);
    setSel(new Set());
    if (to === "approved") setTab("approved");
    router.refresh();
  }

  function toggle(id: string) {
    setSel((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  const foot =
    tab === "sent"
      ? "Sent creatives are read-only. Meta review status updates automatically."
      : tab === "approved"
        ? `${counts.approved} approved and waiting to be sent. Select rows to push them in one batch.`
        : `${counts.in_review} waiting on review. Approving does not send anything — approved items move to the next tab.`;

  return (
    <>
      <div className="qtabs">
        {TABS.map((t) => (
          <button key={t.key} className="qtab" data-on={tab === t.key ? "1" : undefined}
            onClick={() => { setTab(t.key); setSel(new Set()); }}>
            {t.label} <span className="n">{counts[t.key as keyof typeof counts]}</span>
          </button>
        ))}
      </div>

      <div className={`bulk${nSel > 0 ? " on" : ""}`}>
        <span className="cnt">{nSel} selected</span>
        <span className="sp" />
        {/* bulk actions scoped per state — send only exists on Approved */}
        {tab === "in_review" && (
          <>
            <button disabled={busy} onClick={() => void move("draft")}>Send back</button>
            <button className="go" disabled={busy} onClick={() => void move("approved")}>Approve</button>
          </>
        )}
        {tab === "approved" && (
          <>
            <button disabled={busy} onClick={() => void move("in_review")}>Move back to review</button>
            <button className="go" disabled={busy}
              onClick={() => {
                const ids = visible.filter((r) => sel.has(r.id)).map((r) => r.id);
                router.push(`/send?ids=${ids.join(",")}`);
              }}>
              Send to Meta
            </button>
          </>
        )}
        {tab === "sent" && (
          <button onClick={() => setSel(new Set())}>Clear selection</button>
        )}
      </div>

      <div className="card" style={{ overflow: "hidden", marginTop: 12 }}>
        {visible.length === 0 ? (
          <div className="qempty">
            Nothing {tab === "in_review" ? "waiting for review"
              : tab === "approved" ? "approved yet" : "sent yet"}.
          </div>
        ) : (
          <table className="q">
            <thead>
              <tr>
                <th className="cb">
                  <input type="checkbox" checked={allSel} aria-label="Select all"
                    onChange={(e) => {
                      setSel((s) => {
                        const n = new Set(s);
                        visible.forEach((r) => e.target.checked ? n.add(r.id) : n.delete(r.id));
                        return n;
                      });
                    }} />
                </th>
                <th></th><th>Creative</th><th>Source</th>
                <th style={{ textAlign: "right" }}>Length</th>
                <th style={{ textAlign: "right" }}>Scenes</th>
                <th>Built by</th>
                {tab === "sent" && <th>Meta</th>}
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.id} className={sel.has(r.id) ? "sel" : ""}
                  onClick={(e) => {
                    if ((e.target as Element).closest("input,a")) return;
                    toggle(r.id);
                  }}>
                  <td className="cb">
                    <input type="checkbox" checked={sel.has(r.id)}
                      aria-label={`Select ${r.name}`}
                      onChange={() => toggle(r.id)} />
                  </td>
                  <td><span className="qth">{r.nScenes > 1 ? <b /> : null}</span></td>
                  <td>
                    <div className="nm">
                      <a href={`/variants/${r.id}`} style={{ textDecoration: "underline" }}
                        onClick={(e) => e.stopPropagation()}>
                        {r.label} · {r.name}
                      </a>
                    </div>
                    <div className="sub">{r.clipName ?? "untitled clip"}{r.when ? ` · ${r.when}` : ""}</div>
                  </td>
                  <td>{r.videoTitle}</td>
                  <td className="num">{r.duration !== null ? `${r.duration.toFixed(1)}s` : "—"}</td>
                  <td className="num">{r.nScenes}</td>
                  <td>{r.by ?? "—"}</td>
                  {tab === "sent" && (
                    <td>
                      {r.rawStatus === "failed" || r.pushStatus === "failed"
                        ? <span className="status fail">FAILED</span>
                        : r.pushStatus === "rejected"
                          ? <span className="status rej">REJECTED</span>
                          : <span className="status paused">PAUSED</span>}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p style={{ marginTop: 10, fontSize: 11.5, color: "var(--muted)" }}>{foot}</p>
    </>
  );
}
