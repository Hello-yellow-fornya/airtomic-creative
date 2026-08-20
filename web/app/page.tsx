import { q } from "@/lib/db";
import { parseLibraryParams, runLibrary } from "@/lib/library";
import { Topbar } from "./ui";
import UploadArea from "./UploadArea";
import LibraryBrowser from "./LibraryBrowser";

export const dynamic = "force-dynamic";

/** Library: every source (long-form + ad back catalogue) in one browsable
 * grid — search, filter chips, tile/list toggle, pagination — all
 * URL-persisted. Spend is folded into each tile via video_meta_links, so
 * the old separate performance table is gone. */
export default async function LibraryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const params = parseLibraryParams(sp);

  const [lib, corpus] = await Promise.all([
    runLibrary(params),
    q<{ total: string; with_spend: string }>(`
      SELECT count(DISTINCT meta_video_id)::text AS total,
             count(DISTINCT meta_video_id) FILTER (WHERE spend > 0)::text AS with_spend
      FROM ad_performance`),
  ]);

  const kfEnabled = !!(process.env.WORKER_URL && process.env.INGEST_TOKEN);

  return (
    <>
      <Topbar
        title="Library"
        sub="Long-form source material and the ad back catalogue"
      />
      <section className="screen">
        <UploadArea workerUp={kfEnabled} />
        <LibraryBrowser
          rows={lib.rows}
          total={lib.total}
          page={lib.page}
          per={lib.per}
          workerUp={kfEnabled}
        />
        <p style={{ marginTop: 10, fontSize: 11.5, color: "var(--muted)" }}>
          Spend shown per source is the sum of raw ad-level spend joined via
          Meta video links; rates are computed at video level from raw counts
          on each source&apos;s page. {corpus[0]?.total ?? 0} creatives in the
          performance corpus · {corpus[0]?.with_spend ?? 0} with spend.
        </p>
      </section>
    </>
  );
}
