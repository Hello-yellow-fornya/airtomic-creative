"use client";

import { useState } from "react";

type V = {
  id: string; label: string; name: string; slug: string; status: string;
  clipName: string | null; videoTitle: string | null; videoSource: string;
  nScenes: number; duration: number | null; hasCard: boolean; hasSplit: boolean;
  pushStatus: string | null; pushError: string | null;
};

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 18);

export default function Send({
  variants, fromQueue, metaConfigured,
}: {
  variants: V[]; fromQueue: boolean; metaConfigured: boolean;
}) {
  const [mode, setMode] = useState<"ads" | "lib">("ads");
  const [lp, setLp] = useState("https://klira.skin/consultation");
  const [utmOn, setUtmOn] = useState(true);
  const [utmSrc, setUtmSrc] = useState("meta");
  const [utmMed, setUtmMed] = useState("paid_social");
  const [utmCamp, setUtmCamp] = useState("klira_podcast_clips");
  const [libTag, setLibTag] = useState("KLR_POD");
  const lib = mode === "lib";

  // Ad naming per convention: KLR_{SOURCE}_{topic}_c{NN}_{LABEL}_{slug}.
  // Topic and cut number come from the clip name until the recommendation
  // engine supplies them.
  const adName = (v: V) => {
    const src = v.videoSource === "longform" ? "POD" : "AD";
    const topic = slugify(v.clipName ?? "clip").replace(/-/g, "_") || "clip";
    return lib
      ? `${libTag}_${v.label}_${v.slug}`
      : `KLR_${src}_${topic}_${v.label}_${v.slug}`;
  };

  const utmFor = (v: V) => {
    const base = lp.trim();
    if (!utmOn) return base;
    const q = new URLSearchParams({
      utm_source: utmSrc.trim(),
      utm_medium: utmMed.trim(),
      utm_campaign: utmCamp.trim(),
      // utm_content mirrors the variant so GA4 can attribute by hook
      utm_content: `${v.label.toLowerCase()}_${slugify(v.name)}`,
    });
    return base + (base.includes("?") ? "&" : "?") + q.toString();
  };

  const BADGE = (v: V) => {
    if (v.pushStatus === "failed") return <span className="status fail">FAILED</span>;
    if (v.pushStatus === "rejected") return <span className="status rej">REJECTED</span>;
    if (v.pushStatus === "created" || v.status === "sent")
      return <span className="status paused">PAUSED</span>;
    return <span className="tag">ready</span>;
  };

  return (
    <div className="push">
      <div className="card pad">
        <div className="eyebrow" style={{ marginBottom: 11 }}>Creatives</div>
        {variants.length === 0 ? (
          <div className="qempty" style={{ background: "none" }}>
            Nothing approved to send. Approve variants in the review queue first.
          </div>
        ) : (
          <>
            <div className="batch">
              <span className="cnt">
                {variants.length} creative{variants.length > 1 ? "s" : ""}{" "}
                <em>· {fromQueue ? "from the review queue" : "all approved"}</em>
              </span>
            </div>
            {variants.map((v) => (
              <div key={v.id} className="pushrow"
                data-s={v.pushStatus === "failed" ? "failed"
                  : v.pushStatus === "rejected" ? "rejected" : "queued"}>
                <span className="th">
                  {v.hasSplit ? <b /> : null}
                  {v.hasCard ? <u style={{ display: "block" }} /> : null}
                </span>
                <span className="meta">
                  <div className="nm">{adName(v)}</div>
                  <div className="sp">
                    {v.name} · {v.duration !== null ? `${v.duration.toFixed(1)}s` : "—"} ·{" "}
                    {v.nScenes} scene{v.nScenes > 1 ? "s" : ""}
                  </div>
                  {!lib && (
                    <div className="sp mono" style={{
                      fontSize: 9.5, color: "var(--faint)", marginTop: 3,
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    }}>
                      {utmFor(v)}
                    </div>
                  )}
                  {v.pushError && <div className="why">{v.pushError}</div>}
                </span>
                <span className="st">{BADGE(v)}</span>
              </div>
            ))}
            <div style={{ marginTop: 12 }}>
              <button className="btn" style={{ width: "100%" }} disabled
                title="Meta push isn't wired yet">
                {lib ? "Upload" : "Create"} {variants.length}{" "}
                {lib ? "to media library" : `paused ad${variants.length > 1 ? "s" : ""}`}
              </button>
              <p style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 6 }}>
                Disabled — the Meta Marketing API connection isn&apos;t configured
                yet. Everything above (names, URLs) is what will be sent when it is.
              </p>
            </div>
          </>
        )}
        <div className="note" style={{ marginTop: 12 }}>
          One ad per variant, all into the same ad set. Not dynamic creative —
          mixing videos inside one ad breaks the video-to-ad join and corrupts
          the learning loop.
        </div>
      </div>

      <div className="stack">
        <div className="card pad">
          <div className="eyebrow" style={{ marginBottom: 9 }}>Send as</div>
          <div className="seg" style={{ width: "100%" }}>
            <button data-on={!lib ? "1" : undefined} style={{ flex: 1 }}
              onClick={() => setMode("ads")}>
              Create paused ads
            </button>
            <button data-on={lib ? "1" : undefined} style={{ flex: 1 }}
              onClick={() => setMode("lib")}>
              Media library only
            </button>
          </div>
          <p style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 9 }}>
            {lib
              ? "Uploads the videos only. No ad is created, so there is no review and nothing can be rejected."
              : "Builds a full ad per variant in the chosen ad set, paused. Goes through Meta ad review."}
          </p>
        </div>

        <div className="card pad">
          <div className="eyebrow" style={{ marginBottom: 11 }}>
            {lib ? "Media library" : "Destination"}
          </div>
          {!metaConfigured && (
            <div className="note" style={{ marginBottom: 12 }}>
              <strong>Meta connection not configured.</strong> Campaigns and ad
              sets list here once META_* credentials are wired to the worker.
              Budget, targeting and placements come from the ad set — this tool
              never creates campaigns or ad sets.
            </div>
          )}
          {!lib ? (
            <>
              <div className="ctrl">
                <label htmlFor="acct">Ad account</label>
                <select id="acct" disabled>
                  <option>{metaConfigured ? "" : "— not connected —"}</option>
                </select>
              </div>
              <div className="ctrl">
                <label htmlFor="camp">Campaign</label>
                <select id="camp" disabled><option>— not connected —</option></select>
              </div>
              <div className="ctrl">
                <label htmlFor="adset">Ad set</label>
                <select id="adset" disabled><option>— not connected —</option></select>
              </div>

              <div className="eyebrow" style={{ margin: "14px 0 9px" }}>Landing page</div>
              <div className="ctrl">
                <label htmlFor="lp">Destination URL</label>
                <input type="text" id="lp" value={lp} onChange={(e) => setLp(e.target.value)} />
              </div>
              <label className="toggle">
                <input type="checkbox" checked={utmOn} onChange={(e) => setUtmOn(e.target.checked)} />
                Append UTM parameters
              </label>
              {utmOn && (
                <div>
                  <div className="row" style={{ gap: 8, marginTop: 8 }}>
                    <div className="ctrl" style={{ flex: 1 }}>
                      <label htmlFor="utmSrc">Source</label>
                      <input type="text" id="utmSrc" value={utmSrc}
                        onChange={(e) => setUtmSrc(e.target.value)} />
                    </div>
                    <div className="ctrl" style={{ flex: 1 }}>
                      <label htmlFor="utmMed">Medium</label>
                      <input type="text" id="utmMed" value={utmMed}
                        onChange={(e) => setUtmMed(e.target.value)} />
                    </div>
                  </div>
                  <div className="ctrl">
                    <label htmlFor="utmCamp">Campaign</label>
                    <input type="text" id="utmCamp" value={utmCamp}
                      onChange={(e) => setUtmCamp(e.target.value)} />
                  </div>
                  <div className="note" style={{ marginTop: 4 }}>
                    <strong>utm_content</strong> is set per variant from its
                    name, so post-click performance is readable by hook in GA4 —
                    not just in Ads Manager.
                    <div className="mono" style={{
                      fontSize: 10, marginTop: 6, wordBreak: "break-all", color: "#3D3316",
                    }}>
                      {variants.map((v) => utmFor(v)).join("\n")}
                    </div>
                  </div>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="note">
                Videos are uploaded to the ad account&apos;s media library and
                nothing else is created. No ad, no ad set, no spend, and no ad
                review — so nothing can be rejected at this stage.
              </div>
              <div className="ctrl" style={{ marginTop: 12 }}>
                <label htmlFor="libTag">Name prefix</label>
                <input type="text" id="libTag" value={libTag}
                  onChange={(e) => setLibTag(e.target.value)} />
              </div>
              <p style={{ fontSize: 11, color: "var(--muted)", marginTop: -4 }}>
                Variant suffixes are appended automatically so hooks stay
                identifiable in the library.
              </p>
            </>
          )}
        </div>

        <div className="card pad">
          <div className="eyebrow" style={{ marginBottom: 9 }}>Progress</div>
          <div className="steps">
            <div className="step"><div className="pip" />
              <div><h4>Videos uploaded</h4><p>Waiting — no push has run</p></div></div>
            <div className="step"><div className="pip" />
              <div><h4>Processing finished</h4><p>—</p></div></div>
            {!lib && (
              <div className="step"><div className="pip" />
                <div><h4>Creatives built</h4><p>One AdCreative per variant</p></div></div>
            )}
            <div className="step"><div className="pip" />
              <div>
                <h4>{lib ? "Added to media library" : "Ads created, paused"}</h4>
                <p>
                  {lib
                    ? "Available in Ads Manager. No ad exists yet, so nothing is in review."
                    : "One ad per variant, same ad set. Failures are isolated — successful variants stay created."}
                </p>
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 13, flexWrap: "wrap" }}>
            <span className="status paused">PAUSED</span>
            <span className="status rev">IN REVIEW</span>
          </div>
          {!lib && (
            <div className="note" style={{ marginTop: 12 }}>
              Prescription claims get rejected more often than most categories.
              Rejections and upload failures show per variant above, with the
              reason — you won&apos;t need to go looking in Ads Manager.
            </div>
          )}
        </div>

        <div className="card pad">
          <div className="eyebrow" style={{ marginBottom: 9 }}>Record</div>
          <dl className="kv">
            <dt>Source</dt>
            <dd>{[...new Set(variants.map((v) => v.videoTitle).filter(Boolean))].join(", ") || "—"}</dd>
            <dt>Variants</dt>
            <dd>{variants.map((v) => `${v.label} ${v.name}`).join(" · ") || "—"}</dd>
            <dt>Mode</dt>
            <dd>{lib ? "Media library only" : "Paused ads"}</dd>
          </dl>
        </div>
      </div>
    </div>
  );
}
