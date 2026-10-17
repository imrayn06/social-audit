/* SocialAudit frontend */
const $ = (id) => document.getElementById(id);
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

/* ------------------------------- boot ------------------------------------ */
async function boot() {
  try {
    const cfg = await api("/config");
    if (cfg.demo) $("demoBadge").classList.remove("hidden");
    if (cfg.aiConfigured) {
      $("aiBadge").textContent = `AI: ${cfg.aiModel}`;
      $("aiBadge").classList.remove("hidden");
    }
  } catch (e) { toast(`Failed to load config: ${e.message}`, true); }
  await loadClients();
}

async function loadClients() {
  const { clients } = await api("/clients");
  const list = $("clientList");
  if (!clients.length) {
    list.innerHTML = `<li class="muted" style="border:none;background:none">No clients yet — add your first client.</li>`;
    return;
  }
  list.innerHTML = clients.map((c) => `
    <li data-id="${c.id}">
      <div>
        <strong>${esc(c.name)}</strong>
        ${c.industry ? `<span class="tag">${esc(c.industry)}</span>` : ""}
        <div class="muted" style="font-size:12px">${c.connections} account(s) connected</div>
      </div>
      <span class="muted">open →</span>
    </li>`).join("");
  list.querySelectorAll("li[data-id]").forEach((li) =>
    li.addEventListener("click", () => openClient(clients.find((c) => c.id === li.dataset.id))));
}

/* ------------------------------ clients ----------------------------------- */
$("addClientBtn").addEventListener("click", () => $("clientForm").classList.toggle("hidden"));
$("cancelClient").addEventListener("click", () => $("clientForm").classList.add("hidden"));
$("clientForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/clients", { method: "POST", body: {
      name: $("clientName").value, industry: $("clientIndustry").value, brand_description: $("clientBrand").value } });
    $("clientForm").reset();
    $("clientForm").classList.add("hidden");
    await loadClients();
    toast("Client added");
  } catch (err) { toast(err.message, true); }
});

async function openClient(c) {
  currentClient = c;
  $("detail").classList.remove("hidden");
  $("detailName").textContent = c.name;
  $("detailMeta").textContent = [c.industry, c.brand_description].filter(Boolean).join(" — ") || "No brand description";
  $("suggestionsCard").classList.add("hidden");
  $("calendarCard").classList.add("hidden");
  $("auditArea").innerHTML = `<p class="muted">Run an audit to score the account.</p>`;
  await loadConnections();
  const { audit } = await api(`/clients/${c.id}/audit/latest`);
  if (audit) renderAudit(audit.scores, audit.metrics, audit.created_at);
  $("detail").scrollIntoView({ behavior: "smooth" });
}

async function loadConnections() {
  const { connections } = await api(`/clients/${currentClient.id}/connections`);
  const list = $("connList");
  if (!connections.length) {
    list.innerHTML = `<li class="muted" style="border:none;background:none">No accounts connected yet.</li>`;
    return;
  }
  list.innerHTML = connections.map((cn) => `
    <li>
      <div class="conn-left">
        ${cn.profile_pic ? `<img class="avatar" src="${esc(cn.profile_pic)}" alt="">` : `<span class="avatar"></span>`}
        <div>
          <strong>@${esc(cn.username || cn.ig_user_id)}</strong>
          ${cn.page_name ? `<div class="muted" style="font-size:12px">Page: ${esc(cn.page_name)}</div>` : ""}
          <div class="muted" style="font-size:12px">${cn.followers_count?.toLocaleString?.() ?? 0} followers · connected ${fmtDate(cn.connected_at)}</div>
        </div>
      </div>
      <button class="danger ghost" data-id="${cn.id}">Remove</button>
    </li>`).join("");
  list.querySelectorAll("button[data-id]").forEach((b) =>
    b.addEventListener("click", async () => {
      await api(`/clients/${currentClient.id}/connections`, { method: "DELETE", body: { connectionId: b.dataset.id } });
      await loadConnections();
    }));
}

