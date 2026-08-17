import { notFound } from "next/navigation";
import { q } from "@/lib/db";
import { Topbar } from "../../ui";
import Editor from "./Editor";

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
    video_title: string | null; src_w: number | null; src_h: number | null;
  }>(
    `SELECT cv.id::text, cv.label, cv.name, cv.status::text, cv.export_uri,
            c.id::text AS clip_id, c.name AS clip_name, v.title AS video_title,
            v.width AS src_w, v.height AS src_h
     FROM clip_variants cv
     JOIN clips c ON c.id = cv.clip_id
     JOIN videos v ON v.id = c.video_id
     WHERE cv.id = $1`,
    [id],
  );
  if (!variant) notFound();

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
    `SELECT scene_id::text, ratio::text, crop_x::text, crop_y::text,
            crop_w::text, crop_h::text
     FROM scene_crops WHERE scene_id = ANY($1::uuid[])`,
    [scenes.map((s) => s.id)],
  );
  const assets = await q<{ id: string; name: string; kind: string }>(
    "SELECT id::text, name, kind::text FROM assets ORDER BY created_at DESC",
  );

  return (
    <>
      <Topbar
        title={`${variant.clip_name ?? "untitled clip"} · variant ${variant.label}`}
        sub={
          <>
            {variant.video_title} · approval{" "}
            <span className="tag">{variant.status}</span>
            {variant.export_uri && (
              <>
                {" "}· last export{" "}
                <span className="mono">{variant.export_uri}</span>
              </>
            )}
          </>
        }
      />
      <section className="screen">
        <Editor
          variantId={variant.id}
          srcAr={(variant.src_w ?? 16) / (variant.src_h ?? 9)}
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
        />
      </section>
    </>
  );
}
