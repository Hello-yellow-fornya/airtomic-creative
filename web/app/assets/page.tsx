import { q } from "@/lib/db";
import { Topbar } from "../ui";

export const dynamic = "force-dynamic";

const KIND_LABEL: Record<string, string> = {
  product_still: "Product still",
  end_card: "End card",
  logo: "Logo",
  broll: "B-roll",
  other: "Other",
};

export default async function AssetsPage() {
  const assets = await q<{
    id: string; name: string; kind: string; width: number | null; height: number | null;
  }>(
    "SELECT id::text, name, kind::text, width, height FROM assets ORDER BY kind, created_at DESC",
  );
  const workerUp = !!(process.env.WORKER_URL && process.env.INGEST_TOKEN);

  const kinds = [...new Set(assets.map((a) => a.kind))];

  return (
    <>
      <Topbar
        title="Brand assets"
        sub="Product stills, end cards and logos used in splits"
      />
      <section className="screen">
        <div className="stack">
          <div className="note">
            Uploads aren&apos;t wired from here yet — drop files into R2 via the
            Cloudflare dashboard and add a row to <span className="mono">assets</span>;
            they appear here and in the builder immediately.
          </div>
          {assets.length === 0 ? (
            <div className="card qempty">
              No brand assets yet. Square and 4:5 stills drop straight into a
              split without reframing.
            </div>
          ) : (
            kinds.map((k) => (
              <div key={k}>
                <h2 className="sec">{KIND_LABEL[k] ?? k}s</h2>
                <div className="assets">
                  {assets.filter((a) => a.kind === k).map((a) => (
                    <div key={a.id} className="ass">
                      <div className="sq" style={
                        workerUp
                          ? { backgroundImage: `url(/api/assets/${a.id}/file)` }
                          : undefined
                      }>
                        {a.width && a.height && (
                          <span>{a.width}×{a.height}</span>
                        )}
                      </div>
                      <div className="nm">{a.name}</div>
                      <div className="kd">{KIND_LABEL[a.kind] ?? a.kind}</div>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
          <div className="note">
            A vertical split makes each half 1080×960. Anything square or 4:5
            fits without cropping — anything wider gets centre-cropped on
            render, so check the framing before it ships.
          </div>
        </div>
      </section>
    </>
  );
}
