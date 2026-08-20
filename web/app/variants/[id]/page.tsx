import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/** The variant editor lives in the clip builder workbench now — the
 * table is the variant list and the editor loads the selected row.
 * Old links (queue, cuts, send) land here and are forwarded. */
export default async function VariantPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/clips?v=${id}`);
}
