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
    video_id: string; video_title: string | null; video_duration: string | null;
    src_w: number | null; src_h: number | null;
  }>(
    `SELECT cv.id::text, cv.label, cv.name, cv.status::text, cv.render_stale,
            c.id::text AS clip_id,
            c.source_in_s::text AS clip_in, c.source_out_s::text AS clip_out,
            cv.subtitle_preset_id::text, cv.subtitle_overrides,
            v.id::text AS video_id, v.title AS video_title,
            v.duration_s::text AS video_duration,
            v.width AS src_w, v.height AS src_h
     FROM clip_variants cv
     JOIN clips c ON c.id = cv.clip_id
     JOIN videos v ON v.id = c.video_id
     WHERE cv.id = $1`,
    [id],
  );
  if (!variant)
    return NextResponse.json({ error: "not found" }, { status: 404 });

  const clipIn = parseFloat(variant.clip_in);
  const clipOut = parseFloat(variant.clip_out);

  const [scenes, assets, presets, overlays, overlayStyles, words, compare] =
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
        position: string; style: string;
      }>(
        `SELECT id::text, idx, text, start_s::text, end_s::text, position, style
         FROM clip_overlays WHERE variant_id = $1 ORDER BY idx`,
        [id],
      ),
      q<{ key: string; name: string; config: Record<string, unknown> }>(
        "SELECT key, name, config FROM overlay_style_presets ORDER BY created_at",
      ),
      q<{ word: string; start_s: string; end_s: string }>(
        `SELECT w.word, w.start_s::text, w.end_s::text
         FROM transcript_words w JOIN transcripts t ON t.id = w.transcript_id
         WHERE t.video_id = $1 AND w.start_s IS NOT NULL AND w.end_s IS NOT NULL
           AND w.end_s > $2 AND w.start_s < $3
         ORDER BY w.idx`,
        [variant.video_id, clipIn - 15, clipOut + 15],
      ),
      // Compare baseline: the group's A variant (first label), if not us.
      q<{
        id: string; label: string; name: string;
        ov_text: string | null; ov_start: string | null; ov_end: string | null;
        ov_position: string | null; ov_style: string | null;
      }>(
        `SELECT a.id::text, a.label, a.name,
                o.text AS ov_text, o.start_s::text AS ov_start,
                o.end_s::text AS ov_end, o.position AS ov_position,
                o.style AS ov_style
         FROM (SELECT id, label, name FROM clip_variants
               WHERE clip_id = $1 ORDER BY label LIMIT 1) a
         LEFT JOIN clip_overlays o ON o.variant_id = a.id
         WHERE a.id <> $2::uuid
         ORDER BY o.idx`,
        [variant.clip_id, id],
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
      videoDuration: parseFloat(variant.video_duration ?? "0") || 0,
      srcW: variant.src_w ?? 16,
      srcH: variant.src_h ?? 9,
    },
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
      position: o.position, style: o.style,
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
            })),
        }
      : null,
  });
}
