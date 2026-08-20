import { NextResponse } from "next/server";
import { parseLibraryParams, runLibrary } from "@/lib/library";

export const dynamic = "force-dynamic";

/** JSON face of the Library query — same code path the page renders from,
 * so the "deleted sources never appear" guarantee is testable here. */
export async function GET(req: Request) {
  const sp = Object.fromEntries(new URL(req.url).searchParams.entries());
  try {
    const out = await runLibrary(parseLibraryParams(sp));
    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
