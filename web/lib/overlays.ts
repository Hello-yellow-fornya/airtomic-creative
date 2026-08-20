import { pool } from "@/lib/db";

/** Mark the variant stale when it already has a finished render — the UI
 * then offers "Re-render" instead of silently re-queueing. Cleared when a
 * render is requested. */
export async function markStale(variantId: string) {
  await pool.query(
    `UPDATE clip_variants SET render_stale = EXISTS(
       SELECT 1 FROM jobs WHERE type = 'render'
       AND payload->>'variant_id' = $1::text AND status = 'done')
     WHERE id = $1::uuid`,
    [variantId],
  );
}
