import Link from "next/link";
import { notFound } from "next/navigation";
import { q } from "@/lib/db";
import { Topbar } from "../../ui";
import Builder from "./Builder";

export const dynamic = "force-dynamic";

export default async function VariantPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [variant] = await q<{
    id: string; label: string; name: string; status: string;
    export_uri: string | null; clip_id: string; clip_name: string | null;
    clip_in: string; clip_out: string;
    subtitle_preset_id: string | null; subtitle_overrides: Record<string, unknown> | null;
    video_id: string; video_title: string | null; video_duration: string | null;
    src_w: number | null; src_h: number | null;
  }>(
    `SELECT cv.id::text, cv.label, cv.name, cv.status::text, cv.export_uri,
            c.id::text AS clip_id, c.name AS clip_name,
            c.source_in_s::text AS clip_in, c.source_out_s::text AS clip_out,
            c.subtitle_preset_id::text, c.subtitle_overrides,
            v.id::text AS video_id, v.title AS video_title,
            v.duration_s::text AS video_duration,
            v.width AS src_w, v.height AS src_h
     FROM clip_variants cv
     JOIN clips c ON c.id = cv.clip_id
     JOIN videos v ON v.id = c.video_id
     WHERE cv.id = $1`,
    [id],
  );
  if (!variant) notFound();

  const siblings = await q<{
    id: string; label: string; name: string; status: string; n_scenes: string;
  }>(
    `SELECT cv.id::text, cv.label, cv.name, cv.status::text,
            (SELECT count(*) FROM variant_scenes vs WHERE vs.variant_id = cv.id)::text AS n_scenes
     FROM clip_variants cv WHERE cv.clip_id = $1 ORDER BY cv.label`,
    [variant.clip_id],
  );

  const scenes = await q<{
    id: string; idx: number; layout: string; source_in_s: string | null;
    source_out_s: string | null; duration_s: string | null; lifted: boolean;
    slot_a_asset: string | null; split_ratio: string | null; audio: string;
  }>(
    `SELECT id::text, idx, layout::text, source_in_s::text, source_out_s::text,
            duration_s::text, lifted, slot_a_asset::text, split_ratio::text, audio::text
     FROM variant_scenes WHERE variant_id = $1 ORDER BY idx`,
    [id],
  );
  const crops = await q<{
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
  const assets = await q<{ id: string; name: string; kind: string }>(
    "SELECT id::text, name, kind::text FROM assets ORDER BY created_at DESC",
  );
  const presets = await q<{
    id: string; name: string; is_default: boolean; config: Record<string, unknown>;
  }>(
    "SELECT id::text, name, is_default, config FROM subtitle_presets ORDER BY is_default DESC, created_at",
  );

  // Words for live captions + trim context: clip bounds ± 15s headroom.
  const clipIn = parseFloat(variant.clip_in);
  const clipOut = parseFloat(variant.clip_out);
  const words = await q<{ word: string; start_s: string; end_s: string }>(
    `SELECT w.word, w.start_s::text, w.end_s::text
     FROM transcript_words w JOIN transcripts t ON t.id = w.transcript_id
     WHERE t.video_id = $1 AND w.start_s IS NOT NULL AND w.end_s IS NOT NULL
       AND w.end_s > $2 AND w.start_s < $3
     ORDER BY w.idx`,
    [variant.video_id, clipIn - 15, clipOut + 15],
  );

  const workerUp = !!(process.env.WORKER_URL && process.env.INGEST_TOKEN);

  return (
    <>
      <Topbar
        title={`${variant.clip_name ?? "untitled clip"} · variant ${variant.label}`}
        sub={
          <>
            {variant.video_title} · approval{" "}
            <span className="tag">{variant.status}</span>
          </>
        }
      >
        <Link className="btn ghost sm" href={`/videos/${variant.video_id}`}>
          Back to transcript
        </Link>
        <Link className="btn sm" href={`/variants/${variant.id}/preview`}>
          Preview
        </Link>
      </Topbar>
      <section className="screen">
        <Builder
          variant={{
            id: variant.id,
            label: variant.label,
            name: variant.name,
            status: variant.status,
            clipId: variant.clip_id,
            clipName: variant.clip_name,
            clipIn,
            clipOut,
            presetId: variant.subtitle_preset_id,
            overrides: variant.subtitle_overrides ?? {},
            videoId: variant.video_id,
            videoDuration: parseFloat(variant.video_duration ?? "0") || 0,
            srcW: variant.src_w ?? 16,
            srcH: variant.src_h ?? 9,
          }}
          siblings={siblings.map((s) => ({
            id: s.id, label: s.label, name: s.name, status: s.status,
            nScenes: parseInt(s.n_scenes, 10),
          }))}
          scenes={scenes.map((s) => ({
            id: s.id, idx: s.idx, layout: s.layout,
            in: s.source_in_s ? parseFloat(s.source_in_s) : null,
            out: s.source_out_s ? parseFloat(s.source_out_s) : null,
            dur: s.duration_s ? parseFloat(s.duration_s) : null,
            lifted: s.lifted,
            asset: s.slot_a_asset,
            splitRatio: s.split_ratio ? parseFloat(s.split_ratio) : 0.5,
            audio: s.audio,
          }))}
          crops={crops.map((c) => ({
            sceneId: c.scene_id, ratio: c.ratio,
            x: parseFloat(c.crop_x), y: parseFloat(c.crop_y),
            w: parseFloat(c.crop_w), h: parseFloat(c.crop_h),
          }))}
          assets={assets}
          presets={presets}
          words={words.map((w) => ({
            w: w.word, s: parseFloat(w.start_s), e: parseFloat(w.end_s),
          }))}
          workerUp={workerUp}
        />
      </section>
    </>
  );
}
