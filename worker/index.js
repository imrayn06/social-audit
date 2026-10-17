/**
 * SocialAudit — agency tool for auditing client Instagram/Facebook accounts.
 *
 * Env vars (all optional in demo mode):
 *   META_APP_ID, META_APP_SECRET  – Meta developer app for OAuth
 *   APP_ORIGIN                    – public origin, e.g. https://social-audit.workers.dev
 *   AI_API_KEY, AI_BASE_URL, AI_MODEL – OpenAI-compatible LLM for suggestions/calendar
 *   SECRET_KEY                    – AES key material for encrypting stored tokens
 *   DEMO                          – "1" to force demo data
 */

const GRAPH = "https://graph.facebook.com/v26.0";
const FB_DIALOG = "https://www.facebook.com/v26.0/dialog/oauth";
const SCOPES = [
  "instagram_basic",
  "instagram_manage_insights",
  "pages_show_list",
  "pages_read_engagement",
].join(",");

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });

const err = (status, message, extra = {}) => json({ error: message }, status, extra);
const uid = () => crypto.randomUUID();
const now = () => Date.now();

const parseBody = async (req) => {
  try { return await req.json(); } catch { return {}; }
};

const decodeState = (state) => {
  try { return JSON.parse(atob(state)); } catch { return {}; }
};

/* ---------------------------------- crypto --------------------------------- */

const encKey = async (env) => {
  const material = env.SECRET_KEY || env.META_APP_SECRET || "social-audit-dev-secret";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
};

const encrypt = async (env, plain) => {
  if (!plain) return "";
  const key = await encKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain));
  const buf = new Uint8Array(iv.length + ct.byteLength);
  buf.set(iv, 0); buf.set(new Uint8Array(ct), iv.length);
  return btoa(String.fromCharCode(...buf));
};

const decrypt = async (env, encoded) => {
  if (!encoded) return "";
  try {
    const key = await encKey(env);
    const buf = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
    const iv = buf.slice(0, 12);
    const ct = buf.slice(12);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    return new TextDecoder().decode(pt);
  } catch { return ""; }
};

/* ---------------------------------- helpers -------------------------------- */

const demoMode = (env) =>
  env.DEMO === "1" || !env.META_APP_ID || !env.META_APP_SECRET;

const fetchJson = async (url, init = {}) => {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.error) {
    const msg = data?.error?.message || `Upstream ${res.status}`;
    const code = data?.error?.code || res.status;
    throw new Error(`${msg} (code ${code})`);
  }
  return data;
};

/* ------------------------------- demo dataset ------------------------------ */

const DEMO_ACCOUNT = {
  ig_user_id: "demo_ig_1",
  page_id: "demo_page_1",
  username: "demo.coffeebrand",
  page_name: "Demo Coffee Brand",
  page_url: "https://www.facebook.com/democoffeebrand",
  profile_pic: "",
  followers_count: 4820,
};

const rnd = (seed) => { // deterministic pseudo-random
  let s = seed;
  return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
};

function demoMetrics() {
  const r = rnd(42);
  const days = 30;
  const dailyReach = Array.from({ length: days }, (_, i) =>
    Math.round(900 + Math.sin(i / 4) * 350 + r() * 400));
  const dailyViews = dailyReach.map((v) => Math.round(v * (1.6 + r() * 0.7)));
  const media = Array.from({ length: 36 }, (_, i) => {
    const type = ["REELS", "IMAGE", "CAROUSEL"][Math.floor(r() * 3)];
    const reach = Math.round(600 + r() * 4200);
    const likes = Math.round(reach * (0.04 + r() * 0.06));
    return {
      id: `demo_media_${i}`,
      timestamp: new Date(now() - i * (2.2 + r() * 3) * 86400000).toISOString(),
      media_type: type,
      like_count: likes,
      comments_count: Math.round(likes * (0.03 + r() * 0.06)),
      permalink: "#",
      insights: {
        likes,
        comments: Math.round(likes * (0.03 + r() * 0.06)),
        saved: Math.round(likes * (0.05 + r() * 0.12)),
        shares: Math.round(likes * (0.02 + r() * 0.08)),
        reach,
      },
    };
  });
  return {
    profile: {
      username: DEMO_ACCOUNT.username,
      name: "Demo Coffee Brand",
      biography: "Small-batch roastery ☕ | DM for wholesale",
      followers_count: DEMO_ACCOUNT.followers_count,
      profile_picture_url: "",
    },
    dailyReach, dailyViews, media,
    fetchedAt: now(),
    demo: true,
  };
}

