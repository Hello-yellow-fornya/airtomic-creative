import { NextResponse } from "next/server";
import { workerBase } from "@/lib/worker";

export const dynamic = "force-dynamic";

/** Read-only Meta credential diagnostics: token scopes, API version check,
 * account info, campaigns and ad sets. Proves the credentials end to end
 * without creating anything on the account.
 *
 * The send path runs on the worker, so the credentials belong in Railway's
 * env — but this route also runs the same reads natively when the META_*
 * vars are present here (Vercel), so a mis-placed set is still diagnosable.
 * env_presence reports which names each side can see (booleans, never
 * values). */

const NAMES = [
  "META_APP_ID", "META_APP_SECRET", "META_SYSTEM_USER_TOKEN",
  "META_AD_ACCOUNT_ID", "META_PAGE_ID", "META_INSTAGRAM_ACTOR_ID",
  "META_API_VERSION",
] as const;

const GRAPH = "https://graph.facebook.com";

async function graphGet(url: string): Promise<{ ok: boolean; status: number; body: Record<string, unknown>; version: string | null }> {
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, body, version: res.headers.get("facebook-api-version") };
}

function errOf(r: { status: number; body: Record<string, unknown> }) {
  const e = (r.body.error ?? {}) as Record<string, unknown>;
  return {
    error: (e.message as string) ?? `HTTP ${r.status}`,
    type: e.type, code: e.code, error_subcode: e.error_subcode,
    fbtrace_id: e.fbtrace_id, http_status: r.status,
  };
}

async function nativeDiag() {
  const appId = process.env.META_APP_ID!;
  const appSecret = process.env.META_APP_SECRET!;
  const token = process.env.META_SYSTEM_USER_TOKEN!;
  const rawAccount = process.env.META_AD_ACCOUNT_ID!;
  const account = rawAccount.startsWith("act_") ? rawAccount : `act_${rawAccount}`;
  const rawVer = process.env.META_API_VERSION || "v26.0";
  const ver = `v${rawVer.trim().replace(/^[vV]+/, "")}`;
  const out: Record<string, unknown> = {
    ran_from: "vercel",
    identity: {
      page_id_set: !!process.env.META_PAGE_ID,
      instagram_actor_id_set: !!process.env.META_INSTAGRAM_ACTOR_ID,
    },
  };

  // 1. token introspection via app token
  try {
    const r = await graphGet(
      `${GRAPH}/${ver}/debug_token?input_token=${encodeURIComponent(token)}` +
      `&access_token=${encodeURIComponent(`${appId}|${appSecret}`)}`);
    if (!r.ok) out.token = errOf(r);
    else {
      const d = (r.body.data ?? {}) as Record<string, unknown>;
      out.token = {
        is_valid: d.is_valid, type: d.type, application: d.application,
        app_id: d.app_id, app_id_matches: String(d.app_id) === String(appId),
        scopes: d.scopes ?? [], granular_scopes: d.granular_scopes ?? [],
        expires_at: d.expires_at, data_access_expires_at: d.data_access_expires_at,
        issued_at: d.issued_at,
      };
    }
  } catch (e) { out.token = { error: String(e) }; }

  // 2. version existence: versioned ping + what Meta serves unversioned
  try {
    const v = await graphGet(`${GRAPH}/${ver}/me?fields=id,name&access_token=${encodeURIComponent(token)}`);
    const un = await graphGet(`${GRAPH}/me?fields=id&access_token=${encodeURIComponent(token)}`);
    out.version = {
      configured: ver,
      configured_version_ok: v.ok,
      served_as: v.version,
      unversioned_served_as: un.version,
      ...(v.ok ? {} : { error: v.body.error ?? { http_status: v.status } }),
    };
  } catch (e) { out.version = { error: String(e) }; }

  // 3. account, campaigns, ad sets
  try {
    const a = await graphGet(
      `${GRAPH}/${ver}/${account}?fields=id,name,account_status,currency,timezone_name&access_token=${encodeURIComponent(token)}`);
    out.account = a.ok ? a.body : errOf(a);
  } catch (e) { out.account = { error: String(e) }; }

  const listAll = async (edge: string, fields: string) => {
    const rows: unknown[] = [];
    let url = `${GRAPH}/${ver}/${account}/${edge}?fields=${fields}&limit=100&access_token=${encodeURIComponent(token)}`;
    for (let page = 0; page < 5; page++) {
      const r = await graphGet(url);
      if (!r.ok) return page === 0 ? errOf(r) : rows;
      rows.push(...((r.body.data as unknown[]) ?? []));
      const next = ((r.body.paging ?? {}) as Record<string, unknown>).next as string | undefined;
      if (!next || rows.length >= 500) break;
      url = next;
    }
    return rows;
  };
  try {
    out.campaigns = await listAll("campaigns",
      "id,name,status,effective_status,objective,daily_budget,lifetime_budget,buying_type,special_ad_categories,created_time");
  } catch (e) { out.campaigns = { error: String(e) }; }
  try {
    out.adsets = await listAll("adsets",
      "id,name,campaign_id,status,effective_status,daily_budget,lifetime_budget,optimization_goal,billing_event,bid_strategy,created_time");
  } catch (e) { out.adsets = { error: String(e) }; }

  return out;
}

export async function GET() {
  const vercelEnv = Object.fromEntries(NAMES.map((n) => [n, !!process.env[n]]));
  const core = ["META_APP_ID", "META_APP_SECRET", "META_SYSTEM_USER_TOKEN", "META_AD_ACCOUNT_ID"]
    .every((n) => !!process.env[n]);

  // Ask the worker regardless — the send path needs the creds THERE.
  let worker: Record<string, unknown> = { error: "worker not configured" };
  const w = workerBase();
  if (w) {
    try {
      const res = await fetch(`${w.base}/meta/diag?key=${encodeURIComponent(w.token)}`,
        { cache: "no-store", signal: AbortSignal.timeout(120_000) });
      worker = (await res.json().catch(() => ({ error: "bad worker response" }))) as Record<string, unknown>;
      worker.http_status = res.status;
    } catch (e) {
      worker = { error: e instanceof Error ? e.message : String(e) };
    }
  }

  const workerConfigured = !(worker as { missing?: unknown }).missing && !worker.error;
  const native = core && !workerConfigured ? await nativeDiag() : null;

  return NextResponse.json({
    env_presence: { vercel: vercelEnv },
    worker,
    ...(native ? { native } : {}),
  });
}
