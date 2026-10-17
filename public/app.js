/* SocialAudit frontend */
const $ = (id) => document.getElementById(id);
const $$ = (sel) => document.querySelectorAll(sel);

const api = async (path, opts = {}) => {
  const res = await fetch(`/api${path}`, {
    headers: { "content-type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { data });
  return data;
};

let currentClient = null;
let allClients = [];

/* ------------------------------- Theme Toggle ----------------------------- */
function initTheme() {
  const saved = localStorage.getItem("theme");
  const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  const isLight = saved === "light" || (!saved && !prefersDark && false); // default to dark like portfolio

  applyTheme(isLight ? "light" : "dark");

  $("themeToggle")?.addEventListener("click", () => {
    const isNowLight = document.documentElement.classList.toggle("light");
    const mode = isNowLight ? "light" : "dark";
    localStorage.setItem("theme", mode);
    updateThemeIcons(isNowLight);
  });
}

function applyTheme(mode) {
  const isLight = mode === "light";
  document.documentElement.classList.toggle("light", isLight);
  updateThemeIcons(isLight);
}

function updateThemeIcons(isLight) {
  const sun = $("themeIconSun");
  const moon = $("themeIconMoon");
  if (sun && moon) {
    if (isLight) {
      sun.classList.add("hidden");
      moon.classList.remove("hidden");
    } else {
      sun.classList.remove("hidden");
      moon.classList.add("hidden");
    }
  }
}

/* ------------------------------- Notifications ---------------------------- */
const toast = (msg, isError = false) => {
  const t = $("toast");
  t.textContent = msg;
  t.className = `toast${isError ? " error" : ""}`;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add("hidden"), 4500);
};

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const fmtDate = (ts) => new Date(ts).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/* ------------------------------- Boot ------------------------------------- */
async function boot() {
  initTheme();
  setupSampleChips();
  setupSearch();
  setupPrint();

  try {
    const cfg = await api("/config");
    if (cfg.demo) $("demoBadge").classList.remove("hidden");
    if (cfg.aiConfigured) {
      $("aiBadge").innerHTML = `<span style="width:6px;height:6px;border-radius:50%;background:var(--accent-emerald)"></span>AI: ${esc(cfg.aiModel)}`;
      $("aiBadge").classList.remove("hidden");
    }
  } catch (e) {
    toast(`Config status: ${e.message}`, true);
  }
  await loadClients();
}

/* ------------------------------- Clients Roster --------------------------- */
async function loadClients() {
  const { clients } = await api("/clients");
  allClients = clients || [];
  renderClientList(allClients);
}

function renderClientList(clients) {
  const list = $("clientList");
  if (!clients.length) {
    list.innerHTML = `<li class="muted" style="border:none;background:none;padding:12px 0">No clients found. Add a client or run an audit above.</li>`;
    return;
  }
  list.innerHTML = clients.map((c) => `
    <li data-id="${c.id}">
      <div>
        <strong>${esc(c.name)}</strong>
        ${c.industry ? `<span class="tag" style="margin-left:8px">${esc(c.industry)}</span>` : ""}
        <div class="muted" style="font-size:12px;margin-top:2px">${c.connections || 0} account(s) connected</div>
      </div>
      <span class="muted" style="font-family:var(--font-mono);font-size:12px">OPEN ↗</span>
    </li>`).join("");

  list.querySelectorAll("li[data-id]").forEach((li) =>
    li.addEventListener("click", () => openClient(allClients.find((c) => c.id === li.dataset.id))));
}

function setupSearch() {
  const search = $("clientSearch");
  if (!search) return;
  search.addEventListener("input", (e) => {
    const query = e.target.value.toLowerCase().trim();
    if (!query) {
      renderClientList(allClients);
      return;
    }
    const filtered = allClients.filter(c =>
      (c.name || "").toLowerCase().includes(query) ||
      (c.industry || "").toLowerCase().includes(query) ||
      (c.brand_description || "").toLowerCase().includes(query)
    );
    renderClientList(filtered);
  });
}

$("addClientBtn").addEventListener("click", () => $("clientForm").classList.toggle("hidden"));
$("cancelClient").addEventListener("click", () => $("clientForm").classList.add("hidden"));
$("clientForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/clients", {
      method: "POST",
      body: {
        name: $("clientName").value,
        industry: $("clientIndustry").value,
        brand_description: $("clientBrand").value
      }
    });
    $("clientForm").reset();
    $("clientForm").classList.add("hidden");
    await loadClients();
    toast("Client added to roster");
  } catch (err) {
    toast(err.message, true);
  }
});