/* ------------------------------ Meta OAuth flow ---------------------------- */

function metaAuthUrl(env, state) {
  const redirect = `${env.APP_ORIGIN || ""}/api/meta/callback`;
  const params = new URLSearchParams({
    client_id: env.META_APP_ID,
    redirect_uri: redirect,
    scope: SCOPES,
    response_type: "code",
    config_type: "regular",
    state,
  });
  return `${FB_DIALOG}?${params}`;
}

async function metaCallback(env, url) {
  const u = new URL(url);
  const code = u.searchParams.get("code");
  const state = decodeState(u.searchParams.get("state") || "");
  const clientId = state.clientId;
  if (!code || !clientId) return err(400, "Missing code or state — start the flow from a client page.");

  // 1. short-lived code -> token, then exchange for long-lived
  const redirect = `${env.APP_ORIGIN || u.origin}/api/meta/callback`;
  let token = await fetchJson(
    `${GRAPH}/oauth/access_token?grant_type=fb_exchange_token&client_id=${env.META_APP_ID}` +
    `&client_secret=${env.META_APP_SECRET}&fb_exchange_token=${code}`
  );

  // 2. discover Pages -> linked Instagram business accounts
  const pages = await fetchJson(`${GRAPH}/me/accounts?fields=id,name,access_token,tasks&access_token=${token.access_token}`);
  const connections = [];
  for (const page of pages.data || []) {
    let ig = null;
    try {
      const p = await fetchJson(`${GRAPH}/${page.id}?fields=instagram_business_account{id,username,name,followers_count,profile_picture_url}&access_token=${token.access_token}`);
      ig = p.instagram_business_account || null;
    } catch { /* page has no linked IG account */ }
    if (!ig) continue;
    const longToken = await fetchJson(
      `${GRAPH}/oauth/access_token?grant_type=fb_exchange_token&client_id=${env.META_APP_ID}` +
      `&client_secret=${env.META_APP_SECRET}&fb_exchange_token=${token.access_token}`
    ).catch(() => token);
    connections.push({
      id: uid(),
      client_id: clientId,
      platform: "instagram",
      ig_user_id: ig.id,
      page_id: page.id,
      username: ig.username || "",
      page_name: page.name || "",
      page_url: `https://www.facebook.com/${page.id}`,
      profile_pic: ig.profile_picture_url || "",
      followers_count: ig.followers_count || 0,
      access_token: await encrypt(env, page.access_token || longToken.access_token || token.access_token),
      connected_at: now(),
    });
  }
  if (!connections.length) {
    return new Response(
      `<script>opener?.postMessage({type:'meta-connected',count:0,error:'No Instagram professional account linked to any Facebook Page you manage.'},'*');window.close()</script>`,
      { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  const stmt = env.DB.prepare(
    `INSERT INTO connections (id, client_id, platform, ig_user_id, page_id, username, page_name, page_url, profile_pic, followers_count, access_token, connected_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)`);
  await env.DB.batch(connections.map((c) => stmt.bind(c.id, c.client_id, c.platform, c.ig_user_id, c.page_id, c.username, c.page_name, c.page_url, c.profile_pic, c.followers_count, c.access_token, c.connected_at)));
  return new Response(
    `<script>opener?.postMessage({type:'meta-connected',count:${connections.length}},'*');window.close()</script>`,
    { headers: { "content-type": "text/html; charset=utf-8" } });
}

/* ------------------------------ insights fetch ----------------------------- */

async function fetchLiveMetrics(env, conn) {
  const token = await decrypt(env, conn.access_token);
  if (!token) throw new Error("Stored token unreadable — reconnect the account.");
  const ig = conn.ig_user_id;
  const since = Math.floor((now() - 30 * 86400000) / 1000);
  const until = Math.floor(now() / 1000);

  const profile = await fetchJson(`${GRAPH}/${ig}?fields=username,name,biography,followers_count,profile_picture_url&access_token=${token}`);

  let dailyReach = [], dailyViews = [];
  try {
    const ins = await fetchJson(
      `${GRAPH}/${ig}/insights?metric=reach,views&period=day&metric_type=time_series&since=${since}&until=${until}&access_token=${token}`);
    for (const m of ins.data || []) {
      const vals = (m.values || []).map((v) => v.value);
      if (m.name === "reach") dailyReach = vals;
      if (m.name === "views") dailyViews = vals;
    }
  } catch { /* some accounts lack access to these metrics */ }

  const mediaRes = await fetchJson(`${GRAPH}/${ig}/media?fields=id,timestamp,media_type,like_count,comments_count,permalink&limit=50&access_token=${token}`);
  const media = [];
  const list = (mediaRes.data || []).slice(0, 30);
  const CONCURRENCY = 5;
  for (let i = 0; i < list.length; i += CONCURRENCY) {
    const chunk = list.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(chunk.map(async (m) => {
      const ins = await fetchJson(`${GRAPH}/${m.id}/insights?metric=likes,comments,saved,shares,reach&access_token=${token}`);
      const byName = Object.fromEntries((ins.data || []).map((x) => [x.name, x.values?.[0]?.value ?? 0]));
      return {
        id: m.id, timestamp: m.timestamp, media_type: m.media_type,
        like_count: m.like_count, comments_count: m.comments_count, permalink: m.permalink,
        insights: {
          likes: byName.likes ?? m.like_count ?? 0,
          comments: byName.comments ?? m.comments_count ?? 0,
          saved: byName.saved ?? 0,
          shares: byName.shares ?? 0,
          reach: byName.reach ?? 0,
        },
      };
    }));
    for (const r of results) if (r.status === "fulfilled") media.push(r.value);
  }
  return { profile, dailyReach, dailyViews, media, fetchedAt: now(), demo: false };
}

/* ------------------------------ scoring engine ----------------------------- */

const ER_BENCHMARK = (followers) =>
  followers < 1000 ? 0.065 : followers < 10000 ? 0.04 : followers < 50000 ? 0.025 : 0.015;

function scoreAudit(m) {
  const media = m.media || [];
  const followers = m.profile?.followers_count || 0;

  const per = media.map((x) => {
    const ins = x.insights || {};
    const engagements = (ins.likes || 0) + (ins.comments || 0) + 2 * (ins.saved || 0) + 2 * (ins.shares || 0);
    const base = ins.reach || followers || 1;
    return { ...ins, timestamp: x.timestamp, media_type: x.media_type, er: engagements / base };
  });
  const er = per.length ? per.reduce((a, b) => a + b.er, 0) / per.length : 0;
  const bench = ER_BENCHMARK(followers);

  const weeks = 8;
  const postsPerWeek = media.filter((x) => now() - Date.parse(x.timestamp) < weeks * 7 * 86400000).length / weeks;

  const typeCounts = {};
  for (const x of media) typeCounts[x.media_type] = (typeCounts[x.media_type] || 0) + 1;
  const total = media.length || 1;
  const mix = Object.entries(typeCounts).map(([type, n]) => ({ type, pct: Math.round((n / total) * 100) }));
  const reelsPct = (typeCounts.REELS || 0) / total;

  const half = Math.floor((m.dailyReach || []).length / 2);
  const recentReach = avg((m.dailyReach || []).slice(half));
  const olderReach = avg((m.dailyReach || []).slice(0, half)) || 1;
  const reachTrend = (recentReach - olderReach) / olderReach;

  const totalSaves = per.reduce((a, b) => a + b.saved, 0);
  const totalShares = per.reduce((a, b) => a + b.shares, 0);
  const totalReach = per.reduce((a, b) => a + b.reach, 0) || 1;

  const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));
  const scores = {
    engagement: clamp((er / bench) * 70),
    consistency: clamp((postsPerWeek / 4) * 100),
    contentMix: clamp(40 + reelsPct * 50 + (mix.length > 1 ? 20 : 0)),
    reach: clamp(60 + reachTrend * 150),
    valueSignals: clamp(((totalSaves + totalShares) / totalReach / 0.05) * 100),
  };
  scores.overall = clamp(
    scores.engagement * 0.3 + scores.consistency * 0.25 + scores.contentMix * 0.15 +
    scores.reach * 0.15 + scores.valueSignals * 0.15
  );

  return {
    scores,
    summary: {
      erPct: +(er * 100).toFixed(2),
      benchmarkErPct: +(bench * 100).toFixed(2),
      postsPerWeek: +postsPerWeek.toFixed(1),
      followers,
      reachTrendPct: Math.round(reachTrend * 100),
      savesRatePct: +((totalSaves / totalReach) * 100).toFixed(2),
      sharesRatePct: +((totalShares / totalReach) * 100).toFixed(2),
      mediaCount: media.length,
      mix,
    },
  };
}

const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

/* --------------------------- heuristic suggestions -------------------------- */

function heuristicSuggestions(metrics, scored) {
  const s = scored.summary;
  const out = { summary: "", strengths: [], improvements: [], contentIdeas: [] };
  const er = s.erPct, bench = s.benchmarkErPct;

  out.summary = er >= bench
    ? `Engagement is above the ${bench}% benchmark for accounts this size (${er}%). Keep the current formats and double down on what earns saves and shares.`
    : `Engagement is ${er}% vs a ${bench}% benchmark for this size — the biggest lever is format and hook quality, not posting more.`;

  if (er >= bench) out.strengths.push(`Engagement rate ${er}% beats the ${bench}% peer benchmark.`);
  if (s.postsPerWeek >= 3.5) out.strengths.push(`Consistent cadence at ${s.postsPerWeek} posts/week.`);
  if (s.reachTrendPct > 5) out.strengths.push(`Reach is trending up ${s.reachTrendPct}% over the last two weeks.`);
  if (s.savesRatePct > 2) out.strengths.push(`High save rate (${s.savesRatePct}%) — content has lasting value.`);

  if (er < bench) out.improvements.push(`Lift engagement from ${er}% toward ${bench}%: open hooks in the first line, ask a question, and end every caption with a single clear CTA.`);
  if (s.postsPerWeek < 3.5) out.improvements.push(`Post ${Math.ceil(4 - s.postsPerWeek)} more times per week — 4–5 posts/week is the minimum for steady growth.`);
  if (s.reachTrendPct < 0) out.improvements.push(`Reach fell ${Math.abs(s.reachTrendPct)}% in the last 14 days — experiment with new formats and topics; the algorithm is throttling repeats.`);
  if (s.sharesRatePct < 1) out.improvements.push(`Shares are low (${s.sharesRatePct}%) — add relatable, opinion-led, or “tag someone who…” content that people send to friends.`);
  const reels = (s.mix.find((x) => x.type === "REELS") || {}).pct || 0;
  if (reels < 30) out.improvements.push(`Only ${reels}% of posts are Reels — Reels drive the most non-follower reach; aim for at least half your content as short video.`);

  out.contentIdeas = [
    { title: "Behind-the-scenes day-in-the-life Reel", format: "Reel", rationale: "BTS content consistently earns shares and humanizes the brand." },
    { title: "3 mistakes in your niche (carousel)", format: "Carousel", rationale: "Educational carousels drive saves, the strongest quality signal." },
    { title: "Customer story / testimonial", format: "Image + caption", rationale: "Social proof converts and invites comments." },
    { title: "Hot take on an industry trend", format: "Reel or text post", rationale: "Opinion content drives shares and discussion." },
    { title: "This-or-that interactive Story series", format: "Story", rationale: "Interactive Stories boost profile visits and DMs." },
  ];
  return out;
}

/* --------------------------------- AI layer -------------------------------- */

async function aiJson(env, system, user, fallback) {
  if (!env.AI_API_KEY) return { ...fallback, generatedBy: "heuristics" };
  const base = (env.AI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.AI_API_KEY}` },
      body: JSON.stringify({
        model: env.AI_MODEL || "gpt-4o-mini",
        temperature: 0.6,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: AbortSignal.timeout(60000),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || `AI ${res.status}`);
    const parsed = JSON.parse(data.choices[0].message.content);
    return { ...fallback, ...parsed, generatedBy: "ai" };
  } catch (e) {
    return { ...fallback, generatedBy: "heuristics", aiError: String(e?.message || e) };
  }
}

function calendarFallback(scored, days = 30) {
  const s = scored.summary;
  const reelsPct = (s.mix.find((x) => x.type === "REELS") || {}).pct || 0;
  const plan = [];
  const d = new Date();
  const formats = reelsPct < 30
    ? ["Reel", "Carousel", "Reel", "Image", "Reel", "Story"]
    : ["Carousel", "Reel", "Image", "Reel", "Carousel", "Story"];
  const themes = [
    "Educational tip", "Behind the scenes", "Customer story", "Trend commentary",
    "Product deep-dive", "Myth vs fact", "FAQ answer", "Before/after",
  ];
  let i = 0;
  for (let day = 0; day < days; day++) {
    const dt = new Date(d.getTime() + day * 86400000);
    const dow = dt.getDay();
    if (![1, 2, 4, 5, 6].includes(dow)) continue; // Mon Tue Thu Fri Sat
    plan.push({
      date: dt.toISOString().slice(0, 10),
      format: formats[i % formats.length],
      theme: themes[i % themes.length],
      bestTime: ["09:00", "12:30", "18:00"][i % 3],
      captionHook: "",
    });
    i++;
  }
  return { calendar: plan, generatedBy: "heuristics" };
}

/* --------------------------------- routing --------------------------------- */

async function handleApi(req, env, ctx, url) {
  const path = url.pathname.replace(/^\/api/, "") || "/";
  const method = req.method.toUpperCase();

  /* ---- config ---- */
  if (path === "/config" && method === "GET") {
    return json({
      demo: demoMode(env),
      metaConfigured: !!(env.META_APP_ID && env.META_APP_SECRET),
      aiConfigured: !!env.AI_API_KEY,
      aiModel: env.AI_MODEL || "gpt-4o-mini",
    });
  }

  /* ---- demo shortcut: synthesize a connected account ---- */
  if (path === "/demo/connect" && method === "POST") {
    const { clientId } = await parseBody(req);
    if (!clientId) return err(400, "clientId required");
    await env.DB.prepare(
      `INSERT INTO connections (id, client_id, platform, ig_user_id, page_id, username, page_name, page_url, profile_pic, followers_count, access_token, connected_at)
       VALUES (?1,?2,'instagram',?3,?4,?5,?6,?7,'',?8,'',?9)
       ON CONFLICT(id) DO NOTHING`)
      .bind(uid(), clientId, DEMO_ACCOUNT.ig_user_id, DEMO_ACCOUNT.page_id, DEMO_ACCOUNT.username,
        DEMO_ACCOUNT.page_name, DEMO_ACCOUNT.page_url, DEMO_ACCOUNT.followers_count, now())
      .run();
    return json({ ok: true });
  }

  /* ---- Meta OAuth ---- */
  if (path === "/meta/auth" && method === "GET") {
    if (demoMode(env)) return err(400, "Demo mode: Meta OAuth disabled. Unset DEMO and set META_APP_ID/SECRET.");
    const clientId = url.searchParams.get("clientId");
    if (!clientId) return err(400, "clientId required");
    const state = btoa(JSON.stringify({ clientId, v: 1 }));
    return Response.redirect(metaAuthUrl(env, state), 302);
  }
  if (path === "/meta/callback" && method === "GET") return metaCallback(env, url);

  /* ---- clients ---- */
  if (path === "/clients" && method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM connections n WHERE n.client_id = c.id) AS connections
       FROM clients c ORDER BY c.created_at DESC`).all();
    return json({ clients: results });
  }
  if (path === "/clients" && method === "POST") {
    const { name, industry = "", brand_description = "" } = await parseBody(req);
    if (!name?.trim()) return err(400, "name required");
    const id = uid();
    await env.DB.prepare(
      `INSERT INTO clients (id, name, industry, brand_description, created_at) VALUES (?1,?2,?3,?4,?5)`)
      .bind(id, name.trim(), industry, brand_description, now()).run();
    return json({ id }, 201);
  }
  const clientMatch = path.match(/^\/clients\/([^/]+)(.*)$/);
  if (clientMatch) {
    const [, clientId, rest] = clientMatch;

    /* ---- connections ---- */
    if (rest === "/connections" && method === "GET") {
      const { results } = await env.DB.prepare(
        `SELECT id, client_id, platform, ig_user_id, username, page_name, page_url, profile_pic, followers_count, connected_at
         FROM connections WHERE client_id = ?1 ORDER BY connected_at DESC`).bind(clientId).all();
      return json({ connections: results });
    }
    if (rest === "/connections" && method === "DELETE") {
      const { connectionId } = await parseBody(req);
      await env.DB.prepare(`DELETE FROM connections WHERE id = ?1 AND client_id = ?2`).bind(connectionId, clientId).run();
      return json({ ok: true });
    }

    /* ---- audit ---- */
    if (rest === "/audit" && method === "POST") {
      const { igUserId } = await parseBody(req);
      const conn = await env.DB.prepare(
        `SELECT * FROM connections WHERE client_id = ?1 ${igUserId ? "AND ig_user_id = ?2" : ""} ORDER BY connected_at DESC LIMIT 1`)
        .bind(...(igUserId ? [clientId, igUserId] : [clientId])).first();
      if (!conn) return err(404, "No connected account for this client. Connect Instagram first.");
      let metrics;
      if (demoMode(env) || conn.platform === "demo") metrics = demoMetrics();
      else {
        try { metrics = await fetchLiveMetrics(env, conn); }
        catch (e) { return err(502, `Meta API error: ${e.message}`); }
      }
      const scored = scoreAudit(metrics);
      const auditId = uid();
      await env.DB.prepare(
        `INSERT INTO audits (id, client_id, connection_id, ig_user_id, created_at, status, metrics, scores)
         VALUES (?1,?2,?3,?4,?5,'ok',?6,?7)`)
        .bind(auditId, clientId, conn.id, conn.ig_user_id, now(), JSON.stringify(metrics), JSON.stringify(scored)).run();
      return json({ auditId, metrics, ...scored });
    }

    /* ---- suggestions ---- */
    if (rest === "/suggestions" && method === "POST") {
      const audit = await latestAudit(env, clientId);
      if (!audit) return err(404, "Run an audit first.");
      const fallback = heuristicSuggestions(audit.metrics, audit.scores);
      const out = await aiJson(env,
        "You are a senior social media strategist. Return ONLY a JSON object with keys: summary (string, 2 sentences), strengths (array of strings), improvements (array of 5 concrete strings), contentIdeas (array of 6 objects with title, format, rationale). Be specific to the metrics provided; no filler.",
        JSON.stringify({ scores: audit.scores.scores, summary: audit.scores.summary, biography: audit.metrics.profile?.biography }),
        fallback);
      return json(out);
    }

    /* ---- calendar ---- */
    if (rest === "/calendar" && method === "POST") {
      const { days = 30 } = await parseBody(req);
      const audit = await latestAudit(env, clientId);
      if (!audit) return err(404, "Run an audit first.");
      const fallback = calendarFallback(audit.scores, days);
      const today = new Date().toISOString().slice(0, 10);
      const out = await aiJson(env,
        `You are a social media planner. Return ONLY a JSON object with key "calendar": an array of ${days >= 30 ? 14 : 7} objects, each with date (YYYY-MM-DD starting ${today}, posting on Mon/Tue/Thu/Fri/Sat only, no two consecutive), format (Reel/Carousel/Image/Story), theme (short topic), bestTime (HH:MM), captionHook (one line opening hook for the caption). Optimize for the account's weak scores.`,
        JSON.stringify({ scores: audit.scores.scores, summary: audit.scores.summary, brand: audit.metrics.profile?.name }),
        fallback);
      return json(out);
    }

    /* ---- latest audit ---- */
    if (rest === "/audit/latest" && method === "GET") {
      const audit = await latestAudit(env, clientId);
      if (!audit) return json({ audit: null });
      return json({ audit });
    }

    /* ---- delete client ---- */
    if (rest === "" && method === "DELETE") {
      await env.DB.prepare(`DELETE FROM connections WHERE client_id = ?1`).bind(clientId).run();
      await env.DB.prepare(`DELETE FROM audits WHERE client_id = ?1`).bind(clientId).run();
      await env.DB.prepare(`DELETE FROM clients WHERE id = ?1`).bind(clientId).run();
      return json({ ok: true });
    }
  }

  /* ---- audit by link ---- */
  if (path === "/audit-by-link" && method === "POST") {
    const { url: profileUrl } = await parseBody(req);
    if (!profileUrl) return err(400, "url required");
    const parsed = parseSocialUrl(profileUrl);
    if (!parsed) return err(400, "Unrecognized link. Paste an instagram.com/<handle> or facebook.com/<page> URL.");
    const conn = await env.DB.prepare(
      `SELECT * FROM connections WHERE lower(username) = lower(?1) OR lower(page_name) = lower(?2) OR page_url LIKE ?3 LIMIT 1`)
      .bind(parsed.handle, parsed.handle, `%${parsed.handle}%`).first();
    if (!conn) return err(404, `No connected account matches @${parsed.handle} — connect it first.`, { notConnected: true, handle: parsed.handle });
    // reuse audit path
    const clientId = conn.client_id;
    let metrics;
    if (demoMode(env)) metrics = demoMetrics();
    else {
      try { metrics = await fetchLiveMetrics(env, conn); }
      catch (e) { return err(502, `Meta API error: ${e.message}`); }
    }
    const scored = scoreAudit(metrics);
    const auditId = uid();
    await env.DB.prepare(
      `INSERT INTO audits (id, client_id, connection_id, ig_user_id, created_at, status, metrics, scores)
       VALUES (?1,?2,?3,?4,?5,'ok',?6,?7)`)
      .bind(auditId, clientId, conn.id, conn.ig_user_id, now(), JSON.stringify(metrics), JSON.stringify(scored)).run();
    return json({ auditId, clientId, resolved: { username: conn.username, page_name: conn.page_name }, metrics, ...scored });
  }

  return err(404, "Not found");
}

