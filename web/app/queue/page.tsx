import { q } from "@/lib/db";
import { Topbar } from "../ui";
import Queue from "./Queue";

export const dynamic = "force-dynamic";

/** 06 Review queue. Rows are individual ads-to-be. Flow mirrors invoice
 * approval: submitted → in review → approved → sent. Bulk actions are
 * scoped per state — send only exists on the Approved tab, so an
 * unapproved variant can't reach Meta by mis-click. */
export default async function QueuePage() {
  const rows = await q<{
    id: string; label: string; name: string; slug: string; status: string;
    submitted_by: string | null; submitted_at: string | null;
    source_range: string; video_title: string | null;
    n_scenes: string; duration: string | null; push_status: string | null;
  }>(`
    SELECT cv.id::text, cv.label, cv.name, cv.slug, cv.status::text,
           cv.submitted_by, cv.submitted_at::text,
           round(c.source_in_s) || 's–' || round(c.source_out_s) || 's' AS source_range,
           v.title AS video_title,
           (SELECT count(*) FROM variant_scenes vs WHERE vs.variant_id = cv.id)::text AS n_scenes,
           (SELECT sum(COALESCE(vs.source_out_s - vs.source_in_s, vs.duration_s))::text
            FROM variant_scenes vs WHERE vs.variant_id = cv.id) AS duration,
           mp.status::text AS push_status
    FROM clip_variants cv
    JOIN clips c ON c.id = cv.clip_id
    JOIN videos v ON v.id = c.video_id
    LEFT JOIN LATERAL (
      SELECT status FROM meta_pushes WHERE variant_id = cv.id
      ORDER BY created_at DESC LIMIT 1
    ) mp ON true
    WHERE cv.status::text IN ('in_review', 'approved', 'sent', 'sending', 'failed')
    ORDER BY cv.submitted_at DESC NULLS LAST, cv.created_at DESC`);

  return (
    <>
      <Topbar
        title="Review queue"
        sub="Approve creatives, then send them to Meta in a batch"
      />
      <section className="screen">
        <Queue
          rows={rows.map((r) => ({
            id: r.id,
            label: r.label,
            name: r.name,
            slug: r.slug,
            status: r.status === "sending" || r.status === "failed" ? "sent" : r.status,
            rawStatus: r.status,
            by: r.submitted_by,
            when: r.submitted_at ? r.submitted_at.slice(0, 10) : null,
            sourceRange: r.source_range,
            videoTitle: r.video_title,
            nScenes: parseInt(r.n_scenes, 10),
            duration: r.duration ? parseFloat(r.duration) : null,
            pushStatus: r.push_status,
          }))}
        />
      </section>
    </>
  );
}