/* ------------------------------- Client Detail ---------------------------- */
async function openClient(c) {
  if (!c) return;
  currentClient = c;
  $("detail").classList.remove("hidden");
  $("detailName").textContent = c.name;
  $("detailMeta").textContent = [c.industry, c.brand_description].filter(Boolean).join(" · ") || "Social Media Client Profile";
  $("suggestionsCard").classList.add("hidden");
  $("calendarCard").classList.add("hidden");
  $("auditArea").innerHTML = `<p class="muted">Loading latest audit data…</p>`;
  await loadConnections();

  try {
    const { audit } = await api(`/clients/${c.id}/audit/latest`);
    if (audit) {
      renderAudit(audit.scores, audit.metrics, audit.created_at);
    } else {
      $("auditArea").innerHTML = `<p class="muted">No audits recorded yet for this client. Click "Run Audit" above.</p>`;
    }
  } catch {
    $("auditArea").innerHTML = `<p class="muted">Ready to audit. Click "Run Audit" to begin.</p>`;
  }

  $("detail").scrollIntoView({ behavior: "smooth" });
}

async function loadConnections() {
  if (!currentClient) return;
  const { connections } = await api(`/clients/${currentClient.id}/connections`);
  const list = $("connList");
  if (!connections || !connections.length) {
    list.innerHTML = `<li class="muted" style="border:none;background:none;padding:8px 0">No channels connected yet.</li>`;
    return;
  }
  list.innerHTML = connections.map((cn) => `
    <li>
      <div class="conn-left">
        ${cn.profile_pic ? `<img class="avatar" src="${esc(cn.profile_pic)}" alt="">` : `<span class="avatar" style="display:flex;align-items:center;justify-content:center">◉</span>`}
        <div>
          <strong style="font-size:15px">@${esc(cn.username || cn.ig_user_id)}</strong>
          ${cn.page_name ? `<div class="muted" style="font-size:12px">${esc(cn.page_name)} (${esc(cn.platform || "instagram")})</div>` : ""}
          <div class="muted" style="font-size:12px">${(cn.followers_count || 0).toLocaleString()} followers · linked ${fmtDate(cn.connected_at)}</div>
        </div>
      </div>
      <button class="danger" data-id="${cn.id}" style="padding:6px 14px;font-size:10px">Remove</button>
    </li>`).join("");

  list.querySelectorAll("button[data-id]").forEach((b) =>
    b.addEventListener("click", async () => {
      await api(`/clients/${currentClient.id}/connections`, { method: "DELETE", body: { connectionId: b.dataset.id } });
      await loadConnections();
      toast("Connection removed");
    }));
}

/* ------------------------------- Connect via OAuth ------------------------ */
$("connectBtn").addEventListener("click", async () => {
  if (!currentClient) return;
  try {
    const cfg = await api("/config");
    if (cfg.demo) {
      await api("/demo/connect", { method: "POST", body: { clientId: currentClient.id } });
      await loadConnections();
      toast("Demo social account attached.");
      return;
    }
    const w = 520, h = 640;
    const left = screen.width / 2 - w / 2, top = screen.height / 2 - h / 2;
    const popup = open(`/api/meta/auth?clientId=${currentClient.id}`, "meta-oauth", `width=${w},height=${h},left=${left},top=${top}`);
    const onMsg = async (ev) => {
      if (ev.data?.type !== "meta-connected") return;
      window.removeEventListener("message", onMsg);
      popup?.close();
      if (ev.data.error) return toast(ev.data.error, true);
      toast(`${ev.data.count} account(s) connected`);
      await loadConnections();
    };
    window.addEventListener("message", onMsg);
  } catch (e) {
    toast(e.message, true);
  }
});

