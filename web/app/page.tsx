import Link from "next/link";
import { q } from "@/lib/db";
import { Topbar } from "./ui";
import UploadArea from "./UploadArea";

export const dynamic = "force-dynamic";

type VideoRow = {
  id: string;
  title: string | null;
  source: string;
  status: string;
  status_detail: string | null;
  duration_s: string | null;
  ingested_at: string;
  n_words: string;
  n_scenes: string;
  n_cuts: string;
  n_speakers: string;
  kf_scene: string | null;
};

function fmtDur(s: string | null) {
  if (!s) return "—";
  const secs = Math.round(parseFloat(s));
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
}

export default async function LibraryPage() {
  const videos = await q<VideoRow>(`
    SELECT v.id, v.title, v.source::text, v.status::text, v.status_detail,
           v.duration_s::text, v.ingested_at::text,
           (SELECT count(*) FROM transcript_words w
            JOIN transcripts t ON t.id = w.transcript_id
            WHERE t.video_id = v.id)::text AS n_words,
           (SELECT count(*) FROM scenes s WHERE s.video_id = v.id)::text AS n_scenes,
           (SELECT count(*) FROM clip_candidates c
            WHERE c.video_id = v.id AND c.status = 'suggested')::text AS n_cuts,
           (SELECT count(DISTINCT s.speaker) FROM transcript_segments s
            JOIN transcripts t ON t.id = s.transcript_id
            WHERE t.video_id = v.id AND s.speaker IS NOT NULL)::text AS n_speakers,
           (SELECT s.id::text FROM scenes s
            WHERE s.video_id = v.id AND s.keyframe_uri IS NOT NULL
            ORDER BY s.idx LIMIT 1) AS kf_scene
    FROM videos v ORDER BY v.ingested_at DESC LIMIT 100`);

  const perf = await q<{
    id: string; title: string | null; meta_video_id: string;
    ad_count: string; spend: string; thumbstop: string | null;
    hold: string | null; roas: string | null;
  }>(`
    SELECT v.id::text, v.title, vp.meta_video_id, vp.ad_count::text,
           vp.spend::text, vp.thumbstop_rate::text AS thumbstop,
           vp.hold_rate::text AS hold, vp.roas::text AS roas
    FROM video_performance vp
    JOIN videos v ON v.meta_video_id = vp.meta_video_id
    ORDER BY vp.spend DESC NULLS LAST LIMIT 50`);

  const corpus = await q<{ total: string; with_spend: string }>(`
    SELECT count(DISTINCT meta_video_id)::text AS total,
           count(DISTINCT meta_video_id) FILTER (WHERE spend > 0)::text AS with_spend
    FROM ad_performance`);

  const longform = videos.filter((v) => v.source === "longform");
  const adCreative = videos.filter((v) => v.source !== "longform");
  const kfEnabled = !!(process.env.WORKER_URL && process.env.INGEST_TOKEN);
  const maxThumb = Math.max(
    0.001, ...perf.map((p) => parseFloat(p.thumbstop ?? "0") || 0),
  );

  const card = (v: VideoRow) => (
    <Link key={v.id} href={`/videos/${v.id}`} className="card asset">
      <div className="thumb" style={
        kfEnabled && v.kf_scene
          ? {
              backgroundImage: `url(/api/keyframes/${v.kf_scene})`,
              backgroundSize: "cover", backgroundPosition: "center",
            }
          : undefined
      }>
        {!(kfEnabled && v.kf_scene) && (<><div className="head" /><div className="head b" /></>)}
        {parseInt(v.n_cuts, 10) > 0 && (
          <span className="badge">{v.n_cuts} cuts found</span>
        )}
        <span className="dur mono">{fmtDur(v.duration_s)}</span>
      </div>
      <div className="asset-meta">
        <h3>{v.title ?? "untitled"}</h3>
        <div className="m">
          {v.source === "longform" ? "Long-form" : "Ad creative"}
          {parseInt(v.n_speakers, 10) > 0 &&
            ` · ${v.n_speakers} speaker${v.n_speakers === "1" ? "" : "s"}`}
          {v.status === "ready"
            ? ` · ${v.n_words} words · ${v.n_scenes} scenes`
            : ` · ${v.status_detail || v.status}`}
        </div>
      </div>
    </Link>
  );

  return (
    <>
      <Topbar
        title="Library"
        sub="Long-form source material and the ad back catalogue"
      />
      <section className="screen">
        <UploadArea workerUp={kfEnabled} />

        <h2 className="sec">Long-form source</h2>
        {longform.length === 0 ? (
          <div className="card qempty" style={{ marginBottom: 26 }}>
            Nothing ingested yet — drop a podcast above.
          </div>
        ) : (
          <div className="grid-assets" style={{ marginBottom: 26 }}>
            {longform.map(card)}
          </div>
        )}

        {adCreative.length > 0 && (
          <>
            <h2 className="sec">Ad creative</h2>
            <div className="grid-assets" style={{ marginBottom: 26 }}>
              {adCreative.map(card)}
            </div>
          </>
        )}

        <h2 className="sec">Ad back catalogue</h2>
        {perf.length === 0 ? (
          <div className="card qempty">
            No ad performance yet. The Airtomic import isn&apos;t wired — once
            it lands, spend, thumbstop, hold and ROAS appear here, computed at
            video level from raw counts.
          </div>
        ) : (
          <>
            <div className="card" style={{ overflow: "hidden" }}>
              <table className="ads">
                <thead>
                  <tr>
                    <th>Creative</th>
                    <th style={{ textAlign: "right" }}>Ads</th>
                    <th style={{ textAlign: "right" }}>Spend</th>
                    <th style={{ textAlign: "right" }}>Thumbstop</th>
                    <th style={{ textAlign: "right" }}>Hold</th>
                    <th style={{ textAlign: "right" }}>ROAS</th>
                  </tr>
                </thead>
                <tbody>
                  {perf.map((p) => {
                    const th = parseFloat(p.thumbstop ?? "0") || 0;
                    return (
                      <tr key={p.meta_video_id}>
                        <td>
                          <strong>{p.title ?? p.meta_video_id}</strong>
                        </td>
                        <td className="num">{p.ad_count}</td>
                        <td className="num">£{Math.round(parseFloat(p.spend)).toLocaleString()}</td>
                        <td className="num">
                          {(th * 100).toFixed(1)}%
                          <div className="bar"><i style={{ width: `${(th / maxThumb) * 100}%` }} /></div>
                        </td>
                        <td className="num">
                          {p.hold ? `${(parseFloat(p.hold) * 100).toFixed(1)}%` : "—"}
                        </td>
                        <td className="num">
                          {p.roas ? parseFloat(p.roas).toFixed(2) : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p style={{ marginTop: 10, fontSize: 11.5, color: "var(--muted)" }}>
              Rates computed at video level from raw counts. {corpus[0]?.total ?? 0}{" "}
              creatives ingested · {corpus[0]?.with_spend ?? 0} with spend.
            </p>
          </>
        )}
      </section>
    </>
  );
}
