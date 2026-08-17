import { q } from "@/lib/db";

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
      <h1>Clips</h1>
      <p className="sub">
        Each variant is one ad. Renders land in R2 as exports/&lt;variant&gt;/&lt;ratio&gt;.mp4.
      </p>
      {rows.length === 0 && <p className="hint">No clips yet — open a video and select a passage.</p>}
      {rows.length > 0 && (
        <table>
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
                  <div className="meta">{r.video_title}</div>
                </td>
                <td className="meta">
                  {parseFloat(r.source_in_s).toFixed(1)}s – {parseFloat(r.source_out_s).toFixed(1)}s
                </td>
                <td>{r.label} · {r.variant_name}</td>
                <td><span className="badge">{r.status}</span></td>
                <td>
                  {r.render_status ? (
                    <span
                      className={`badge ${
                        r.render_status === "done" ? "ready"
                        : r.render_status === "failed" ? "failed" : "working"
                      }`}
                      title={r.render_error ?? undefined}
                    >
                      {r.render_status}
                    </span>
                  ) : (
                    <span className="meta">—</span>
                  )}
                </td>
                <td className="meta">{r.export_uri ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