$("deleteClientBtn").addEventListener("click", async () => {
  if (!confirm(`Delete client "${currentClient?.name}" and all associated audits?`)) return;
  await api(`/clients/${currentClient.id}`, { method: "DELETE" });
  $("detail").classList.add("hidden");
  currentClient = null;
  await loadClients();
  toast("Client removed from roster");
});

/* ------------------------------- Audit Execution -------------------------- */
$("runAuditBtn").addEventListener("click", async () => {
  if (!currentClient) return;
  $("auditArea").innerHTML = `<p class="muted">Scoring account performance metrics…</p>`;
  try {
    const data = await api(`/clients/${currentClient.id}/audit`, { method: "POST", body: {} });
    renderAudit(data, data.metrics, Date.now());
    toast("Audit calculation complete");
  } catch (e) {
    $("auditArea").innerHTML = `<p class="muted" style="color:var(--accent-danger)">Audit failed: ${esc(e.message)}</p>`;
    toast(e.message, true);
  }
});

function renderAudit(scores, metrics, createdAt) {
  const s = scores.scores || scores, sum = scores.summary || scores;
  const scoreCard = (key, label) => `
    <div class="score">
      <div class="val">${s[key] ?? 0}</div>
      <div class="lbl">${label}</div>
      <div class="meter"><span style="width:${Math.min(100, Math.max(0, s[key] || 0))}%"></span></div>
    </div>`;

  const metric = (k, v) => `<div class="metric"><div class="k">${k}</div><div class="v">${v}</div></div>`;
  const recent = (metrics.media || []).slice(0, 8);
  const avatar = metrics.profile?.profile_picture_url
    ? `<img class="avatar" src="${esc(metrics.profile.profile_picture_url)}" style="width:52px;height:52px;border-radius:50%;object-fit:cover" alt="">`
    : `<span class="avatar" style="width:52px;height:52px;font-size:22px;display:flex;align-items:center;justify-content:center;background:var(--surface-hover);border-radius:50%">◉</span>`;

  $("auditArea").innerHTML = `
    <div style="display:flex;align-items:center;gap:16px;margin-bottom:20px;padding:12px;background:var(--surface-glass);border-radius:16px;border:1px solid var(--border)">
      ${avatar}
      <div style="flex:1">
        <div style="font-size:18px;font-weight:700">${esc(metrics.profile?.name || metrics.profile?.username || "")} <span class="muted" style="font-weight:normal;font-size:14px">(@${esc(metrics.profile?.username || "?")})</span></div>
        ${metrics.profile?.biography ? `<div class="muted" style="font-size:13px;margin-top:3px;max-width:700px">${esc(metrics.profile.biography)}</div>` : ""}
        <div class="muted" style="font-size:11px;margin-top:5px;font-family:var(--font-mono)">AUDITED ${fmtDate(createdAt)}${metrics.isPublicScrape ? ' · <span class="tag">LIVE PROFILE CRAWL</span>' : (metrics.demo ? ' · <span class="tag">DEMO DATASET</span>' : "")}</div>
      </div>
    </div>

    <div class="scores">
      ${scoreCard("overall", "Overall")}
      ${scoreCard("engagement", "Engagement")}
      ${scoreCard("consistency", "Consistency")}
      ${scoreCard("contentMix", "Content Mix")}
      ${scoreCard("reach", "Reach Trend")}
      ${scoreCard("valueSignals", "Saves & Shares")}
    </div>

    <div class="metrics-grid">
      ${metric("Audited Followers", (sum.followers || 0).toLocaleString())}
      ${metric("Engagement Rate", `${sum.erPct || 0}%`)}
      ${metric("Size Benchmark", `${sum.benchmarkErPct || 0}%`)}
      ${metric("Posting Cadence", `${sum.postsPerWeek || 0} / wk`)}
      ${metric("Reach Trend (14d)", `${(sum.reachTrendPct || 0) > 0 ? "+" : ""}${sum.reachTrendPct || 0}%`)}
      ${metric("Saves Rate", `${sum.savesRatePct || 0}%`)}
      ${metric("Shares Rate", `${sum.sharesRatePct || 0}%`)}
      ${metric("Posts Analyzed", sum.mediaCount || recent.length || 0)}
    </div>

    <h3>Content Format Distribution</h3>
    <div class="row" style="margin-bottom:20px">${(sum.mix || []).map((m) => `<span class="tag" style="padding:6px 14px;font-size:11px;font-weight:600">${esc(m.type)} — ${m.pct}%</span>`).join("")}</div>

    <h3>Recent Media Breakdown</h3>
    <table class="cal">
      <thead>
        <tr>
          <th>Date</th>
          <th>Format</th>
          <th>Likes</th>
          <th>Comments</th>
          <th>Saves</th>
          <th>Shares</th>
          <th>Est. Reach</th>
        </tr>
      </thead>
      <tbody>
        ${recent.map((m) => `<tr>
          <td style="font-family:var(--font-mono);font-size:12px">${new Date(m.timestamp).toLocaleDateString()}</td>
          <td><span class="tag">${esc(m.media_type)}</span></td>
          <td style="font-family:var(--font-mono);font-weight:600">${(m.insights?.likes || m.like_count || 0).toLocaleString()}</td>
          <td style="font-family:var(--font-mono)">${(m.insights?.comments || m.comments_count || 0).toLocaleString()}</td>
          <td style="font-family:var(--font-mono);color:var(--accent-blue)">${(m.insights?.saved || 0).toLocaleString()}</td>
          <td style="font-family:var(--font-mono);color:var(--accent-emerald)">${(m.insights?.shares || 0).toLocaleString()}</td>
          <td style="font-family:var(--font-mono)">${(m.insights?.reach || "—").toLocaleString()}</td>
        </tr>`).join("")}
      </tbody>
    </table>`;
}

