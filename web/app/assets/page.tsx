import { q } from "@/lib/db";
import { Topbar } from "../ui";
import AssetManager from "./AssetManager";

export const dynamic = "force-dynamic";

export default async function AssetsPage() {
  const assets = await q<{
    id: string; name: string; kind: string; width: number | null;
    height: number | null; duration_s: string | null;
  }>(
    "SELECT id::text, name, kind::text, width, height, duration_s::text FROM assets ORDER BY kind, created_at DESC",
  );
  const workerUp = !!(process.env.WORKER_URL && process.env.INGEST_TOKEN);

  return (
    <>
      <Topbar
        title="Brand assets"
        sub="Product stills, end cards and logos used in splits"
      />
      <section className="screen">
        <AssetManager
          workerUp={workerUp}
          assets={assets.map((a) => ({
            id: a.id, name: a.name, kind: a.kind,
            width: a.width, height: a.height,
            duration: a.duration_s ? parseFloat(a.duration_s) : null,
          }))}
        />
      </section>
    </>
  );
}
