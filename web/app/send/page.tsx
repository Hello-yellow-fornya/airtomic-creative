import { q } from "@/lib/db";
import { Topbar } from "../ui";
import Send from "./Send";

export const dynamic = "force-dynamic";

/** 07 Send to Meta. One ad per variant into an existing ad set, always
 * paused — the tool never creates campaigns or ad sets. The Meta API
 * connection isn't wired yet, so the destination panel says so and the
 * send action is disabled; everything computed client-side (ad names,
 * UTM URLs) is real. */
export default async function SendPage({
  searchParams,
}: {
  searchParams: Promise<{ ids?: string }>;
}) {
  const { ids } = await searchParams;
  const idList = (ids ?? "").split(",").filter((s) => /^[0-9a-f-]{36}$/.test(s));

  const variants = await q<{
    id: string; label: string; name: string; slug: string; status: string;
    clip_name: string | null; video_title: string | null; video_source: string;
    n_scenes: string; duration: string | null; has_card: boolean; has_split: boolean;
    push_status: string | null; push_error: string | null;
  }>(`
    SELECT cv.id::text, cv.label, cv.name, cv.slug, cv.status::text,
           c.name AS clip_name, v.title AS video_title, v.source::text AS video_source,
           (SELECT count(*) FROM variant_scenes vs WHERE vs.variant_id = cv.id)::text AS n_scenes,
           (SELECT sum(COALESCE(vs.source_out_s - vs.source_in_s, vs.duration_s))::text
            FROM variant_scenes vs WHERE vs.variant_id = cv.id) AS duration,
           EXISTS (SELECT 1 FROM variant_scenes vs WHERE vs.variant_id = cv.id
                   AND vs.layout = 'card') AS has_card,
           EXISTS (SELECT 1 FROM variant_scenes vs WHERE vs.variant_id = cv.id
                   AND vs.layout::text LIKE 'split%') AS has_split,
           mp.status::text AS push_status, mp.error AS push_error
    FROM clip_variants cv
    JOIN clips c ON c.id = cv.clip_id
    JOIN videos v ON v.id = c.video_id
    LEFT JOIN LATERAL (
      SELECT status, error FROM meta_pushes WHERE variant_id = cv.id
      ORDER BY created_at DESC LIMIT 1
    ) mp ON true
    WHERE ${idList.length ? "cv.id = ANY($1::uuid[])" : "cv.status = 'approved'"}
    ORDER BY cv.label`,
    idList.length ? [idList] : []);

  const metaConfigured = false; // no Meta credentials wired into the web app

  return (
    <>
      <Topbar
        title="Send to Meta"
        sub="Creates a paused ad in an existing ad set"
      />
      <section className="screen">
        <Send
          variants={variants.map((v) => ({
            id: v.id, label: v.label, name: v.name, slug: v.slug,
            status: v.status,
            clipName: v.clip_name, videoTitle: v.video_title,
            videoSource: v.video_source,
            nScenes: parseInt(v.n_scenes, 10),
            duration: v.duration ? parseFloat(v.duration) : null,
            hasCard: v.has_card, hasSplit: v.has_split,
            pushStatus: v.push_status, pushError: v.push_error,
          }))}
          fromQueue={idList.length > 0}
          metaConfigured={metaConfigured}
        />
      </section>
    </>
  );
}