/* ------------------------------- Strategic Suggestions -------------------- */
$("suggestionsBtn").addEventListener("click", async () => {
  if (!currentClient) return;
  $("suggestionsCard").classList.remove("hidden");
  $("suggestionsArea").innerHTML = `<p class="muted">Synthesizing strategic recommendations…</p>`;
  try {
    const s = await api(`/clients/${currentClient.id}/suggestions`, { method: "POST", body: {} });
    $("suggestionsArea").innerHTML = `
      <p style="font-size:15px;line-height:1.6;margin-bottom:16px">${esc(s.summary)}</p>
      <div style="margin-bottom:18px"><span class="tag">${s.generatedBy === "ai" ? "Generated by OpenAI Engine" : "Generated by Heuristic Engine"}</span></div>
      ${s.strengths?.length ? `<h3>Core Strengths</h3><ul class="bullets">${s.strengths.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
      ${s.improvements?.length ? `<h3>Actionable Levers</h3><ul class="bullets">${s.improvements.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
      ${s.contentIdeas?.length ? `<h3>High-Impact Content Angles</h3>${s.contentIdeas.map((i) => `
        <div class="idea">
          <span class="fmt">${esc(i.format)}</span> — <strong style="font-size:14px">${esc(i.title)}</strong>
          <div class="muted" style="font-size:13px;margin-top:4px">${esc(i.rationale)}</div>
        </div>`).join("")}` : ""}`;
    $("suggestionsCard").scrollIntoView({ behavior: "smooth" });
  } catch (e) {
    $("suggestionsArea").innerHTML = `<p class="muted" style="color:var(--accent-danger)">${esc(e.message)}</p>`;
  }
});

/* ------------------------------- 30-Day Content Calendar ------------------ */
$("calendarBtn").addEventListener("click", async () => {
  if (!currentClient) return;
  $("calendarCard").classList.remove("hidden");
  $("calendarArea").innerHTML = `<p class="muted">Generating tailored 30-day content calendar…</p>`;
  try {
    const c = await api(`/clients/${currentClient.id}/calendar`, { method: "POST", body: { days: 30 } });
    $("calendarArea").innerHTML = `
      <div style="margin-bottom:14px"><span class="tag">${c.generatedBy === "ai" ? "OpenAI Schedule Engine" : "Heuristic Cadence Planner"}</span></div>
      <table class="cal">
        <thead>
          <tr>
            <th>Date</th>
            <th>Format</th>
            <th>Theme</th>
            <th>Optimal Window</th>
            <th>Caption Hook</th>
          </tr>
        </thead>
        <tbody>
          ${(c.calendar || []).map((d) => `<tr>
            <td style="font-family:var(--font-mono);font-size:12px;white-space:nowrap">${d.date}</td>
            <td><span class="tag">${esc(d.format)}</span></td>
            <td><strong>${esc(d.theme)}</strong></td>
            <td style="font-family:var(--font-mono);font-size:12px;color:var(--accent-blue)">${esc(d.bestTime)}</td>
            <td style="font-size:13px;color:var(--text-muted)">“${esc(d.captionHook || "")}”</td>
          </tr>`).join("")}
        </tbody>
      </table>`;
    $("calendarCard").scrollIntoView({ behavior: "smooth" });
  } catch (e) {
    $("calendarArea").innerHTML = `<p class="muted" style="color:var(--accent-danger)">${esc(e.message)}</p>`;
  }
});

/* ------------------------------- Quick Audit by Link ---------------------- */
$("linkForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = $("linkInput").value.trim();
  if (!url) return;

  $("linkResult").innerHTML = `<p class="muted" style="font-family:var(--font-mono);font-size:12px">● Resolving and auditing ${esc(url)}…</p>`;
  try {
    const data = await api("/audit-by-link", { method: "POST", body: { url } });
    const username = data.resolved?.username || "";
    $("linkResult").innerHTML = `<p style="color:var(--accent-emerald);font-family:var(--font-mono);font-size:12px">✓ Audited @${esc(username)} successfully!</p>`;

    await loadClients();
    currentClient = {
      id: data.clientId,
      name: data.resolved?.page_name || `@${username}`,
      industry: "Marketing / Agency",
      brand_description: data.metrics?.profile?.biography || "",
    };

    $("detail").classList.remove("hidden");
    $("detailName").textContent = currentClient.name;
    $("detailMeta").textContent = `@${username} · Audited Profile`;
    $("suggestionsCard").classList.add("hidden");
    $("calendarCard").classList.add("hidden");
    await loadConnections();
    renderAudit(data, data.metrics, Date.now());
    $("detail").scrollIntoView({ behavior: "smooth" });
    toast(`Audited @${username} successfully!`);
  } catch (err) {
    $("linkResult").innerHTML = `<p class="muted" style="color:var(--accent-danger);font-family:var(--font-mono);font-size:12px">Audit error: ${esc(err.message)}</p>`;
    toast(err.message, true);
  }
});

/* ------------------------------- Quick Sample Chips ----------------------- */
function setupSampleChips() {
  $$(".sample-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      const sample = btn.dataset.sample;
      if (sample) {
        $("linkInput").value = sample;
        $("linkForm").requestSubmit();
      }
    });
  });
}

/* ------------------------------- Export / Print --------------------------- */
function setupPrint() {
  $("printBtn")?.addEventListener("click", () => {
    window.print();
  });
}

boot();
