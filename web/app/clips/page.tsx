import Link from "next/link";
import { q } from "@/lib/db";
import { Topbar } from "../ui";

export const dynamic = "force-dynamic";

type Row = {
  clip_id: string;
  clip_name: string | null;
  video_title: string | null;
  source_in_s: string;
  source_out_s: string;
  variant_id: string;
  label: string;
  variant_name: string;
  status: string;
  export_uri: string | null;
  render_status: string | null;
  render_error: string | null;
};

function renderTag(status: string) {
  if (status === "done") return "tag ok";
  if (status === "failed") return "tag flag";
  return "tag";
}

export default async function ClipsPage() {
  const rows = await q<Row>(`
    SELECT c.id::text AS clip_id, c.name AS clip_name, v.title AS video_title,
           c.source_in_s::text, c.source_out_s::text,
           cv.id::text AS variant_id, cv.label, cv.name AS variant_name,
           cv.status::text, cv.export_uri,
           j.status::text AS render_status, j.error AS render_error
    FROM clips c
    JOIN videos v ON v.id = c.video_id
    JOIN clip_variants cv ON cv.clip_id = c.id
    LEFT JOIN LATERAL (
      SELECT status, error FROM jobs
      WHERE type = 'render' AND payload->>'variant_id' = cv.id::text
      ORDER BY id DESC LIMIT 1
    ) j ON true
    ORDER BY c.created_at DESC, cv.label`);

  return (
    <>
      <Topbar
        title="Clip builder"
        sub="Each variant is one ad. Renders land in R2 as exports/<variant>/<ratio>.mp4."
      />
      <section className="screen">
        <h2 className="sec">Clips</h2>
        {rows.length === 0 && (
          <div className="card qempty">
            No clips yet — open a video and select a passage.
          </div>
        )}
        {rows.length > 0 && (
          <div className="card">
            <table className="ads">
              <thead>
                <tr>
                  <th>Clip</th><th>Source range</th><th>Variant</th>
                  <th>Approval</th><th>Render</th><th>Export</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.variant_id}>
                    <td>
                      <strong>{r.clip_name ?? "untitled clip"}</strong>
                      <div style={{ fontSize: 11, color: "var(--muted)" }}>
                        {r.video_title}
                      </div>
                    </td>
                    <td className="mono" style={{ fontSize: 11 }}>
                      {parseFloat(r.source_in_s).toFixed(1)}s –{" "}
                      {parseFloat(r.source_out_s).toFixed(1)}s
                    </td>
                    <td>
                      <Link
                        href={`/variants/${r.variant_id}`}
                        style={{ textDecoration: "underline" }}
                      >
                        {r.label} · {r.variant_name}
                      </Link>
                    </td>
                    <td><span className="tag">{r.status}</span></td>
                    <td>
                      {r.render_status ? (
                        <span
                          className={renderTag(r.render_status)}
                          title={r.render_error ?? undefined}
                        >
                          {r.render_status}
                        </span>
                      ) : (
                        <span style={{ color: "var(--faint)" }}>—</span>
                      )}
                    </td>
                    <td className="mono" style={{ fontSize: 10.5, color: "var(--muted)" }}>
                      {r.export_uri ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