/* --------------------------- connect via OAuth ---------------------------- */
$("connectBtn").addEventListener("click", async () => {
  try {
    const cfg = await api("/config");
    if (cfg.demo) {
      await api("/demo/connect", { method: "POST", body: { clientId: currentClient.id } });
      await loadConnections();
      toast("Demo account connected — run the audit.");
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
  } catch (e) { toast(e.message, true); }
});

$("deleteClientBtn").addEventListener("click", async () => {
  if (!confirm(`Delete client "${currentClient?.name}" and all their data?`)) return;
  await api(`/clients/${currentClient.id}`, { method: "DELETE" });
  $("detail").classList.add("hidden");
  currentClient = null;
  await loadClients();
  toast("Client deleted");
});

/* -------------------------------- audit ----------------------------------- */
$("runAuditBtn").addEventListener("click", async () => {
  $("auditArea").innerHTML = `<p class="muted">Fetching insights… (media-by-media, can take ~30s for large accounts)</p>`;
  try {
    const data = await api(`/clients/${currentClient.id}/audit`, { method: "POST", body: {} });
    renderAudit(data, data.metrics, Date.now());
    toast("Audit complete");
  } catch (e) { $("auditArea").innerHTML = `<p class="muted">Audit failed: ${esc(e.message)}</p>`; toast(e.message, true); }
});

function renderAudit(scores, metrics, createdAt) {
  const s = scores.scores, sum = scores.summary;
  const scoreCard = (key, label) => `
    <div class="score">
      <div class="val">${s[key]}</div>
      <div class="lbl">${label}</div>
      <div class="meter"><span style="width:${s[key]}%"></span></div>
    </div>`;
  const metric = (k, v) => `<div class="metric"><div class="k">${k}</div><div class="v">${v}</div></div>`;
  const recent = (metrics.media || []).slice(0, 6);
  const avatar = metrics.profile?.profile_picture_url
    ? `<img class="avatar" src="${esc(metrics.profile.profile_picture_url)}" style="width:48px;height:48px;border-radius:50%;object-fit:cover" alt="">`
    : `<span class="avatar" style="width:48px;height:48px;font-size:20px;display:flex;align-items:center;justify-content:center;background:#2d3748;border-radius:50%">◉</span>`;

  $("auditArea").innerHTML = `
    <div style="display:flex;align-items:center;gap:14px;margin-bottom:16px;padding:8px 0">
      ${avatar}
      <div>
        <div style="font-size:17px;font-weight:600">${esc(metrics.profile?.name || metrics.profile?.username || "")} <span class="muted" style="font-weight:normal">(@${esc(metrics.profile?.username || "?")})</span></div>
        ${metrics.profile?.biography ? `<div class="muted" style="font-size:12px;margin-top:2px;max-width:600px">${esc(metrics.profile.biography)}</div>` : ""}
        <div class="muted" style="font-size:12px;margin-top:4px">Audit ${fmtDate(createdAt)}${metrics.isPublicScrape ? ' · <span class="tag">live profile crawl</span>' : (metrics.demo ? ' · <span class="tag">demo data</span>' : "")}</div>
      </div>
    </div>
    <div class="scores">
      ${scoreCard("overall", "Overall")}${scoreCard("engagement", "Engagement")}
      ${scoreCard("consistency", "Consistency")}${scoreCard("contentMix", "Content mix")}
      ${scoreCard("reach", "Reach")}${scoreCard("valueSignals", "Saves & shares")}
    </div>
    <div class="metrics-grid">
      ${metric("Followers", (sum.followers || 0).toLocaleString())}
      ${metric("Engagement rate", `${sum.erPct}%`)}
      ${metric("Peer benchmark", `${sum.benchmarkErPct}%`)}
      ${metric("Posts / week", sum.postsPerWeek)}
      ${metric("Reach trend (14d)", `${sum.reachTrendPct > 0 ? "+" : ""}${sum.reachTrendPct}%`)}
      ${metric("Saves rate", `${sum.savesRatePct}%`)}
      ${metric("Shares rate", `${sum.sharesRatePct}%`)}
      ${metric("Posts analyzed", sum.mediaCount)}
    </div>
    <h3>Content mix</h3>
    <div class="row">${(sum.mix || []).map((m) => `<span class="tag">${esc(m.type)} ${m.pct}%</span>`).join("")}</div>
    <h3>Recent posts</h3>
    <table class="cal"><thead><tr><th>Date</th><th>Type</th><th>Likes</th><th>Comments</th><th>Saves</th><th>Shares</th><th>Reach</th></tr></thead>
    <tbody>${recent.map((m) => `<tr>
      <td>${new Date(m.timestamp).toLocaleDateString()}</td><td>${esc(m.media_type)}</td>
      <td>${m.insights.likes}</td><td>${m.insights.comments}</td><td>${m.insights.saved}</td>
      <td>${m.insights.shares}</td><td>${m.insights.reach || "—"}</td></tr>`).join("")}</tbody></table>`;
}

/* ----------------------------- suggestions -------------------------------- */
$("suggestionsBtn").addEventListener("click", async () => {
  $("suggestionsCard").classList.remove("hidden");
  $("suggestionsArea").innerHTML = `<p class="muted">Analyzing metrics…</p>`;
  try {
    const s = await api(`/clients/${currentClient.id}/suggestions`, { method: "POST", body: {} });
    $("suggestionsArea").innerHTML = `
      <p>${esc(s.summary)}</p>
      <span class="tag">generated by ${s.generatedBy === "ai" ? "AI" : "heuristics (no AI key set)"}</span>
      ${s.strengths?.length ? `<h3>Strengths</h3><ul class="bullets">${s.strengths.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
      ${s.improvements?.length ? `<h3>Improvements</h3><ul class="bullets">${s.improvements.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
      ${s.contentIdeas?.length ? `<h3>Content ideas</h3>${s.contentIdeas.map((i) => `
        <div class="idea"><span class="fmt">${esc(i.format)}</span> — <strong>${esc(i.title)}</strong>
        <div class="muted">${esc(i.rationale)}</div></div>`).join("")}` : ""}`;
  } catch (e) { $("suggestionsArea").innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
});

/* ------------------------------- calendar --------------------------------- */
$("calendarBtn").addEventListener("click", async () => {
  $("calendarCard").classList.remove("hidden");
  $("calendarArea").innerHTML = `<p class="muted">Building 30-day plan…</p>`;
  try {
    const c = await api(`/clients/${currentClient.id}/calendar`, { method: "POST", body: { days: 30 } });
    $("calendarArea").innerHTML = `
      <span class="tag">generated by ${c.generatedBy === "ai" ? "AI" : "heuristics (no AI key set)"}</span>
      <table class="cal"><thead><tr><th>Date</th><th>Format</th><th>Theme</th><th>Best time</th><th>Caption hook</th></tr></thead>
      <tbody>${(c.calendar || []).map((d) => `<tr>
        <td>${d.date}</td><td>${esc(d.format)}</td><td>${esc(d.theme)}</td><td>${esc(d.bestTime)}</td>
        <td>${esc(d.captionHook || "")}</td></tr>`).join("")}</tbody></table>`;
  } catch (e) { $("calendarArea").innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
});

/* ---------------------------- audit by link ------------------------------- */
$("linkForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = $("linkInput").value.trim();
  if (!url) return;
  $("linkResult").innerHTML = `<p class="muted">Resolving and auditing ${esc(url)}…</p>`;
  try {
    const data = await api("/audit-by-link", { method: "POST", body: { url } });
    const username = data.resolved?.username || "";
    $("linkResult").innerHTML = `<p style="color:#10b981;font-size:14px;margin-top:6px">✓ Audited @${esc(username)} successfully!</p>`;
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
    $("linkResult").innerHTML = `<p class="muted" style="color:#ef4444;font-size:14px;margin-top:6px">Audit failed: ${esc(err.message)}</p>`;
    toast(err.message, true);
  }
});

boot();