async function latestAudit(env, clientId) {
  const row = await env.DB.prepare(
    `SELECT id, created_at, metrics, scores FROM audits WHERE client_id = ?1 ORDER BY created_at DESC LIMIT 1`)
    .bind(clientId).first();
  if (!row) return null;
  return { id: row.id, created_at: row.created_at, metrics: JSON.parse(row.metrics), scores: JSON.parse(row.scores) };
}

function parseSocialUrl(input) {
  const s = String(input || "").trim();
  const ig = s.match(/(?:instagram\.com|instagr\.am)\/(?:@)?([A-Za-z0-9_.]+)/i);
  if (ig) return { platform: "instagram", handle: ig[1] };
  const fb = s.match(/facebook\.com\/(?:pages\/[^/]+\/|@)?([A-Za-z0-9_.-]+)/i) ||
             s.match(/fb\.com\/([A-Za-z0-9_.-]+)/i);
  if (fb) return { platform: "facebook", handle: fb[1] };
  if (/^@?([A-Za-z0-9_.]{2,30})$/.test(s)) return { platform: "instagram", handle: s.replace(/^@/, "") };
  return null;
}

/* Lazy schema init: creates tables on first DB use (works locally and on deploy). */
let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  try { await env.DB.prepare("SELECT 1 FROM clients LIMIT 1").first(); }
  catch {
    for (const stmt of schemaSql().split(";").map((s) => s.trim()).filter(Boolean)) {
      await env.DB.prepare(stmt).run();
    }
  }
  schemaReady = true;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    try {
      if (url.pathname.startsWith("/api/")) {
        await ensureSchema(env);
        if (req.method === "OPTIONS") {
          return new Response(null, { headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,DELETE,OPTIONS", "access-control-allow-headers": "content-type" } });
        }
        const res = await handleApi(req, env, ctx, url);
        const cors = new Response(res.body, res);
        cors.headers.set("access-control-allow-origin", "*");
        return cors;
      }
      return env.ASSETS.fetch(req);
    } catch (e) {
      console.error(e);
      return err(500, `Server error: ${e.message}`);
    }
  },

  async scheduled(_event, env) {
    // initialize schema on first cron run (also run by `wrangler d1 execute` in CI)
    await env.DB.exec(schemaSql());
  },
};

function schemaSql() {
  return `CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, industry TEXT DEFAULT '', brand_description TEXT DEFAULT '', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, platform TEXT NOT NULL DEFAULT 'instagram',
  ig_user_id TEXT, page_id TEXT, username TEXT DEFAULT '', page_name TEXT DEFAULT '', page_url TEXT DEFAULT '',
  profile_pic TEXT DEFAULT '', followers_count INTEGER DEFAULT 0, access_token TEXT DEFAULT '', connected_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audits (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, connection_id TEXT, ig_user_id TEXT, created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'ok', metrics TEXT NOT NULL DEFAULT '{}', scores TEXT NOT NULL DEFAULT '{}');
CREATE INDEX IF NOT EXISTS idx_connections_client ON connections(client_id);
CREATE INDEX IF NOT EXISTS idx_audits_client ON audits(client_id, created_at DESC);`;
}
