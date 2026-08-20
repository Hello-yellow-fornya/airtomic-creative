import Link from "next/link";
import { notFound } from "next/navigation";
import { q } from "@/lib/db";
import { Topbar } from "../../../ui";
import Preview from "./Preview";

export const dynamic = "force-dynamic";

export default async function PreviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [variant] = await q<{
    id: string; label: string; name: string; status: string; clip_id: string;
    clip_in: string; clip_out: string;
    subtitle_preset_id: string | null; subtitle_overrides: Record<string, unknown> | null;
    video_id: string; video_title: string | null;
    src_w: number | null; src_h: number | null;
  }>(
    `SELECT cv.id::text, cv.label, cv.name, cv.status::text,
            c.id::text AS clip_id,
            c.source_in_s::text AS clip_in, c.source_out_s::text AS clip_out,
            c.subtitle_preset_id::text, c.subtitle_overrides,
            v.id::text AS video_id, v.title AS video_title,
            v.width AS src_w, v.height AS src_h
     FROM clip_variants cv
     JOIN clips c ON c.id = cv.clip_id
     JOIN videos v ON v.id = c.video_id
     WHERE cv.id = $1`,
    [id],
  );
  if (!variant) notFound();

  const siblings = await q<{ id: string; label: string; name: string; n_scenes: string }>(
    `SELECT cv.id::text, cv.label, cv.name,
            (SELECT count(*) FROM variant_scenes vs WHERE vs.variant_id = cv.id)::text AS n_scenes
     FROM clip_variants cv WHERE cv.clip_id = $1 ORDER BY cv.label`,
    [variant.clip_id],
  );
  const scenes = await q<{
    id: string; idx: number; layout: string; source_in_s: string | null;
    source_out_s: string | null; duration_s: string | null;
    slot_a_asset: string | null; split_ratio: string | null;
  }>(
    `SELECT id::text, idx, layout::text, source_in_s::text, source_out_s::text,
            duration_s::text, slot_a_asset::text, split_ratio::text
     FROM variant_scenes WHERE variant_id = $1 ORDER BY idx`,
    [id],
  );
  const crops = await q<{ scene_id: string; ratio: string }>(
    scenes.length
      ? `SELECT scene_id::text, ratio::text FROM scene_crops WHERE scene_id = ANY($1::uuid[])`
      : "SELECT NULL::text AS scene_id, NULL WHERE false",
    scenes.length ? [scenes.map((s) => s.id)] : [],
  );

  const clipIn = parseFloat(variant.clip_in);
  const clipOut = parseFloat(variant.clip_out);
  const words = await q<{ word: string; start_s: string; end_s: string }>(
    `SELECT w.word, w.start_s::text, w.end_s::text
     FROM transcript_words w JOIN transcripts t ON t.id = w.transcript_id
     WHERE t.video_id = $1 AND w.start_s IS NOT NULL AND w.end_s IS NOT NULL
       AND w.end_s > $2 AND w.start_s < $3
     ORDER BY w.idx`,
    [variant.video_id, clipIn - 5, clipOut + 5],
  );

  // Style: preset merged with clip overrides (same merge as the renderer).
  const [preset] = await q<{ config: Record<string, unknown> }>(
    variant.subtitle_preset_id
      ? "SELECT config FROM subtitle_presets WHERE id = $1"
      : "SELECT config FROM subtitle_presets WHERE is_default ORDER BY created_at LIMIT 1",
    variant.subtitle_preset_id ? [variant.subtitle_preset_id] : [],
  );
  const overrides = { ...(variant.subtitle_overrides ?? {}) };
  delete (overrides as Record<string, unknown>).fixes;
  const style = { ...(preset?.config ?? {}), ...overrides };
  const fixes = ((variant.subtitle_overrides ?? {}) as { fixes?: Record<string, string> }).fixes ?? {};

  // Compliance flag from the creative tagger (latest tags for the video).
  const [tags] = await q<{ flag: boolean | null; notes: string | null }>(
    `SELECT (brand->>'compliance_flag')::boolean AS flag,
            brand->>'compliance_notes' AS notes
     FROM creative_tags WHERE video_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [variant.video_id],
  );

  // Which ratios have a finished render (export playable via proxy).
  const renders = await q<{ ratio: string; status: string }>(
    `SELECT DISTINCT ON (payload->>'ratio') payload->>'ratio' AS ratio, status::text
     FROM jobs WHERE type = 'render' AND payload->>'variant_id' = $1
     ORDER BY payload->>'ratio', id DESC`,
    [id],
  );

  const workerUp = !!(process.env.WORKER_URL && process.env.INGEST_TOKEN);
  const assets = await q<{ id: string; kind: string }>(
    "SELECT id::text, kind::text FROM assets",
  );

  return (
    <>
      <Topbar
        title={`Preview · ${variant.name}`}
        sub="Watch each variant end to end, then submit for review"
      >
        <Link className="btn ghost sm" href={`/variants/${variant.id}`}>
          Back to builder
        </Link>
      </Topbar>
      <section className="screen">
        <Preview
          variant={{
            id: variant.id, label: variant.label, name: variant.name,
            status: variant.status, videoId: variant.video_id,
            clipIn, clipOut,
            srcAr: (variant.src_w ?? 16) / (variant.src_h ?? 9),
          }}
          siblings={siblings.map((s) => ({
            id: s.id, label: s.label, name: s.name,
            nScenes: parseInt(s.n_scenes, 10),
          }))}
          scenes={scenes.map((s) => ({
            id: s.id, layout: s.layout,
            in: s.source_in_s ? parseFloat(s.source_in_s) : null,
            out: s.source_out_s ? parseFloat(s.source_out_s) : null,
            dur: s.duration_s ? parseFloat(s.duration_s) : null,
            asset: s.slot_a_asset,
            splitRatio: s.split_ratio ? parseFloat(s.split_ratio) : 0.5,
          }))}
          cropsByScene={Object.fromEntries(
            scenes.map((s) => [
              s.id,
              crops.filter((c) => c.scene_id === s.id).map((c) => c.ratio),
            ]),
          )}
          words={words.map((w) => ({
            w: w.word, s: parseFloat(w.start_s), e: parseFloat(w.end_s),
          }))}
          style={{
            fs: Number(style.fs ?? 30), ol: Number(style.ol ?? 3),
            vp: Number(style.vp ?? 72), wpl: Number(style.wpl ?? 4),
            hl: String(style.hl ?? "#FFC629"), caps: !!style.caps, box: !!style.box,
          }}
          fixes={fixes}
          compliance={{ flag: !!tags?.flag, notes: tags?.notes ?? null }}
          renders={Object.fromEntries(renders.map((r) => [r.ratio, r.status]))}
          workerUp={workerUp}
          endCardAssets={assets.filter((a) => a.kind === "end_card").map((a) => a.id)}
        />
      </section>
    </>
  );
}
