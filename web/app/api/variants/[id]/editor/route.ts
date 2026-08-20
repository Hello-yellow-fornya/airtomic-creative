import { NextResponse } from "next/server";
import { q } from "@/lib/db";
import { UUID_RE } from "@/lib/worker";

export const dynamic = "force-dynamic";

/** Full editor payload for one variant — everything the Builder needs,
 * fetched when a row is selected in the clips table so the editor swaps
 * without a navigation. Includes variant A's overlays as the Compare
 * baseline when this variant isn't A. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!UUID_RE.test(id))
    return NextResponse.json({ error: "bad id" }, { status: 400 });

  const [variant] = await q<{
    id: string; label: string; name: string; status: string;
    render_stale: boolean;
    clip_id: string; clip_in: string; clip_out: string;
    subtitle_preset_id: string | null;
    subtitle_overrides: Record<string, unknown> | null;
    video_id: string | null; video_title: string | null; video_source: string | null;
    video_duration: string | null;
    src_w: number | null; src_h: number | null;
    render_status: string | null; render_error: string | null;
    ratios: string[] | null;
  }>(
    `SELECT cv.id::text, cv.label, cv.name, cv.status::text, cv.render_stale,
            c.id::text AS clip_id,
            c.source_in_s::text AS clip_in, c.source_out_s::text AS clip_out,
            cv.subtitle_preset_id::text, cv.subtitle_overrides,
            v.id::text AS video_id, v.title AS video_title, v.source::text AS video_source,
            v.duration_s::text AS video_duration,
            v.width AS src_w, v.height AS src_h,
            j.status::text AS render_status, j.error AS render_error,
            rr.ratios
     FROM clip_variants cv
     JOIN clips c ON c.id = cv.clip_id
     LEFT JOIN videos v ON v.id = c.video_id
     LEFT JOIN LATERAL (
       SELECT status, error FROM jobs
       WHERE type = 'render' AND payload->>'variant_id' = cv.id::text
       ORDER BY id DESC LIMIT 1
     ) j ON true
     LEFT JOIN LATERAL (
       SELECT array_agg(ratio) AS ratios FROM (
         SELECT DISTINCT ON (payload->>'ratio')
                payload->>'ratio' AS ratio, status
         FROM jobs
         WHERE type = 'render' AND payload->>'variant_id' = cv.id::text
         ORDER BY payload->>'ratio', id DESC
       ) latest WHERE latest.status = 'done'
     ) rr ON true
     WHERE cv.id = $1`,
    [id],
  );
  if (!variant)
    return NextResponse.json({ error: "not found" }, { status: 404 });
  const orphan = variant.video_id === null;

  const clipIn = parseFloat(variant.clip_in);
  const clipOut = parseFloat(variant.clip_out);

  const [scenes, assets, presets, overlays, overlayStyles, words, compare, groupRows] =
    await Promise.all([
      q<{
        id: string; idx: number; layout: string; source_in_s: string | null;
        source_out_s: string | null; duration_s: string | null; lifted: boolean;
        slot_a_asset: string | null; split_ratio: string | null; audio: string;
      }>(
        `SELECT id::text, idx, layout::text, source_in_s::text, source_out_s::text,
                duration_s::text, lifted, slot_a_asset::text, split_ratio::text, audio::text
         FROM variant_scenes WHERE variant_id = $1 ORDER BY idx`,
        [id],
      ),
      q<{ id: string; name: string; kind: string }>(
        "SELECT id::text, name, kind::text FROM assets ORDER BY created_at DESC",
      ),
      q<{
        id: string; name: string; is_default: boolean;
        config: Record<string, unknown>;
      }>(
        "SELECT id::text, name, is_default, config FROM subtitle_presets ORDER BY is_default DESC, created_at",
      ),
      q<{
        id: string; idx: number; text: string; start_s: string; end_s: string;
        position: string; style: string; sv: Record<string, unknown> | null;
      }>(
        `SELECT id::text, idx, text, start_s::text, end_s::text, position, style, sv
         FROM clip_overlays WHERE variant_id = $1 ORDER BY idx`,
        [id],
      ),
      q<{ key: string; name: string; config: Record<string, unknown> }>(
        "SELECT key, name, config FROM overlay_style_presets ORDER BY created_at",
      ),
      q<{ word: string; start_s: string; end_s: string }>(
        orphan
          ? "SELECT NULL::text AS word, NULL::text AS start_s, NULL::text AS end_s WHERE false"
          : `SELECT w.word, w.start_s::text, w.end_s::text
             FROM transcript_words w JOIN transcripts t ON t.id = w.transcript_id
             WHERE t.video_id = $1 AND w.start_s IS NOT NULL AND w.end_s IS NOT NULL
               AND w.end_s > $2 AND w.start_s < $3
             ORDER BY w.idx`,
        orphan ? [] : [variant.video_id, clipIn - 15, clipOut + 15],
      ),
      // Compare baseline: the group's A variant (first label), if not us.
      // Orphaned clips have no source to preview — excluded from Compare.
      q<{
        id: string; label: string; name: string;
        ov_text: string | null; ov_start: string | null; ov_end: string | null;
        ov_position: string | null; ov_style: string | null;
        ov_sv: Record<string, unknown> | null;
      }>(
        orphan
          ? "SELECT NULL::text AS id, NULL AS label, NULL AS name, NULL AS ov_text, NULL AS ov_start, NULL AS ov_end, NULL AS ov_position, NULL AS ov_style, NULL AS ov_sv WHERE false"
          : `SELECT a.id::text, a.label, a.name,
                o.text AS ov_text, o.start_s::text AS ov_start,
                o.end_s::text AS ov_end, o.position AS ov_position,
                o.style AS ov_style, o.sv AS ov_sv
         FROM (SELECT id, label, name FROM clip_variants
               WHERE clip_id = $1 ORDER BY label LIMIT 1) a
         LEFT JOIN clip_overlays o ON o.variant_id = a.id
         WHERE a.id <> $2::uuid
         ORDER BY o.idx`,
        orphan ? [] : [variant.clip_id, id],
      ),
      // The row strip: every variant of this clip with its scene cards.
      q<{
        id: string; label: string; name: string; status: string;
        render_stale: boolean;
        sub_preset: string | null;
        sub_overrides: Record<string, unknown> | null;
        g_render_status: string | null; g_render_error: string | null;
        sc_id: string | null; sc_idx: number | null; sc_layout: string | null;
        sc_in: string | null; sc_out: string | null; sc_dur: string | null;
        sc_asset: string | null; sc_split: string | null;
        sc_lifted: boolean | null; sc_audio: string | null;
      }>(
        `SELECT g.id::text, g.label, g.name, g.status::text, g.render_stale,
                g.subtitle_preset_id::text AS sub_preset,
                g.subtitle_overrides AS sub_overrides,
                gj.status::text AS g_render_status, gj.error AS g_render_error,
                vs.id::text AS sc_id, vs.idx AS sc_idx, vs.layout::text AS sc_layout,
                vs.source_in_s::text AS sc_in, vs.source_out_s::text AS sc_out,
                vs.duration_s::text AS sc_dur, vs.slot_a_asset::text AS sc_asset,
                vs.split_ratio::text AS sc_split, vs.lifted AS sc_lifted,
                vs.audio::text AS sc_audio
         FROM clip_variants g
         LEFT JOIN LATERAL (
           SELECT status, error FROM jobs
           WHERE type = 'render' AND payload->>'variant_id' = g.id::text
           ORDER BY id DESC LIMIT 1
         ) gj ON true
         LEFT JOIN variant_scenes vs ON vs.variant_id = g.id
         WHERE g.clip_id = $1
         ORDER BY g.label, vs.idx`,
        [variant.clip_id],
      ),
    ]);

  const scn = await q<{
    scene_id: string; ratio: string; crop_x: string; crop_y: string;
    crop_w: string; crop_h: string;
  }>(
    scenes.length
      ? `SELECT scene_id::text, ratio::text, crop_x::text, crop_y::text,
                crop_w::text, crop_h::text
         FROM scene_crops WHERE scene_id = ANY($1::uuid[])`
      : "SELECT NULL::text AS scene_id, NULL, NULL, NULL, NULL, NULL WHERE false",
    scenes.length ? [scenes.map((s) => s.id)] : [],
  );

  const [groupOverlays, groupCrops] = await Promise.all([
    q<{
      vid: string; id: string; text: string; start_s: string; end_s: string;
      position: string; style: string; sv: Record<string, unknown> | null;
    }>(
      `SELECT o.variant_id::text AS vid, o.id::text, o.text,
              o.start_s::text, o.end_s::text, o.position, o.style, o.sv
       FROM clip_overlays o
       WHERE o.variant_id IN (SELECT id FROM clip_variants WHERE clip_id = $1)
       ORDER BY o.variant_id, o.idx`,
      [variant.clip_id],
    ),
    q<{
      vid: string; scene_id: string; ratio: string; crop_x: string;
      crop_y: string; crop_w: string; crop_h: string;
    }>(
      `SELECT vs.variant_id::text AS vid, sc.scene_id::text, sc.ratio::text,
              sc.crop_x::text, sc.crop_y::text, sc.crop_w::text, sc.crop_h::text
       FROM scene_crops sc
       JOIN variant_scenes vs ON vs.id = sc.scene_id
       WHERE vs.variant_id IN (SELECT id FROM clip_variants WHERE clip_id = $1)`,
      [variant.clip_id],
    ),
  ]);

  const groupRatios = await q<{ vid: string; ratio: string; status: string }>(
    `SELECT DISTINCT ON (payload->>'variant_id', payload->>'ratio')
            payload->>'variant_id' AS vid, payload->>'ratio' AS ratio, status
     FROM jobs WHERE type = 'render'
       AND payload->>'variant_id' IN
           (SELECT id::text FROM clip_variants WHERE clip_id = $1)
     ORDER BY payload->>'variant_id', payload->>'ratio', id DESC`,
    [variant.clip_id],
  );

  const group: {
    id: string; label: string; name: string; status: string;
    renderStale: boolean; ratios: string[];
    presetId: string | null; overrides: Record<string, unknown>;
    renderStatus: string | null; renderError: string | null;
    overlays: { id: string; text: string; start: number; end: number; position: string; style: string; sv: Record<string, unknown> | null }[];
    crops: { sceneId: string; ratio: string; x: number; y: number; w: number; h: number }[];
    scenes: {
      id: string; idx: number; layout: string; in: number | null;
      out: number | null; dur: number | null; asset: string | null;
      splitRatio: number; lifted: boolean; audio: string;
    }[];
  }[] = [];
  for (const r of groupRows) {
    let g = group.find((x) => x.id === r.id);
    if (!g) {
      g = { id: r.id, label: r.label, name: r.name, status: r.status,
            renderStale: r.render_stale, scenes: [],
            presetId: r.sub_preset, overrides: r.sub_overrides ?? {},
            renderStatus: r.g_render_status, renderError: r.g_render_error,
            overlays: groupOverlays
              .filter((o) => o.vid === r.id)
              .map((o) => ({
                id: o.id, text: o.text,
                start: parseFloat(o.start_s), end: parseFloat(o.end_s),
                position: o.position, style: o.style, sv: o.sv,
              })),
            crops: groupCrops
              .filter((c) => c.vid === r.id)
              .map((c) => ({
                sceneId: c.scene_id, ratio: c.ratio,
                x: parseFloat(c.crop_x), y: parseFloat(c.crop_y),
                w: parseFloat(c.crop_w), h: parseFloat(c.crop_h),
              })),
            ratios: groupRatios
              .filter((x) => x.vid === r.id && x.status === "done")
              .map((x) => x.ratio) };
      group.push(g);
    }
    if (r.sc_id) {
      g.scenes.push({
        id: r.sc_id, idx: r.sc_idx ?? 0, layout: r.sc_layout ?? "full",
        in: r.sc_in ? parseFloat(r.sc_in) : null,
        out: r.sc_out ? parseFloat(r.sc_out) : null,
        dur: r.sc_dur ? parseFloat(r.sc_dur) : null,
        asset: r.sc_asset,
        splitRatio: r.sc_split ? parseFloat(r.sc_split) : 0.5,
        lifted: r.sc_lifted ?? true,
        audio: r.sc_audio ?? "source",
      });
    }
  }

  return NextResponse.json({
    variant: {
      id: variant.id,
      label: variant.label,
      name: variant.name,
      status: variant.status,
      clipId: variant.clip_id,
      clipIn,
      clipOut,
      presetId: variant.subtitle_preset_id,
      overrides: variant.subtitle_overrides ?? {},
      videoId: variant.video_id,
      videoTitle: variant.video_title,
      videoSource: variant.video_source ?? "ad_creative",
      videoDuration: parseFloat(variant.video_duration ?? "0") || 0,
      srcW: variant.src_w ?? 16,
      srcH: variant.src_h ?? 9,
      orphan,
      renderStatus: variant.render_status,
      renderError: variant.render_error,
      ratios: variant.ratios ?? [],
    },
    group,
    orphan,
    scenes: scenes.map((s) => ({
      id: s.id, idx: s.idx, layout: s.layout,
      in: s.source_in_s ? parseFloat(s.source_in_s) : null,
      out: s.source_out_s ? parseFloat(s.source_out_s) : null,
      dur: s.duration_s ? parseFloat(s.duration_s) : null,
      lifted: s.lifted,
      asset: s.slot_a_asset,
      splitRatio: s.split_ratio ? parseFloat(s.split_ratio) : 0.5,
      audio: s.audio,
    })),
    crops: scn.map((c) => ({
      sceneId: c.scene_id, ratio: c.ratio,
      x: parseFloat(c.crop_x), y: parseFloat(c.crop_y),
      w: parseFloat(c.crop_w), h: parseFloat(c.crop_h),
    })),
    assets,
    presets,
    overlays: overlays.map((o) => ({
      id: o.id, text: o.text,
      start: parseFloat(o.start_s), end: parseFloat(o.end_s),
      position: o.position, style: o.style, sv: o.sv,
    })),
    overlayStyles,
    renderStale: variant.render_stale,
    words: words.map((w) => ({
      w: w.word, s: parseFloat(w.start_s), e: parseFloat(w.end_s),
    })),
    compare: compare.length
      ? {
          id: compare[0].id,
          label: compare[0].label,
          name: compare[0].name,
          overlays: compare
            .filter((r) => r.ov_text !== null)
            .map((r) => ({
              id: `cmp-${r.ov_start}`,
              text: r.ov_text!,
              start: parseFloat(r.ov_start!),
              end: parseFloat(r.ov_end!),
              position: r.ov_position!,
              style: r.ov_style!,
              sv: r.ov_sv,
            })),
        }
      : null,
  });
}
