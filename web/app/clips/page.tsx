import { q } from "@/lib/db";
import Workbench from "./Workbench";

export const dynamic = "force-dynamic";

/** Clip builder: the scenes strip is the variant list — one row per
 * variant of the current clip. Moving between clips happens from the
 * queue/cuts pages; ?v= carries the loaded variant. */
export default async function ClipsPage({
  searchParams,
}: {
  searchParams: Promise<{ v?: string }>;
}) {
  const { v } = await searchParams;

  // Default: the requested variant when valid, else the newest clip's A.
  let initial: string | null = null;
  if (v && /^[0-9a-f-]{36}$/.test(v)) {
    const hit = await q<{ id: string }>(
      "SELECT id::text FROM clip_variants WHERE id = $1", [v]);
    if (hit.length) initial = hit[0].id;
  }
  if (!initial) {
    const latest = await q<{ id: string }>(
      `SELECT cv.id::text FROM clip_variants cv
       JOIN clips c ON c.id = cv.clip_id
       ORDER BY c.created_at DESC, cv.label LIMIT 1`);
    initial = latest[0]?.id ?? null;
  }

  const workerUp = !!(process.env.WORKER_URL && process.env.INGEST_TOKEN);

  return (
    <>
      <section className="screen" style={{ paddingTop: 14 }}>
        <Workbench initialVariantId={initial} workerUp={workerUp} />
      </section>
    </>
  );
}
