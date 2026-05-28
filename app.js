(function () {
  const STORAGE_KEY = "fri-portal-demo-store-v2";
  const DEFAULT_BRANDING = {
    portalName: "FRI Portal",
    accentColor: "#e85002",
    logoUrl: "assets/summer-26-logo.png",
    logoPath: "",
  };
  const config = window.FRI_CONFIG || {};
  const state = {
    backend: "demo",
    supabase: null,
    data: null,
    settings: { ...DEFAULT_BRANDING },
    lookupCandidate: null,
    currentProfile: null,
    profileContext: null,
    staffSessionToken: null,
    leadershipUser: null,
    leadershipSection: "dashboard",
    leadershipDetailProfileId: null,
    timer: null,
    searchTerm: "",
    filterStatus: "all",
  };

  const leadershipSections = [
    ["dashboard", "Dashboard"],
    ["staff", "Staff Management"],
    ["contractors", "Contractors"],
    ["activity", "Activity Tracking"],
    ["payouts", "Payouts"],
    ["documents", "Documents"],
    ["reports", "Reports"],
    ["settings", "System Settings"],
  ];

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  document.addEventListener("DOMContentLoaded", bootstrap);

  async function bootstrap() {
    await initSupabase();
    state.data = state.backend === "demo" ? loadStore() : emptyStore();
    await hydrateDemoSecurity();
    await loadPortalBranding();
    applyPortalBranding();
    bindGlobalEvents();
    renderConnectionStatus();
    renderLeadershipNav();
    if (state.backend === "unconfigured") {
      $("#lookupMessage").textContent = "Supabase is not connected. Add the project publishable key in config.js.";
    }
    showScreen("lookupScreen");
    startTimerLoop();
  }

  async function initSupabase() {
    const hasKeys = Boolean(config.supabaseUrl && config.supabasePublishableKey);
    if (config.demoMode) {
      state.backend = "demo";
      return;
    }
    if (!hasKeys) {
      state.backend = "unconfigured";
      return;
    }

    try {
      const module = await import("https://esm.sh/@supabase/supabase-js@2");
      state.supabase = module.createClient(config.supabaseUrl, config.supabasePublishableKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
        },
      });
      state.backend = "supabase";
    } catch (error) {
      console.warn("Supabase client could not be loaded.", error);
      state.backend = "unconfigured";
    }
  }

  function bindGlobalEvents() {
    $("#homeButton").addEventListener("click", () => showLookup());
    $("#staffLookupButton").addEventListener("click", () => showLookup());
    $("#leadershipButton").addEventListener("click", () => showLeadershipLogin());
    $("#profileSignOutButton").addEventListener("click", () => showLookup());
    $("#leadershipSignOutButton").addEventListener("click", leadershipSignOut);
    $("#lookupForm").addEventListener("submit", onLookupSubmit);
    $("#pinForm").addEventListener("submit", onPinSubmit);
    $("#leadershipLoginForm").addEventListener("submit", onLeadershipLogin);
    $("#modalHost").addEventListener("click", (event) => {
      if (event.target.matches("[data-close-modal]")) closeModal();
    });

    document.addEventListener("click", handleActionClick);
    document.addEventListener("change", handleInputChange);
  }

  function startTimerLoop() {
    state.timer = window.setInterval(() => {
      if (state.currentProfile) {
        updateProfileTimer();
      }
    }, 1000);
  }

  function showScreen(screenId) {
    $$(".portal-screen").forEach((screen) => screen.classList.toggle("active", screen.id === screenId));
  }

  function showLookup() {
    state.lookupCandidate = null;
    state.currentProfile = null;
    state.profileContext = null;
    state.staffSessionToken = null;
    $("#usernameSearch").value = "";
    $("#pinInput").value = "";
    $("#pinForm").classList.add("hidden");
    $("#lookupMessage").textContent = "";
    showScreen("lookupScreen");
  }

  function showLeadershipLogin() {
    if (state.leadershipUser) {
      renderLeadership();
      showScreen("leadershipScreen");
      return;
    }
    $("#leadershipLoginMessage").textContent = "";
    showScreen("leadershipLoginScreen");
  }

  async function onLookupSubmit(event) {
    event.preventDefault();
    const username = new FormData(event.currentTarget).get("username").trim();
    const message = $("#lookupMessage");
    message.textContent = "";
    $("#pinForm").classList.add("hidden");
    state.lookupCandidate = null;

    if (!username) return;

    try {
      const profile = await adapter.lookupProfile(username);
      if (!profile) {
        message.textContent = "Profile Not Found";
        return;
      }
      state.lookupCandidate = profile;
      $("#pinForm").classList.remove("hidden");
      $("#pinInput").focus();
    } catch (error) {
      message.textContent = cleanError(error);
    }
  }

  async function onPinSubmit(event) {
    event.preventDefault();
    const pin = new FormData(event.currentTarget).get("pin").trim();
    const message = $("#lookupMessage");
    message.textContent = "";

    if (!state.lookupCandidate) {
      message.textContent = "Profile Not Found";
      return;
    }

    try {
      const result = await adapter.verifyPin(state.lookupCandidate.id, pin);
      if (!result) {
        message.textContent = "Invalid PIN";
        return;
      }
      if (state.backend === "supabase") {
        mergeProfileContext(result.profile, result.context);
      }
      state.currentProfile = result.profile;
      state.profileContext = result.context;
      state.staffSessionToken = result.sessionToken || null;
      renderProfile();
      showScreen("profileScreen");
    } catch (error) {
      message.textContent = cleanError(error);
    }
  }

  async function onLeadershipLogin(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = form.get("email").trim();
    const password = form.get("password");
    const message = $("#leadershipLoginMessage");
    message.textContent = "";

    try {
      const user = await adapter.leadershipLogin(email, password);
      state.leadershipUser = user;
      if (state.backend === "supabase") {
        state.data = await loadSupabaseData();
      }
      renderLeadership();
      showScreen("leadershipScreen");
    } catch (error) {
      message.textContent = cleanError(error);
    }
  }

  async function leadershipSignOut() {
    if (state.backend === "supabase" && state.supabase) {
      await state.supabase.auth.signOut();
    }
    state.leadershipUser = null;
    showLeadershipLogin();
  }

  const adapter = {
    async lookupProfile(identifier) {
      assertBackendReady();
      if (state.backend === "supabase") {
        const { data, error } = await state.supabase.functions.invoke("staff-pin-auth", {
          body: { action: "lookup", identifier },
        });
        if (error) throw error;
        return data && data.found ? data.profile : null;
      }

      const needle = normalize(identifier);
      return (
        state.data.profiles.find((profile) => {
          return normalize(profile.username) === needle || normalize(profile.contractorId || "") === needle;
        }) || null
      );
    },

    async verifyPin(profileId, pin) {
      assertBackendReady();
      if (!/^\d{4}$/.test(pin)) return null;

      if (state.backend === "supabase") {
        const { data, error } = await state.supabase.functions.invoke("staff-pin-auth", {
          body: { action: "verify", profileId, pin },
        });
        if (error) throw error;
        if (!data || !data.authorized) return null;
        return data;
      }

      const profile = getProfile(profileId);
      if (!profile) return null;
      const digest = await pinDigest(pin, profile.pinSalt);
      if (digest !== profile.pinHash) return null;

      logAudit("staff_pin_verified", profile.id, "Staff PIN verified");
      return {
        profile,
        sessionToken: cryptoRandom(),
        context: getProfileContext(profile.id),
      };
    },

    async leadershipLogin(email, password) {
      assertBackendReady();
      if (state.backend === "supabase") {
        const { data, error } = await state.supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        const { data: leadershipProfile, error: profileError } = await state.supabase
          .from("leadership_users")
          .select("*")
          .eq("user_id", data.user.id)
          .single();
        if (profileError || !leadershipProfile) throw new Error("Leadership account not found");
        return { id: data.user.id, email: data.user.email, ...leadershipProfile };
      }

      const digest = await pinDigest(password, state.data.demoLeader.salt);
      if (normalize(email) !== normalize(state.data.demoLeader.email) || digest !== state.data.demoLeader.passwordHash) {
        throw new Error("Invalid leadership credentials");
      }
      logAudit("leadership_login", "leadership", "Leadership dashboard opened");
      return { id: "demo-leader", email, role: "Director", name: "Demo Leadership" };
    },
  };

  function renderProfile() {
    const profile = state.currentProfile;
    const context = state.profileContext || getProfileContext(profile.id);
    state.profileContext = context;
    const active = getActiveSession(profile.id);
    const latestPayment = context.payouts
      .filter((payout) => payout.status === "Complete")
      .sort((a, b) => new Date(b.date) - new Date(a.date))[0];

    $("#profileTitle").textContent = profile.fullName || profile.name;
    $("#profileContent").innerHTML = `
      <div class="profile-grid">
        <aside class="profile-hero">
          ${profile.profilePhoto ? `<img class="profile-photo" src="${escapeAttr(profile.profilePhoto)}" alt="${escapeAttr(profile.fullName)}" />` : `<div class="avatar-fallback">${initials(profile.fullName)}</div>`}
          <div>
            <div class="tag-row">
              ${statusTag(profile.status)}
              <span class="tag">${escapeHtml(profile.employmentType)}</span>
            </div>
            <h2>${escapeHtml(profile.fullName)}</h2>
            <p>@${escapeHtml(profile.username || profile.contractorId)}</p>
            <div class="tag-row">${profile.tags.map((tag) => `<span class="tag orange">${escapeHtml(tag)}</span>`).join("")}</div>
          </div>
        </aside>

        <div class="profile-panels">
          <div class="metric-grid">
            ${metricCard("Total Robux Paid", formatRobux(totalPaid(context.payouts)))}
            ${metricCard("Most Recent Payment", latestPayment ? formatRobux(latestPayment.amount) : "None")}
            ${metricCard("Strike Count", context.strikes.length)}
            ${metricCard("Warning Count", context.warnings.length)}
          </div>

          <section class="card">
            <div class="section-title">
              <h2>Profile Details</h2>
              ${statusTag(profile.activityStatus || "Offline")}
            </div>
            <div class="info-grid">
              ${infoItem("Username", profile.username || profile.contractorId)}
              ${infoItem("Role", profile.role || profile.serviceType)}
              ${infoItem("Department", profile.department || "Contractor")}
              ${infoItem("Employment Type", profile.employmentType)}
              ${infoItem("Join Date", formatDate(profile.joinDate || profile.startDate))}
              ${infoItem("Status", profile.status)}
            </div>
            ${
              profile.notesVisible && profile.notes
                ? `<div class="info-item" style="margin-top:12px"><span class="field-label">Notes from Leadership</span><strong>${escapeHtml(profile.notes)}</strong></div>`
                : ""
            }
          </section>

          <section class="card">
            <div class="section-title">
              <h2>Activity Tracker</h2>
              <div class="tag-row">${statusTag(active ? "Active" : "Offline")}</div>
            </div>
            <div class="activity-status">
              <div>
                <p class="field-label">Active Session Timer</p>
                <div class="timer" id="activeTimer">${active ? elapsed(active.startAt) : "00:00:00"}</div>
              </div>
              <div class="action-row">
                <button class="accent-button" type="button" data-action="start-activity" ${active ? "disabled" : ""}>Start Activity</button>
                <button class="ghost-button" type="button" data-action="end-activity" ${active ? "" : "disabled"}>End Activity</button>
              </div>
            </div>
            <div class="metric-grid" style="margin-top:14px">
              ${metricCard("Current Status", active ? "Active" : "Offline")}
              ${metricCard("Total Time This Week", formatDuration(totalActivity(profile.id, "week")))}
              ${metricCard("Total Time This Month", formatDuration(totalActivity(profile.id, "month")))}
              ${metricCard("Recent Sessions", context.activities.length)}
            </div>
            <div class="timeline" style="margin-top:14px">
              ${recentActivities(profile.id)
                .slice(0, 5)
                .map(
                  (session) => `
                    <div class="timeline-item">
                      <span class="dot"></span>
                      <div><strong>${formatDateTime(session.startAt)}</strong><p>${session.endAt ? formatDateTime(session.endAt) : "Active now"}</p></div>
                      <strong>${session.endAt ? formatDuration(minutesBetween(session.startAt, session.endAt)) : elapsed(session.startAt)}</strong>
                    </div>
                  `,
                )
                .join("") || `<p>No activity sessions yet.</p>`}
            </div>
          </section>

          <section class="card">
            <div class="section-title">
              <h2>Documents & Acknowledgements</h2>
              <span class="tag">${outstandingDocuments(profile.id)} Outstanding</span>
            </div>
            <div class="document-grid">
              ${context.documents.map((doc) => documentCard(doc, profile.id)).join("") || `<p>No assigned documents.</p>`}
            </div>
          </section>

          <section class="card">
            <div class="section-title"><h2>Payout History</h2></div>
            <div class="timeline">
              ${context.payouts
                .map(
                  (payout) => `
                    <div class="timeline-item">
                      <span class="dot"></span>
                      <div><strong>${formatRobux(payout.amount)} Robux</strong><p>${escapeHtml(payout.notes || "External payout tracking")}</p></div>
                      <span class="tag ${payout.status === "Complete" ? "green" : "yellow"}">${escapeHtml(payout.status)}</span>
                    </div>
                  `,
                )
                .join("") || `<p>No payout history.</p>`}
            </div>
          </section>

          <section class="card">
            <div class="section-title"><h2>Warnings & Strikes</h2></div>
            <div class="timeline">
              ${[...context.warnings, ...context.strikes]
                .sort((a, b) => new Date(b.date) - new Date(a.date))
                .map(
                  (entry) => `
                    <div class="timeline-item">
                      <span class="dot"></span>
                      <div><strong>${escapeHtml(entry.type)}: ${escapeHtml(entry.reason)}</strong><p>${escapeHtml(entry.notes || "")}</p></div>
                      <strong>${formatDate(entry.date)}</strong>
                    </div>
                  `,
                )
                .join("") || `<p>No disciplinary history.</p>`}
            </div>
          </section>
        </div>
      </div>
    `;
  }

  function updateProfileTimer() {
    const timer = $("#activeTimer");
    if (!timer || !state.currentProfile) return;
    const active = getActiveSession(state.currentProfile.id);
    timer.textContent = active ? elapsed(active.startAt) : "00:00:00";
  }

  function renderLeadershipNav() {
    $("#leadershipNav").innerHTML = leadershipSections
      .map(
        ([id, label]) =>
          `<button class="nav-button ${id === state.leadershipSection ? "active" : ""}" type="button" data-action="leadership-section" data-section="${id}">${label}</button>`,
      )
      .join("");
  }

  function renderLeadership() {
    renderConnectionStatus();
    renderLeadershipNav();
    $("#leadershipTitle").textContent = leadershipSections.find(([id]) => id === state.leadershipSection)[1];
    const renderers = {
      dashboard: renderDashboard,
      staff: renderStaffManagement,
      contractors: renderContractorManagement,
      activity: renderActivityManagement,
      payouts: renderPayoutManagement,
      documents: renderDocumentsManagement,
      reports: renderReports,
      settings: renderSettings,
    };
    renderers[state.leadershipSection]();
  }

  async function loadPortalBranding() {
    const localBranding = state.data?.settings?.branding || state.data?.settings || {};
    state.settings = normalizeBranding(localBranding);

    if (state.backend !== "supabase" || !state.supabase) return;

    const { data, error } = await state.supabase.from("portal_settings").select("value").eq("key", "branding").maybeSingle();
    if (error) {
      console.warn("Portal branding could not be loaded.", error);
      return;
    }
    if (data?.value) state.settings = normalizeBranding(data.value);
  }

  function applyPortalBranding() {
    const branding = normalizeBranding(state.settings);
    state.settings = branding;
    const root = document.documentElement;
    const accentRgb = hexToRgb(branding.accentColor, "232, 80, 2");
    root.style.setProperty("--orange", branding.accentColor);
    root.style.setProperty("--orange-2", branding.accentColor);
    root.style.setProperty("--line-strong", `rgba(${accentRgb}, 0.42)`);

    document.title = branding.portalName;
    const lookupTitle = $("#lookupTitle");
    if (lookupTitle) lookupTitle.textContent = branding.portalName;
    $$("[data-brand-name], .brand-lockup span").forEach((node) => {
      node.textContent = branding.portalName;
    });
    $$(".brand-lockup img, .hero-logo, .login-brand img, .sidebar img").forEach((image) => {
      image.src = branding.logoUrl;
      image.alt = branding.portalName;
    });
  }

  function normalizeBranding(value = {}) {
    const accentColor = isHexColor(value.accentColor) ? value.accentColor : DEFAULT_BRANDING.accentColor;
    return {
      portalName: String(value.portalName || DEFAULT_BRANDING.portalName).trim() || DEFAULT_BRANDING.portalName,
      accentColor,
      logoUrl: String(value.logoUrl || DEFAULT_BRANDING.logoUrl),
      logoPath: String(value.logoPath || ""),
    };
  }

  function hexToRgb(hex, fallback) {
    const clean = String(hex || "").replace("#", "");
    if (!/^[0-9a-f]{6}$/i.test(clean)) return fallback;
    return `${parseInt(clean.slice(0, 2), 16)}, ${parseInt(clean.slice(2, 4), 16)}, ${parseInt(clean.slice(4, 6), 16)}`;
  }

  function isHexColor(value) {
    return /^#[0-9a-f]{6}$/i.test(String(value || ""));
  }

  function renderConnectionStatus() {
    const labels = {
      supabase: "Supabase Connected",
      demo: "Demo Mode",
      unconfigured: "Supabase Key Missing",
    };
    const label = labels[state.backend] || "Supabase Key Missing";
    const status = $("#connectionStatus");
    if (status) status.textContent = label;
  }

  function assertBackendReady() {
    if (state.backend === "unconfigured") {
      throw new Error("Supabase is not connected. Add the project publishable key in config.js.");
    }
  }

  function renderDashboard() {
    const activeCount = state.data.profiles.filter((profile) => getActiveSession(profile.id)).length;
    const totalWeek = state.data.profiles.reduce((sum, profile) => sum + totalActivity(profile.id, "week"), 0);
    const totalPayouts = state.data.payouts.reduce((sum, payout) => sum + Number(payout.amount || 0), 0);
    const outstanding = state.data.documents.reduce((sum, doc) => sum + uncompletedForDoc(doc.id).length, 0);

    $("#leadershipContent").innerHTML = `
      <div class="dashboard-grid">
        ${metricCard("Total Active Staff", activeCount)}
        ${metricCard("Total Hours This Week", formatDuration(totalWeek))}
        ${metricCard("Tracked Robux Payouts", formatRobux(totalPayouts))}
        ${metricCard("Outstanding Documents", outstanding)}
      </div>
      <div class="content-grid">
        <section class="card chart-card">
          <div class="section-title"><h2>Activity Analytics</h2><span class="tag orange">Live</span></div>
          <canvas id="activityChart" height="220"></canvas>
        </section>
        <section class="card">
          <div class="section-title"><h2>Recent Activity</h2></div>
          <div class="timeline audit-feed">
            ${state.data.auditLogs
              .slice(-10)
              .reverse()
              .map(
                (log) => `
                  <div class="timeline-item">
                    <span class="dot"></span>
                    <div><strong>${escapeHtml(log.action)}</strong><p>${escapeHtml(log.details)}</p></div>
                    <strong>${formatTime(log.createdAt)}</strong>
                  </div>
                `,
              )
              .join("")}
          </div>
        </section>
      </div>
    `;
    drawActivityChart();
  }

  function renderStaffManagement() {
    const detailProfile = state.leadershipDetailProfileId ? getProfile(state.leadershipDetailProfileId) : null;
    if (detailProfile?.kind === "staff") {
      renderLeadershipProfileDetail(detailProfile);
      return;
    }
    if (state.leadershipDetailProfileId && !detailProfile) state.leadershipDetailProfileId = null;

    const staff = filteredProfiles("staff");
    $("#leadershipContent").innerHTML = `
      <div class="toolbar">
        <div class="split-row">
          <input id="managementSearch" placeholder="Search staff" value="${escapeAttr(state.searchTerm)}" />
          <select id="statusFilter">
            ${["all", "Active", "On Leave", "Contractor", "Suspended", "Archived"].map((status) => `<option value="${status}" ${state.filterStatus === status ? "selected" : ""}>${status}</option>`).join("")}
          </select>
        </div>
        <button class="accent-button" type="button" data-action="open-staff-form">Create Staff Profile</button>
      </div>
      ${profileTable(staff, "staff")}
    `;
  }

  function renderContractorManagement() {
    const detailProfile = state.leadershipDetailProfileId ? getProfile(state.leadershipDetailProfileId) : null;
    if (detailProfile?.kind === "contractor") {
      renderLeadershipProfileDetail(detailProfile);
      return;
    }
    if (state.leadershipDetailProfileId && !detailProfile) state.leadershipDetailProfileId = null;

    const contractors = filteredProfiles("contractor");
    $("#leadershipContent").innerHTML = `
      <div class="toolbar">
        <input id="managementSearch" placeholder="Search contractors" value="${escapeAttr(state.searchTerm)}" />
        <button class="accent-button" type="button" data-action="open-contractor-form">Create Contractor Profile</button>
      </div>
      ${profileTable(contractors, "contractor")}
    `;
  }

  function renderActivityManagement() {
    const active = state.data.profiles.filter((profile) => getActiveSession(profile.id));
    const allSessions = state.data.activities
      .slice()
      .sort((a, b) => new Date(b.startAt) - new Date(a.startAt))
      .slice(0, 30);

    $("#leadershipContent").innerHTML = `
      <div class="dashboard-grid">
        ${metricCard("Live Active Staff", active.length)}
        ${metricCard("Total Hours Today", formatDuration(totalActivityAll("today")))}
        ${metricCard("Total Hours This Week", formatDuration(totalActivityAll("week")))}
        ${metricCard("Most Active Staff", mostActiveStaff())}
      </div>
      <div class="content-grid">
        <section class="card chart-card">
          <div class="section-title"><h2>Weekly Activity</h2></div>
          <canvas id="activityChart" height="220"></canvas>
        </section>
        <section class="card">
          <div class="section-title"><h2>Live Staff Status</h2></div>
          <div class="timeline">
            ${state.data.profiles
              .filter((profile) => profile.kind !== "archived")
              .map(
                (profile) => `
                  <div class="timeline-item">
                    <span class="dot"></span>
                    <div><strong>${escapeHtml(profile.fullName)}</strong><p>${escapeHtml(profile.role || profile.serviceType)}</p></div>
                    ${statusTag(getActiveSession(profile.id) ? "Active" : "Offline")}
                  </div>
                `,
              )
              .join("")}
          </div>
        </section>
      </div>
      <div style="height:18px"></div>
      <section class="table-panel">
        <div class="table-head"><h2>Recent Activity Records</h2></div>
        <div class="table-scroll">
          <table>
            <thead><tr><th>Profile</th><th>Status</th><th>Start</th><th>End</th><th>Duration</th></tr></thead>
            <tbody>
              ${allSessions
                .map((session) => {
                  const profile = getProfile(session.profileId);
                  return `<tr>
                    <td><strong>${escapeHtml(profile ? profile.fullName : "Unknown")}</strong></td>
                    <td>${session.endAt ? "Offline" : "Active"}</td>
                    <td>${formatDateTime(session.startAt)}</td>
                    <td>${session.endAt ? formatDateTime(session.endAt) : "Active"}</td>
                    <td>${session.endAt ? formatDuration(minutesBetween(session.startAt, session.endAt)) : elapsed(session.startAt)}</td>
                  </tr>`;
                })
                .join("")}
            </tbody>
          </table>
        </div>
      </section>
    `;
    drawActivityChart();
  }

  function renderPayoutManagement() {
    $("#leadershipContent").innerHTML = `
      <div class="toolbar">
        <button class="accent-button" type="button" data-action="open-payout-form">Add Payout</button>
      </div>
      <div class="content-grid">
        <section class="table-panel">
          <div class="table-head"><h2>Robux Payouts</h2></div>
          <div class="table-scroll">
            <table>
              <thead><tr><th>Profile</th><th>Amount</th><th>Date</th><th>Status</th><th>Notes</th><th>Actions</th></tr></thead>
              <tbody>
                ${state.data.payouts
                  .slice()
                  .sort((a, b) => new Date(b.date) - new Date(a.date))
                  .map((payout) => {
                    const profile = getProfile(payout.profileId);
                    return `<tr>
                      <td><strong>${escapeHtml(profile ? profile.fullName : "Unknown")}</strong></td>
                      <td>${formatRobux(payout.amount)}</td>
                      <td>${formatDate(payout.date)}</td>
                      <td>${statusTag(payout.status)}</td>
                      <td>${escapeHtml(payout.notes || "")}</td>
                      <td class="inline-actions">
                        <button class="quiet-button" type="button" data-action="edit-payout" data-id="${payout.id}">Edit</button>
                        <button class="quiet-button" type="button" data-action="complete-payout" data-id="${payout.id}">Complete</button>
                      </td>
                    </tr>`;
                  })
                  .join("")}
              </tbody>
            </table>
          </div>
        </section>
        <section class="card chart-card">
          <div class="section-title"><h2>Payout Analytics</h2></div>
          <canvas id="payoutChart" height="220"></canvas>
        </section>
      </div>
    `;
    drawPayoutChart();
  }

  function renderDocumentsManagement() {
    $("#leadershipContent").innerHTML = `
      <div class="toolbar">
        <button class="accent-button" type="button" data-action="open-document-form">Upload Document</button>
      </div>
      <section class="table-panel">
        <div class="table-head"><h2>Documents</h2><span class="tag">${state.data.documents.length} Total</span></div>
        <div class="table-scroll">
          <table>
            <thead><tr><th>Document</th><th>Assigned</th><th>Due</th><th>Required</th><th>Opened</th><th>Completed</th><th>Actions</th></tr></thead>
            <tbody>
              ${state.data.documents
                .map((doc) => {
                  const opened = state.data.acknowledgements.filter((ack) => ack.documentId === doc.id && ack.openedAt).length;
                  const completed = state.data.acknowledgements.filter((ack) => ack.documentId === doc.id && ack.completedAt).length;
                  return `<tr>
                    <td><strong>${escapeHtml(doc.title)}</strong><p>${escapeHtml(doc.description)}</p></td>
                    <td>${doc.assignedTo.length}</td>
                    <td>${formatDate(doc.dueDate)}</td>
                    <td>${doc.completionRequired ? "Yes" : "No"}</td>
                    <td>${opened}</td>
                    <td>${completed}</td>
                    <td class="inline-actions">
                      <button class="quiet-button" type="button" data-action="view-document-report" data-id="${doc.id}">Report</button>
                      <button class="quiet-button" type="button" data-action="edit-document" data-id="${doc.id}">Edit</button>
                    </td>
                  </tr>`;
                })
                .join("")}
            </tbody>
          </table>
        </div>
      </section>
    `;
  }

  function renderReports() {
    const warnings = state.data.discipline.filter((entry) => entry.type === "Warning").length;
    const strikes = state.data.discipline.filter((entry) => entry.type === "Strike").length;
    $("#leadershipContent").innerHTML = `
      <div class="toolbar">
        <div class="split-row">
          <button class="accent-button" type="button" data-action="export-csv">Export CSV</button>
          <button class="ghost-button" type="button" data-action="export-pdf">Export PDF</button>
        </div>
      </div>
      <div class="dashboard-grid">
        ${metricCard("Staff Activity", formatDuration(totalActivityAll("month")))}
        ${metricCard("Contractor Activity", formatDuration(totalActivityKind("contractor", "month")))}
        ${metricCard("Total Payouts", formatRobux(state.data.payouts.reduce((sum, payout) => sum + Number(payout.amount || 0), 0)))}
        ${metricCard("Outstanding Docs", state.data.documents.reduce((sum, doc) => sum + uncompletedForDoc(doc.id).length, 0))}
      </div>
      <div class="content-grid">
        <section class="card chart-card">
          <div class="section-title"><h2>Strike & Warning Trends</h2></div>
          <canvas id="disciplineChart" height="220"></canvas>
        </section>
        <section class="card">
          <div class="section-title"><h2>Discipline Summary</h2></div>
          ${metricCard("Warnings", warnings)}
          <div style="height:12px"></div>
          ${metricCard("Strikes", strikes)}
        </section>
      </div>
    `;
    drawDisciplineChart();
  }

  function renderSettings() {
    const branding = normalizeBranding(state.settings);
    $("#leadershipContent").innerHTML = `
      <div class="content-grid">
        <section class="card">
          <div class="section-title"><h2>Portal Branding</h2></div>
          <form class="form-grid" id="settingsForm">
            <label>Portal Name<input name="portalName" value="${escapeAttr(branding.portalName)}" required /></label>
            <label>Accent Color<input name="accentColor" type="color" value="${escapeAttr(branding.accentColor)}" required /></label>
            <div class="branding-preview wide">
              <img src="${escapeAttr(branding.logoUrl)}" alt="${escapeAttr(branding.portalName)} logo preview" />
              <div>
                <span class="field-label">Current Logo</span>
                <strong>${escapeHtml(branding.logoPath ? "Custom logo uploaded" : "Default Summer '26 logo")}</strong>
              </div>
            </div>
            <label class="wide">Logo Upload<input name="logo" type="file" accept="image/*" /></label>
            <button class="accent-button" type="button" data-action="save-settings">Save Settings</button>
            <p class="form-message wide" id="settingsMessage" role="status"></p>
          </form>
        </section>
        <section class="card">
          <div class="section-title"><h2>Leadership Accounts</h2></div>
          <form class="form-grid" id="leaderAccountForm">
            <label>Name<input name="name" required /></label>
            <label>Email<input name="email" type="email" required /></label>
            <label>Role<select name="role"><option>Director</option><option>Operations Lead</option><option>HR</option><option>Finance</option></select></label>
            <label>Temporary Password<input name="password" type="password" minlength="10" required /></label>
            <button class="accent-button" type="button" data-action="create-leadership-account">Create Account</button>
          </form>
          <div class="timeline" style="margin-top:14px">
            ${state.data.leadershipAccounts
              .map(
                (account) => `
                  <div class="timeline-item">
                    <span class="dot"></span>
                    <div><strong>${escapeHtml(account.name)}</strong><p>${escapeHtml(account.email)}</p></div>
                    <div class="inline-actions">
                      <span class="tag">${escapeHtml(account.role)}</span>
                      <button class="quiet-button" type="button" data-action="open-leadership-reset" data-id="${account.id}">Reset Password</button>
                    </div>
                  </div>
                `,
              )
              .join("")}
          </div>
        </section>
      </div>
      <div style="height:18px"></div>
      <section class="card">
        <div class="section-title"><h2>Roles & Permissions</h2></div>
        <div class="document-grid">
          ${["Staff Management", "Activity Tracking", "Payout Updates", "Document Uploads", "Reports", "System Settings"]
            .map((permission) => `<div class="info-item"><span class="field-label">Permission</span><strong>${permission}</strong><p>Leadership only</p></div>`)
            .join("")}
        </div>
      </section>
    `;
  }

  async function handleActionClick(event) {
    const trigger = event.target.closest("[data-action]");
    if (!trigger) return;
    const action = trigger.dataset.action;
    const id = trigger.dataset.id;

    if (action === "leadership-section") {
      state.leadershipSection = trigger.dataset.section;
      state.leadershipDetailProfileId = null;
      renderLeadership();
      return;
    }
    if (action === "view-profile") {
      state.leadershipDetailProfileId = id;
      renderLeadership();
      return;
    }
    if (action === "back-to-members") {
      state.leadershipDetailProfileId = null;
      renderLeadership();
      return;
    }
    if (action === "start-activity") return startActivity();
    if (action === "end-activity") return endActivity();
    if (action === "open-document") return openDocument(id);
    if (action === "complete-document") return completeDocument(id);
    if (action === "open-staff-form") return openProfileForm("staff");
    if (action === "open-contractor-form") return openProfileForm("contractor");
    if (action === "edit-profile") return openProfileForm(trigger.dataset.kind, id);
    if (action === "archive-profile") return updateProfileStatus(id, "Archived");
    if (action === "suspend-profile") return updateProfileStatus(id, "Suspended");
    if (action === "delete-profile") return deleteProfile(id);
    if (action === "reset-pin") return openResetPinForm(id);
    if (action === "issue-warning") return openDisciplineForm(id, "Warning");
    if (action === "issue-strike") return openDisciplineForm(id, "Strike");
    if (action === "open-payout-form") return openPayoutForm(null, trigger.dataset.profileId);
    if (action === "edit-payout") return openPayoutForm(id);
    if (action === "complete-payout") return markPayoutComplete(id);
    if (action === "open-document-form") return openDocumentForm(null, trigger.dataset.profileId);
    if (action === "edit-document") return openDocumentForm(id);
    if (action === "view-document-report") return openDocumentReport(id);
    if (action === "export-csv") return exportCsv();
    if (action === "export-pdf") return window.print();
    if (action === "save-settings") return saveSettings();
    if (action === "create-leadership-account") return createLeadershipAccount();
    if (action === "open-leadership-reset") return openLeadershipResetForm(id);
  }

  function handleInputChange(event) {
    if (event.target.id === "managementSearch") {
      state.searchTerm = event.target.value;
      renderLeadership();
    }
    if (event.target.id === "statusFilter") {
      state.filterStatus = event.target.value;
      renderLeadership();
    }
  }

  async function startActivity() {
    const profile = state.currentProfile;
    if (!profile || getActiveSession(profile.id)) return;

    if (state.backend === "supabase") {
      const { data, error } = await state.supabase.functions.invoke("staff-activity", {
        body: { action: "start", profileId: profile.id, sessionToken: state.staffSessionToken },
      });
      if (error) throw error;
      state.data.activities.push({
        id: data.session.id,
        profileId: profile.id,
        startAt: data.session.start_at,
        endAt: null,
        durationMinutes: null,
      });
    } else {
      state.data.activities.push({
        id: cryptoRandom(),
        profileId: profile.id,
        startAt: new Date().toISOString(),
        endAt: null,
        durationMinutes: null,
      });
    }
    profile.activityStatus = "Active";
    logAudit("activity_started", profile.id, `${profile.fullName} started activity`);
    saveStore();
    state.profileContext = getProfileContext(profile.id);
    renderProfile();
  }

  async function endActivity() {
    const profile = state.currentProfile;
    const session = profile && getActiveSession(profile.id);
    if (!session) return;

    if (state.backend === "supabase") {
      const { error } = await state.supabase.functions.invoke("staff-activity", {
        body: { action: "end", profileId: profile.id, sessionId: session.id, sessionToken: state.staffSessionToken },
      });
      if (error) throw error;
    }

    session.endAt = new Date().toISOString();
    session.durationMinutes = minutesBetween(session.startAt, session.endAt);
    profile.activityStatus = "Offline";
    logAudit("activity_ended", profile.id, `${profile.fullName} ended activity`);
    saveStore();
    state.profileContext = getProfileContext(profile.id);
    renderProfile();
  }

  function openDocument(documentId) {
    const doc = state.data.documents.find((item) => item.id === documentId);
    if (!doc || !state.currentProfile) return;

    let ack = getAcknowledgement(doc.id, state.currentProfile.id);
    if (!ack) {
      ack = {
        id: cryptoRandom(),
        documentId: doc.id,
        profileId: state.currentProfile.id,
        openedAt: null,
        completedAt: null,
      };
      state.data.acknowledgements.push(ack);
    }
    if (!ack.openedAt) ack.openedAt = new Date().toISOString();
    logAudit("document_opened", doc.id, `${state.currentProfile.fullName} opened ${doc.title}`);
    saveStore();

    openModal(
      doc.title,
      `
        <div class="document-viewer">
          <p class="eyebrow">Document Viewer</p>
          <h2>${escapeHtml(doc.title)}</h2>
          <p>${escapeHtml(doc.description)}</p>
          <a class="accent-button" href="${escapeAttr(doc.fileUrl || "#")}" target="_blank" rel="noreferrer">Open File</a>
        </div>
        ${
          ack.completedAt
            ? `<span class="tag green">Completed ${formatDateTime(ack.completedAt)}</span>`
            : `<button class="accent-button full" type="button" data-action="complete-document" data-id="${doc.id}">${escapeHtml(doc.completionButtonText || "Complete")}</button>`
        }
      `,
    );
    renderProfile();
  }

  async function completeDocument(documentId) {
    const doc = state.data.documents.find((item) => item.id === documentId);
    if (!doc || !state.currentProfile) return;

    if (state.backend === "supabase") {
      const { error } = await state.supabase.functions.invoke("document-ack", {
        body: { documentId, profileId: state.currentProfile.id, sessionToken: state.staffSessionToken },
      });
      if (error) throw error;
    }

    const ack = getAcknowledgement(documentId, state.currentProfile.id);
    ack.completedAt = new Date().toISOString();
    logAudit("document_completed", doc.id, `${state.currentProfile.fullName} completed ${doc.title}`);
    saveStore();
    closeModal();
    state.profileContext = getProfileContext(state.currentProfile.id);
    renderProfile();
  }

  function openProfileForm(kind, id) {
    const existing = id ? getProfile(id) : null;
    const isContractor = kind === "contractor";
    openModal(
      existing ? "Edit Profile" : isContractor ? "Create Contractor Profile" : "Create Staff Profile",
      `
        <form class="form-grid" id="profileForm">
          <label>${isContractor ? "Name" : "Full Name"}<input name="fullName" value="${escapeAttr(existing?.fullName || "")}" required /></label>
          <label>${isContractor ? "Contractor ID" : "Username"}<input name="${isContractor ? "contractorId" : "username"}" value="${escapeAttr(isContractor ? existing?.contractorId || "" : existing?.username || "")}" required /></label>
          <label>4 Digit PIN<input name="pin" maxlength="4" pattern="[0-9]{4}" placeholder="${existing ? "Leave blank to keep" : "0000"}" ${existing ? "" : "required"} /></label>
          <label>${isContractor ? "Service Type" : "Role"}<input name="${isContractor ? "serviceType" : "role"}" value="${escapeAttr(isContractor ? existing?.serviceType || "" : existing?.role || "")}" required /></label>
          ${
            isContractor
              ? `<label>Robux Payment Amount<input name="contractAmount" type="number" value="${escapeAttr(existing?.contractAmount || "")}" /></label>
                 <label>Payment Status<select name="paymentStatus">${options(["Pending", "Complete", "On Hold"], existing?.paymentStatus || "Pending")}</select></label>`
              : `<label>Department<input name="department" value="${escapeAttr(existing?.department || "")}" required /></label>
                 <label>Employment Type<select name="employmentType">${options(["Full Time", "Part Time", "Contractor", "Seasonal"], existing?.employmentType || "Part Time")}</select></label>`
          }
          <label>Status<select name="status">${options(["Active", "On Leave", "Contractor", "Suspended", "Archived"], existing?.status || (isContractor ? "Contractor" : "Active"))}</select></label>
          <label>${isContractor ? "Start Date" : "Join Date"}<input name="${isContractor ? "startDate" : "joinDate"}" type="date" value="${escapeAttr(dateInputValue(isContractor ? existing?.startDate : existing?.joinDate))}" /></label>
          ${isContractor ? `<label>End Date<input name="endDate" type="date" value="${escapeAttr(dateInputValue(existing?.endDate))}" /></label>` : ""}
          <label class="wide">Tags<input name="tags" value="${escapeAttr((existing?.tags || []).join(", "))}" /></label>
          <label class="wide">Profile Photo Upload<input name="profilePhoto" type="file" accept="image/*" /></label>
          <label class="wide">Notes<textarea name="notes">${escapeHtml(existing?.notes || "")}</textarea></label>
          <label class="switch-row wide"><input name="notesVisible" type="checkbox" ${existing?.notesVisible ? "checked" : ""} /> Notes visible to staff</label>
          <button class="accent-button wide" type="submit">${existing ? "Save Profile" : "Create Profile"}</button>
        </form>
      `,
    );
    $("#profileForm").addEventListener("submit", (event) => saveProfile(event, kind, id));
  }

  async function saveProfile(event, kind, id) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form).entries());
    const isContractor = kind === "contractor";
    const existing = id ? getProfile(id) : null;
    const photoFile = form.profilePhoto.files[0];

    const profile = existing || {
      id: cryptoRandom(),
      kind,
      profilePhoto: "",
      pinSalt: cryptoRandom(),
      pinHash: "",
      activityStatus: "Offline",
    };

    let photo = existing?.profilePhoto || "";
    let photoPath = existing?.profilePhotoPath || "";
    if (photoFile && state.backend === "supabase") {
      photoPath = await uploadProfilePhoto(profile.id, photoFile);
      photo = state.supabase.storage.from("profile-photos").getPublicUrl(photoPath).data.publicUrl;
    } else if (photoFile) {
      photo = await fileToDataUrl(photoFile);
    }

    Object.assign(profile, {
      fullName: values.fullName.trim(),
      username: isContractor ? values.contractorId.trim() : values.username.trim(),
      contractorId: isContractor ? values.contractorId.trim() : "",
      role: isContractor ? "" : values.role.trim(),
      serviceType: isContractor ? values.serviceType.trim() : "",
      department: isContractor ? "Contractor" : values.department.trim(),
      employmentType: isContractor ? "Contractor" : values.employmentType,
      status: values.status,
      joinDate: isContractor ? values.startDate : values.joinDate,
      startDate: isContractor ? values.startDate : "",
      endDate: isContractor ? values.endDate : "",
      contractAmount: Number(values.contractAmount || 0),
      paymentStatus: values.paymentStatus || "",
      tags: splitTags(values.tags),
      profilePhoto: photo,
      profilePhotoPath: photoPath,
      notes: values.notes.trim(),
      notesVisible: Boolean(values.notesVisible),
    });

    if (values.pin) {
      profile.pinSalt = cryptoRandom();
      profile.pinHash = await pinDigest(values.pin, profile.pinSalt);
    }

    if (state.backend === "supabase") {
      await persistProfile(profile);
    }

    if (!existing) state.data.profiles.push(profile);
    logAudit(existing ? "profile_edited" : "profile_created", profile.id, `${profile.fullName} saved`);
    saveStore();
    closeModal();
    renderLeadership();
  }

  async function updateProfileStatus(id, status) {
    const profile = getProfile(id);
    if (!profile) return;
    if (state.backend === "supabase") {
      const { error } = await state.supabase
        .from("staff_profiles")
        .update({ status, archived_at: status === "Archived" ? new Date().toISOString() : null, updated_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw error;
    }
    profile.status = status;
    logAudit("profile_status_updated", id, `${profile.fullName} marked ${status}`);
    saveStore();
    renderLeadership();
  }

  async function deleteProfile(id) {
    const profile = getProfile(id);
    if (!profile) return;
    if (state.backend === "supabase") {
      const { error } = await state.supabase.from("staff_profiles").delete().eq("id", id);
      if (error) throw error;
    }
    state.data.profiles = state.data.profiles.filter((item) => item.id !== id);
    if (state.leadershipDetailProfileId === id) state.leadershipDetailProfileId = null;
    logAudit("profile_deleted", id, `${profile.fullName} deleted`);
    saveStore();
    renderLeadership();
  }

  function openResetPinForm(id) {
    const profile = getProfile(id);
    openModal(
      "Reset PIN",
      `
        <form class="form-grid" id="resetPinForm">
          <p class="wide">Set a new 4 digit PIN for ${escapeHtml(profile.fullName)}.</p>
          <label class="wide">New PIN<input name="pin" maxlength="4" pattern="[0-9]{4}" required /></label>
          <button class="accent-button wide" type="submit">Reset PIN</button>
        </form>
      `,
    );
    $("#resetPinForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const pin = new FormData(event.currentTarget).get("pin");
      profile.pinSalt = cryptoRandom();
      profile.pinHash = await pinDigest(pin, profile.pinSalt);
      logAudit("pin_reset", id, `${profile.fullName} PIN reset`);
      saveStore();
      closeModal();
    });
  }

  function openDisciplineForm(profileId, type) {
    const profile = getProfile(profileId);
    openModal(
      `Issue ${type}`,
      `
        <form class="form-grid" id="disciplineForm">
          <p class="wide">${escapeHtml(profile.fullName)}</p>
          <label class="wide">Reason<input name="reason" required /></label>
          <label>Issued By<input name="issuedBy" value="${escapeAttr(state.leadershipUser?.name || "Leadership")}" required /></label>
          <label>Date<input name="date" type="date" value="${dateInputValue(new Date().toISOString())}" required /></label>
          <label class="wide">Notes<textarea name="notes"></textarea></label>
          <button class="accent-button wide" type="submit">Issue ${type}</button>
        </form>
      `,
    );
    $("#disciplineForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.currentTarget).entries());
      const record = {
        id: cryptoRandom(),
        profileId,
        type,
        reason: values.reason,
        issuedBy: values.issuedBy,
        date: values.date,
        notes: values.notes,
      };
      if (state.backend === "supabase") {
        const { error } = await state.supabase.from("discipline_entries").insert({
          id: record.id,
          profile_id: profileId,
          type,
          reason: record.reason,
          issued_by: record.issuedBy,
          issued_at: record.date,
          notes: record.notes,
        });
        if (error) throw error;
      }
      state.data.discipline.push(record);
      logAudit(type === "Strike" ? "strike_issued" : "warning_issued", profileId, `${type} issued to ${profile.fullName}`);
      saveStore();
      closeModal();
      renderLeadership();
    });
  }

  function openPayoutForm(id, defaultProfileId = "") {
    const payout = id ? state.data.payouts.find((item) => item.id === id) : null;
    const selectedProfileId = payout?.profileId || defaultProfileId || "";
    openModal(
      payout ? "Edit Payout" : "Add Payout",
      `
        <form class="form-grid" id="payoutForm">
          <label class="wide">Profile<select name="profileId" required>${profileOptions(selectedProfileId)}</select></label>
          <label>Amount<input name="amount" type="number" value="${escapeAttr(payout?.amount || "")}" required /></label>
          <label>Date<input name="date" type="date" value="${dateInputValue(payout?.date || new Date().toISOString())}" required /></label>
          <label>Payment Type<select name="paymentType">${options(["Robux"], payout?.paymentType || "Robux")}</select></label>
          <label>Status<select name="status">${options(["Pending", "Complete", "On Hold"], payout?.status || "Pending")}</select></label>
          <label class="wide">Notes<textarea name="notes">${escapeHtml(payout?.notes || "")}</textarea></label>
          <button class="accent-button wide" type="submit">${payout ? "Save Payout" : "Add Payout"}</button>
        </form>
      `,
    );
    $("#payoutForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.currentTarget).entries());
      const record = payout || { id: cryptoRandom() };
      Object.assign(record, {
        profileId: values.profileId,
        amount: Number(values.amount),
        date: values.date,
        paymentType: values.paymentType,
        status: values.status,
        notes: values.notes,
      });
      if (!payout) state.data.payouts.push(record);
      if (state.backend === "supabase") {
        const { error } = await state.supabase.from("payouts").upsert({
          id: record.id,
          profile_id: record.profileId,
          amount: record.amount,
          paid_at: record.date,
          payment_type: record.paymentType,
          status: record.status,
          notes: record.notes,
          updated_at: new Date().toISOString(),
        });
        if (error) throw error;
      }
      logAudit("payout_updated", record.profileId, `Payout ${formatRobux(record.amount)} marked ${record.status}`);
      saveStore();
      closeModal();
      renderLeadership();
    });
  }

  async function markPayoutComplete(id) {
    const payout = state.data.payouts.find((item) => item.id === id);
    if (!payout) return;
    if (state.backend === "supabase") {
      const { error } = await state.supabase
        .from("payouts")
        .update({ status: "Complete", updated_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw error;
    }
    payout.status = "Complete";
    logAudit("payout_completed", payout.profileId, `Payout ${formatRobux(payout.amount)} completed`);
    saveStore();
    renderLeadership();
  }

  function openDocumentForm(id, defaultProfileId = "") {
    const doc = id ? state.data.documents.find((item) => item.id === id) : null;
    openModal(
      doc ? "Edit Document" : "Upload Document",
      `
        <form class="form-grid" id="documentForm">
          <label class="wide">Title<input name="title" value="${escapeAttr(doc?.title || "")}" required /></label>
          <label class="wide">Description<textarea name="description" required>${escapeHtml(doc?.description || "")}</textarea></label>
          <label>Due Date<input name="dueDate" type="date" value="${dateInputValue(doc?.dueDate || new Date().toISOString())}" required /></label>
          <label>Completion Button Text<input name="completionButtonText" value="${escapeAttr(doc?.completionButtonText || "Acknowledge")}" required /></label>
          <label class="wide">Assign To<select name="assignedTo" multiple size="6">${state.data.profiles
            .map((profile) => {
              const selected = doc?.assignedTo.includes(profile.id) || (!doc && defaultProfileId === profile.id);
              return `<option value="${profile.id}" ${selected ? "selected" : ""}>${escapeHtml(profile.fullName)}</option>`;
            })
            .join("")}</select></label>
          <label class="wide">File Upload<input name="file" type="file" /></label>
          <label class="switch-row wide"><input name="completionRequired" type="checkbox" ${doc?.completionRequired !== false ? "checked" : ""} /> Completion required</label>
          <button class="accent-button wide" type="submit">${doc ? "Save Document" : "Upload Document"}</button>
        </form>
      `,
    );
    $("#documentForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const values = Object.fromEntries(new FormData(form).entries());
      const assignedTo = $$("select[name='assignedTo'] option:checked", form).map((option) => option.value);
      const file = form.file.files[0];
      const record = doc || { id: cryptoRandom(), createdAt: new Date().toISOString() };
      let filePath = doc?.filePath || "";
      let fileUrl = doc?.fileUrl || "#";
      if (file && state.backend === "supabase") {
        filePath = await uploadDocumentFile(record.id, file);
        fileUrl = "#";
      } else if (file) {
        fileUrl = URL.createObjectURL(file);
      }
      Object.assign(record, {
        title: values.title,
        description: values.description,
        dueDate: values.dueDate,
        completionRequired: Boolean(values.completionRequired),
        completionButtonText: values.completionButtonText,
        assignedTo,
        fileName: file ? file.name : doc?.fileName || "document.pdf",
        filePath,
        fileUrl,
      });
      if (state.backend === "supabase") {
        const { error } = await state.supabase.from("documents").upsert({
          id: record.id,
          title: record.title,
          description: record.description,
          file_path: record.filePath || null,
          due_date: record.dueDate,
          completion_required: record.completionRequired,
          completion_button_text: record.completionButtonText,
          updated_at: new Date().toISOString(),
        });
        if (error) throw error;
        await state.supabase.from("document_assignments").delete().eq("document_id", record.id);
        if (assignedTo.length) {
          const assignmentRows = assignedTo.map((profileId) => ({ document_id: record.id, profile_id: profileId }));
          const { error: assignmentError } = await state.supabase.from("document_assignments").insert(assignmentRows);
          if (assignmentError) throw assignmentError;
        }
      }
      if (!doc) state.data.documents.push(record);
      logAudit("document_uploaded", record.id, `${record.title} saved`);
      saveStore();
      closeModal();
      renderLeadership();
    });
  }

  function openDocumentReport(id) {
    const doc = state.data.documents.find((item) => item.id === id);
    const rows = doc.assignedTo.map((profileId) => {
      const profile = getProfile(profileId);
      const ack = getAcknowledgement(doc.id, profileId);
      return { profile, ack };
    });
    openModal(
      "Document Report",
      `
        <div class="section-title"><h2>${escapeHtml(doc.title)}</h2><span class="tag">${uncompletedForDoc(id).length} Outstanding</span></div>
        <div class="table-scroll">
          <table>
            <thead><tr><th>Profile</th><th>Opened</th><th>Completed</th></tr></thead>
            <tbody>
              ${rows
                .map(
                  ({ profile, ack }) => `<tr>
                    <td><strong>${escapeHtml(profile.fullName)}</strong></td>
                    <td>${ack?.openedAt ? formatDateTime(ack.openedAt) : "Not opened"}</td>
                    <td>${ack?.completedAt ? formatDateTime(ack.completedAt) : "Outstanding"}</td>
                  </tr>`,
                )
                .join("")}
            </tbody>
          </table>
        </div>
      `,
    );
  }

  function exportCsv() {
    const rows = [
      ["Name", "Username", "Kind", "Status", "Warnings", "Strikes", "Robux Paid", "Hours Month"],
      ...state.data.profiles.map((profile) => {
        const context = getProfileContext(profile.id);
        return [
          profile.fullName,
          profile.username || profile.contractorId,
          profile.kind,
          profile.status,
          context.warnings.length,
          context.strikes.length,
          totalPaid(context.payouts),
          Math.round((totalActivity(profile.id, "month") / 60) * 100) / 100,
        ];
      }),
    ];
    const csv = rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(",")).join("\n");
    downloadFile("fri-portal-report.csv", csv, "text/csv");
  }

  async function saveSettings() {
    const form = $("#settingsForm");
    if (!form?.reportValidity()) return;
    const message = $("#settingsMessage");
    if (message) message.textContent = "Saving...";

    try {
      const values = Object.fromEntries(new FormData(form).entries());
      const file = form.logo.files[0];
      const nextBranding = normalizeBranding({
        ...state.settings,
        portalName: values.portalName,
        accentColor: values.accentColor,
      });

      if (file) {
        const uploaded = await uploadBrandingLogo(file);
        nextBranding.logoUrl = uploaded.logoUrl;
        nextBranding.logoPath = uploaded.logoPath;
      }

      if (state.backend === "supabase") {
        const { error } = await state.supabase.from("portal_settings").upsert({
          key: "branding",
          value: nextBranding,
          updated_at: new Date().toISOString(),
        });
        if (error) throw error;
      }

      state.settings = nextBranding;
      state.data.settings = { ...(state.data.settings || {}), branding: nextBranding };
      applyPortalBranding();
      logAudit("settings_updated", "settings", "Portal branding updated");
      saveStore();
      renderLeadership();
    } catch (error) {
      if (message) message.textContent = cleanError(error);
      else throw error;
    }
  }

  async function createLeadershipAccount() {
    const form = $("#leaderAccountForm");
    if (!form.reportValidity()) return;
    const values = Object.fromEntries(new FormData(form).entries());
    let account = {
      id: cryptoRandom(),
      name: values.name,
      email: values.email,
      role: values.role,
    };

    if (state.backend === "supabase") {
      const { data, error } = await state.supabase.functions.invoke("leadership-admin", {
        body: {
          action: "createAccount",
          name: values.name,
          email: values.email,
          role: values.role,
          password: values.password,
        },
      });
      if (error) throw error;
      account = data.account;
    }

    state.data.leadershipAccounts.push(account);
    logAudit("leadership_account_created", "settings", `${account.email} added`);
    saveStore();
    renderLeadership();
  }

  function openLeadershipResetForm(id) {
    const account = state.data.leadershipAccounts.find((item) => item.id === id);
    if (!account) return;
    openModal(
      "Reset Leadership Password",
      `
        <form class="form-grid" id="resetLeadershipPasswordForm">
          <p class="wide">${escapeHtml(account.name)} - ${escapeHtml(account.email)}</p>
          <label class="wide">Temporary Password<input name="password" type="password" minlength="10" required /></label>
          <button class="accent-button wide" type="submit">Reset Password</button>
        </form>
      `,
    );
    $("#resetLeadershipPasswordForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const password = new FormData(event.currentTarget).get("password");
      if (state.backend === "supabase") {
        const { error } = await state.supabase.functions.invoke("leadership-admin", {
          body: { action: "resetPassword", userId: id, password },
        });
        if (error) throw error;
      }
      logAudit("leadership_password_reset", id, `${account.email} password reset`);
      saveStore();
      closeModal();
      renderLeadership();
    });
  }

  function renderLeadershipProfileDetail(profile) {
    const context = getProfileContext(profile.id);
    const identifier = profile.username || profile.contractorId;
    const title = profile.role || profile.serviceType || "Staff Member";
    const active = getActiveSession(profile.id);
    const latestPayment = context.payouts
      .slice()
      .sort((a, b) => new Date(b.date) - new Date(a.date))[0];
    const paidRobux = totalPaid(context.payouts);
    const detailTitle = state.leadershipSection === "contractors" ? "All Contractors" : "All Members";

    $("#leadershipTitle").textContent = profile.fullName;
    $("#leadershipContent").innerHTML = `
      <div class="member-detail-toolbar">
        <button class="member-back" type="button" data-action="back-to-members">&larr; ${detailTitle}</button>
        <div class="member-detail-actions">
          <button class="ghost-button" type="button" data-action="edit-profile" data-kind="${profile.kind}" data-id="${profile.id}">Edit Profile</button>
          <button class="danger-button" type="button" data-action="delete-profile" data-id="${profile.id}">Delete</button>
        </div>
      </div>

      <section class="member-profile-card">
        <div class="member-cover" aria-hidden="true"></div>
        <div class="member-summary">
          <div class="member-avatar">
            ${
              profile.profilePhoto
                ? `<img src="${escapeAttr(profile.profilePhoto)}" alt="${escapeAttr(profile.fullName)}" />`
                : `<span>${initials(profile.fullName)}</span>`
            }
          </div>
          <div class="member-copy">
            <h2>${escapeHtml(profile.fullName)}</h2>
            <p>@${escapeHtml(identifier)}</p>
            <strong>${escapeHtml(title)}</strong>
          </div>
          <div class="member-status">${statusTag(profile.status)}</div>
        </div>

        <div class="member-stat-grid">
          ${memberStatCard("$", "$0", "USD Paid")}
          ${memberStatCard("R$", `R$${formatRobux(paidRobux)}`, "Robux Paid")}
          ${memberStatCard("!", context.strikes.length, "Strikes")}
          ${memberStatCard("i", context.warnings.length, "Warnings")}
        </div>
      </section>

      <div class="member-action-grid">
        ${memberActionTile("$", "Log Payment", "open-payout-form", profile.id)}
        ${memberActionTile("!", "Issue Strike", "issue-strike", profile.id)}
        ${memberActionTile("i", "Issue Warning", "issue-warning", profile.id)}
        ${memberActionTile("DOC", "Upload Doc", "open-document-form", profile.id)}
      </div>

      <div class="member-detail-grid">
        <section class="card">
          <div class="section-title"><h2>Profile Details</h2>${statusTag(active ? "Active" : "Offline")}</div>
          <div class="info-grid">
            ${infoItem("Username", identifier)}
            ${infoItem("Department", profile.department || "Contractor")}
            ${infoItem("Employment Type", profile.employmentType)}
            ${infoItem(profile.kind === "contractor" ? "Start Date" : "Join Date", formatDate(profile.joinDate || profile.startDate))}
            ${infoItem("Most Recent Payment", latestPayment ? `${formatRobux(latestPayment.amount)} Robux` : "None")}
            ${infoItem("Activity This Month", formatDuration(totalActivity(profile.id, "month")))}
          </div>
          ${
            profile.notes
              ? `<div class="info-item member-notes"><span class="field-label">Leadership Notes</span><strong>${escapeHtml(profile.notes)}</strong></div>`
              : ""
          }
        </section>

        <section class="card">
          <div class="section-title"><h2>Recent Activity</h2><span class="tag">${formatDuration(totalActivity(profile.id, "week"))} This Week</span></div>
          <div class="timeline">
            ${
              recentActivities(profile.id)
                .slice(0, 4)
                .map(
                  (session) => `
                    <div class="timeline-item">
                      <span class="dot"></span>
                      <div><strong>${formatDateTime(session.startAt)}</strong><p>${session.endAt ? formatDateTime(session.endAt) : "Active now"}</p></div>
                      <strong>${session.endAt ? formatDuration(minutesBetween(session.startAt, session.endAt)) : elapsed(session.startAt)}</strong>
                    </div>
                  `,
                )
                .join("") || `<p>No activity sessions yet.</p>`
            }
          </div>
        </section>

        <section class="card">
          <div class="section-title"><h2>Discipline</h2></div>
          <div class="timeline">
            ${
              [...context.warnings, ...context.strikes]
                .sort((a, b) => new Date(b.date) - new Date(a.date))
                .slice(0, 5)
                .map(
                  (entry) => `
                    <div class="timeline-item">
                      <span class="dot"></span>
                      <div><strong>${escapeHtml(entry.type)}: ${escapeHtml(entry.reason)}</strong><p>${escapeHtml(entry.notes || "")}</p></div>
                      <strong>${formatDate(entry.date)}</strong>
                    </div>
                  `,
                )
                .join("") || `<p>No warnings or strikes.</p>`
            }
          </div>
        </section>

        <section class="card">
          <div class="section-title"><h2>Documents</h2><span class="tag">${outstandingDocuments(profile.id)} Outstanding</span></div>
          <div class="timeline">
            ${
              context.documents
                .slice(0, 5)
                .map((doc) => {
                  const ack = getAcknowledgement(doc.id, profile.id);
                  return `
                    <div class="timeline-item">
                      <span class="dot"></span>
                      <div><strong>${escapeHtml(doc.title)}</strong><p>${escapeHtml(doc.description || "")}</p></div>
                      <span class="tag ${ack?.completedAt ? "green" : "yellow"}">${ack?.completedAt ? "Complete" : "Open"}</span>
                    </div>
                  `;
                })
                .join("") || `<p>No assigned documents.</p>`
            }
          </div>
        </section>
      </div>
    `;
  }

  function memberStatCard(icon, value, label) {
    return `
      <div class="member-stat-card">
        <span class="member-stat-icon">${escapeHtml(icon)}</span>
        <strong>${escapeHtml(String(value))}</strong>
        <p>${escapeHtml(label)}</p>
      </div>
    `;
  }

  function memberActionTile(icon, label, action, profileId) {
    const idAttr = action === "open-payout-form" || action === "open-document-form" ? "" : `data-id="${profileId}"`;
    const profileAttr = action === "open-payout-form" || action === "open-document-form" ? `data-profile-id="${profileId}"` : "";
    return `
      <button class="member-action-tile" type="button" data-action="${action}" ${idAttr} ${profileAttr}>
        <span>${escapeHtml(icon)}</span>
        <strong>${escapeHtml(label)}</strong>
      </button>
    `;
  }

  function profileTable(profiles, kind) {
    return `
      <section class="table-panel">
        <div class="table-head"><h2>${kind === "staff" ? "Staff Profiles" : "Contractor Profiles"}</h2><span class="tag">${profiles.length} Records</span></div>
        <div class="table-scroll">
          <table>
            <thead><tr><th>Name</th><th>Role</th><th>Department</th><th>Status</th><th>Warnings</th><th>Strikes</th><th>Actions</th></tr></thead>
            <tbody>
              ${profiles
                .map((profile) => {
                  const context = getProfileContext(profile.id);
                  return `<tr>
                    <td><strong>${escapeHtml(profile.fullName)}</strong><p>@${escapeHtml(profile.username || profile.contractorId)}</p></td>
                    <td>${escapeHtml(profile.role || profile.serviceType)}</td>
                    <td>${escapeHtml(profile.department || "Contractor")}</td>
                    <td>${statusTag(profile.status)}</td>
                    <td>${context.warnings.length}</td>
                    <td>${context.strikes.length}</td>
                    <td class="inline-actions">
                      <button class="quiet-button" type="button" data-action="view-profile" data-id="${profile.id}">View</button>
                      <button class="quiet-button" type="button" data-action="edit-profile" data-kind="${kind}" data-id="${profile.id}">Edit</button>
                      <button class="quiet-button" type="button" data-action="reset-pin" data-id="${profile.id}">Reset PIN</button>
                      <button class="quiet-button" type="button" data-action="issue-warning" data-id="${profile.id}">Warning</button>
                      <button class="quiet-button" type="button" data-action="issue-strike" data-id="${profile.id}">Strike</button>
                      <button class="quiet-button" type="button" data-action="suspend-profile" data-id="${profile.id}">Suspend</button>
                      <button class="quiet-button" type="button" data-action="archive-profile" data-id="${profile.id}">Archive</button>
                      <button class="danger-button" type="button" data-action="delete-profile" data-id="${profile.id}">Delete</button>
                    </td>
                  </tr>`;
                })
                .join("")}
            </tbody>
          </table>
        </div>
      </section>
    `;
  }

  function metricCard(label, value) {
    return `<div class="metric-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></div>`;
  }

  function infoItem(label, value) {
    return `<div class="info-item"><span class="field-label">${escapeHtml(label)}</span><strong>${escapeHtml(value || "Not set")}</strong></div>`;
  }

  function documentCard(doc, profileId) {
    const ack = getAcknowledgement(doc.id, profileId);
    const completed = Boolean(ack?.completedAt);
    return `
      <article class="document-card">
        <div>
          <div class="tag-row">
            <span class="tag ${completed ? "green" : "orange"}">${completed ? "Completed" : "Open"}</span>
            ${doc.completionRequired ? `<span class="tag yellow">Required</span>` : ""}
          </div>
          <h3>${escapeHtml(doc.title)}</h3>
          <p>${escapeHtml(doc.description)}</p>
        </div>
        <button class="ghost-button" type="button" data-action="open-document" data-id="${doc.id}">Open</button>
      </article>
    `;
  }

  function statusTag(status) {
    const normalizedStatus = status || "Offline";
    let color = "orange";
    if (["Active", "Complete"].includes(normalizedStatus)) color = "green";
    if (["Suspended", "Archived", "Invalid"].includes(normalizedStatus)) color = "red";
    if (["Pending", "On Leave", "On Hold"].includes(normalizedStatus)) color = "yellow";
    return `<span class="tag ${color}">${escapeHtml(normalizedStatus)}</span>`;
  }

  function drawActivityChart() {
    const labels = lastSevenDays().map((date) => date.toLocaleDateString(undefined, { weekday: "short" }));
    const values = lastSevenDays().map((date) => {
      const key = date.toISOString().slice(0, 10);
      return Math.round(
        state.data.activities
          .filter((session) => session.startAt.slice(0, 10) === key)
          .reduce((sum, session) => sum + sessionDuration(session), 0) / 60,
      );
    });
    drawBars("activityChart", labels, values, "#e85002");
  }

  function drawPayoutChart() {
    const labels = state.data.profiles.slice(0, 6).map((profile) => profile.fullName.split(" ")[0]);
    const values = state.data.profiles.slice(0, 6).map((profile) => totalPaid(getProfileContext(profile.id).payouts));
    drawBars("payoutChart", labels, values, "#28c76f");
  }

  function drawDisciplineChart() {
    const labels = ["Warnings", "Strikes"];
    const values = [
      state.data.discipline.filter((entry) => entry.type === "Warning").length,
      state.data.discipline.filter((entry) => entry.type === "Strike").length,
    ];
    drawBars("disciplineChart", labels, values, "#ffc94d");
  }

  function drawBars(canvasId, labels, values, color) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const context = canvas.getContext("2d");
    const ratio = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * ratio;
    canvas.height = 220 * ratio;
    context.scale(ratio, ratio);
    context.clearRect(0, 0, rect.width, 220);
    const max = Math.max(...values, 1);
    const left = 34;
    const bottom = 186;
    const barGap = 12;
    const width = Math.max(16, (rect.width - left - 20 - barGap * (labels.length - 1)) / labels.length);

    context.strokeStyle = "rgba(249,249,249,.12)";
    context.beginPath();
    context.moveTo(left, 12);
    context.lineTo(left, bottom);
    context.lineTo(rect.width - 10, bottom);
    context.stroke();

    labels.forEach((label, index) => {
      const value = values[index];
      const height = (value / max) * 144;
      const x = left + 12 + index * (width + barGap);
      const y = bottom - height;
      context.fillStyle = color;
      roundRect(context, x, y, width, height, 6);
      context.fill();
      context.fillStyle = "#f9f9f9";
      context.font = "600 12px Inter, sans-serif";
      context.textAlign = "center";
      context.fillText(String(value), x + width / 2, y - 8);
      context.fillStyle = "#a7a7a7";
      context.font = "560 11px Inter, sans-serif";
      context.fillText(label, x + width / 2, bottom + 20);
    });
  }

  function roundRect(context, x, y, width, height, radius) {
    context.beginPath();
    context.moveTo(x + radius, y);
    context.arcTo(x + width, y, x + width, y + height, radius);
    context.arcTo(x + width, y + height, x, y + height, radius);
    context.arcTo(x, y + height, x, y, radius);
    context.arcTo(x, y, x + width, y, radius);
    context.closePath();
  }

  function getProfileContext(profileId) {
    return {
      activities: state.data.activities.filter((session) => session.profileId === profileId),
      payouts: state.data.payouts.filter((payout) => payout.profileId === profileId),
      warnings: state.data.discipline.filter((entry) => entry.profileId === profileId && entry.type === "Warning"),
      strikes: state.data.discipline.filter((entry) => entry.profileId === profileId && entry.type === "Strike"),
      documents: state.data.documents.filter((doc) => doc.assignedTo.includes(profileId)),
      acknowledgements: state.data.acknowledgements.filter((ack) => ack.profileId === profileId),
    };
  }

  function getProfile(id) {
    return state.data.profiles.find((profile) => profile.id === id);
  }

  function getActiveSession(profileId) {
    return state.data.activities.find((session) => session.profileId === profileId && !session.endAt);
  }

  function recentActivities(profileId) {
    return state.data.activities
      .filter((session) => session.profileId === profileId)
      .slice()
      .sort((a, b) => new Date(b.startAt) - new Date(a.startAt));
  }

  function getAcknowledgement(documentId, profileId) {
    return state.data.acknowledgements.find((ack) => ack.documentId === documentId && ack.profileId === profileId);
  }

  async function loadSupabaseData() {
    const client = state.supabase;
    const [profiles, activities, payouts, discipline, documents, assignments, acknowledgements, leaders, audits] =
      await Promise.all([
        client.from("staff_profiles").select("*").order("created_at", { ascending: false }),
        client.from("activity_sessions").select("*").order("start_at", { ascending: false }),
        client.from("payouts").select("*").order("paid_at", { ascending: false }),
        client.from("discipline_entries").select("*").order("issued_at", { ascending: false }),
        client.from("documents").select("*").order("created_at", { ascending: false }),
        client.from("document_assignments").select("*"),
        client.from("document_acknowledgements").select("*"),
        client.from("leadership_users").select("*"),
        client.from("audit_logs").select("*").order("created_at", { ascending: false }).limit(100),
      ]);

    for (const result of [profiles, activities, payouts, discipline, documents, assignments, acknowledgements, leaders, audits]) {
      if (result.error) throw result.error;
    }

    const assignedByDocument = new Map();
    for (const assignment of assignments.data || []) {
      const list = assignedByDocument.get(assignment.document_id) || [];
      list.push(assignment.profile_id);
      assignedByDocument.set(assignment.document_id, list);
    }

    return {
      profiles: (profiles.data || []).map(mapDbProfile),
      activities: (activities.data || []).map((row) => ({
        id: row.id,
        profileId: row.profile_id,
        startAt: row.start_at,
        endAt: row.end_at,
        durationMinutes: row.duration_minutes,
      })),
      payouts: (payouts.data || []).map((row) => ({
        id: row.id,
        profileId: row.profile_id,
        amount: Number(row.amount),
        date: row.paid_at,
        paymentType: row.payment_type,
        status: row.status,
        notes: row.notes,
      })),
      discipline: (discipline.data || []).map((row) => ({
        id: row.id,
        profileId: row.profile_id,
        type: row.type,
        reason: row.reason,
        issuedBy: row.issued_by,
        date: row.issued_at,
        notes: row.notes,
      })),
      documents: (documents.data || []).map((row) => ({
        id: row.id,
        title: row.title,
        description: row.description || "",
        filePath: row.file_path || "",
        fileUrl: "#",
        dueDate: row.due_date,
        completionRequired: row.completion_required,
        completionButtonText: row.completion_button_text,
        assignedTo: assignedByDocument.get(row.id) || [],
        createdAt: row.created_at,
      })),
      acknowledgements: (acknowledgements.data || []).map((row) => ({
        id: row.id,
        documentId: row.document_id,
        profileId: row.profile_id,
        openedAt: row.opened_at,
        completedAt: row.completed_at,
      })),
      leadershipAccounts: (leaders.data || []).map((row) => ({
        id: row.user_id,
        name: row.name,
        email: row.email || "Supabase Auth User",
        role: row.role,
      })),
      demoLeader: state.data.demoLeader,
      auditLogs: (audits.data || []).map((row) => ({
        id: row.id,
        action: row.action,
        targetId: row.target_id,
        details: JSON.stringify(row.details || {}),
        createdAt: row.created_at,
      })),
    };
  }

  function mapDbProfile(row) {
    const photo = row.profile_photo_path
      ? state.supabase.storage.from("profile-photos").getPublicUrl(row.profile_photo_path).data.publicUrl
      : "";
    return {
      id: row.id,
      kind: row.kind,
      profilePhoto: photo,
      profilePhotoPath: row.profile_photo_path || "",
      fullName: row.full_name,
      username: row.username || row.contractor_id || "",
      contractorId: row.contractor_id || "",
      pinSalt: row.pin_salt,
      pinHash: row.pin_hash,
      role: row.role || "",
      department: row.department || "",
      tags: row.tags || [],
      employmentType: row.employment_type,
      joinDate: row.join_date,
      status: row.status,
      notes: row.notes || "",
      notesVisible: row.notes_visible,
      activityStatus: row.activity_status,
      serviceType: row.service_type || "",
      contractAmount: Number(row.contract_amount || 0),
      paymentStatus: row.payment_status || "",
      startDate: row.start_date || "",
      endDate: row.end_date || "",
    };
  }

  async function uploadProfilePhoto(profileId, file) {
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "-");
    const path = `profiles/${profileId}/${Date.now()}-${safeName}`;
    const { error } = await state.supabase.storage.from("profile-photos").upload(path, file, { upsert: true });
    if (error) throw error;
    return path;
  }

  async function uploadBrandingLogo(file) {
    if (state.backend !== "supabase") {
      return { logoUrl: await fileToDataUrl(file), logoPath: "" };
    }
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "-");
    const logoPath = `branding/${Date.now()}-${safeName}`;
    const { error } = await state.supabase.storage.from("portal-assets").upload(logoPath, file, { upsert: true });
    if (error) throw error;
    const { data } = state.supabase.storage.from("portal-assets").getPublicUrl(logoPath);
    return { logoUrl: data.publicUrl, logoPath };
  }

  async function uploadDocumentFile(documentId, file) {
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "-");
    const path = `documents/${documentId}/${Date.now()}-${safeName}`;
    const { error } = await state.supabase.storage.from("staff-documents").upload(path, file, { upsert: true });
    if (error) throw error;
    return path;
  }

  async function persistProfile(profile) {
    const payload = {
      id: profile.id,
      kind: profile.kind,
      profile_photo_path: profile.profilePhotoPath || null,
      full_name: profile.fullName,
      username: profile.kind === "staff" ? profile.username : null,
      contractor_id: profile.kind === "contractor" ? profile.contractorId || profile.username : null,
      pin_salt: profile.pinSalt,
      pin_hash: profile.pinHash,
      role: profile.role || null,
      department: profile.department || null,
      tags: profile.tags || [],
      employment_type: profile.employmentType,
      join_date: profile.joinDate || null,
      status: profile.status,
      notes: profile.notes || null,
      notes_visible: profile.notesVisible,
      activity_status: profile.activityStatus || "Offline",
      service_type: profile.serviceType || null,
      contract_amount: profile.contractAmount || null,
      payment_status: profile.paymentStatus || null,
      start_date: profile.startDate || null,
      end_date: profile.endDate || null,
      updated_at: new Date().toISOString(),
    };
    const { error } = await state.supabase.from("staff_profiles").upsert(payload);
    if (error) throw error;
  }

  function mergeProfileContext(profile, context) {
    state.data.profiles = state.data.profiles.filter((item) => item.id !== profile.id);
    state.data.profiles.push(profile);
    state.data.activities = state.data.activities.filter((item) => item.profileId !== profile.id).concat(context.activities || []);
    state.data.payouts = state.data.payouts.filter((item) => item.profileId !== profile.id).concat(context.payouts || []);
    state.data.discipline = state.data.discipline
      .filter((item) => item.profileId !== profile.id)
      .concat([...(context.warnings || []), ...(context.strikes || [])]);
    state.data.acknowledgements = state.data.acknowledgements
      .filter((item) => item.profileId !== profile.id)
      .concat(context.acknowledgements || []);

    for (const document of context.documents || []) {
      const existing = state.data.documents.find((item) => item.id === document.id);
      if (existing) {
        Object.assign(existing, document);
        if (!existing.assignedTo.includes(profile.id)) existing.assignedTo.push(profile.id);
      } else {
        state.data.documents.push({ ...document, assignedTo: [profile.id] });
      }
    }
  }

  function filteredProfiles(kind) {
    return state.data.profiles.filter((profile) => {
      const kindMatch = profile.kind === kind;
      const search = !state.searchTerm || normalize(`${profile.fullName} ${profile.username} ${profile.contractorId}`).includes(normalize(state.searchTerm));
      const status = state.filterStatus === "all" || profile.status === state.filterStatus;
      return kindMatch && search && status;
    });
  }

  function totalPaid(payouts) {
    return payouts.filter((payout) => payout.status === "Complete").reduce((sum, payout) => sum + Number(payout.amount || 0), 0);
  }

  function totalActivity(profileId, period) {
    return state.data.activities
      .filter((session) => session.profileId === profileId && isInPeriod(session.startAt, period))
      .reduce((sum, session) => sum + sessionDuration(session), 0);
  }

  function totalActivityAll(period) {
    return state.data.activities
      .filter((session) => isInPeriod(session.startAt, period))
      .reduce((sum, session) => sum + sessionDuration(session), 0);
  }

  function totalActivityKind(kind, period) {
    return state.data.profiles
      .filter((profile) => profile.kind === kind)
      .reduce((sum, profile) => sum + totalActivity(profile.id, period), 0);
  }

  function mostActiveStaff() {
    const ranked = state.data.profiles
      .map((profile) => ({ profile, minutes: totalActivity(profile.id, "week") }))
      .sort((a, b) => b.minutes - a.minutes);
    return ranked[0]?.minutes ? ranked[0].profile.fullName.split(" ")[0] : "None";
  }

  function outstandingDocuments(profileId) {
    return state.data.documents.filter((doc) => {
      if (!doc.assignedTo.includes(profileId) || !doc.completionRequired) return false;
      const ack = getAcknowledgement(doc.id, profileId);
      return !ack?.completedAt;
    }).length;
  }

  function uncompletedForDoc(documentId) {
    const doc = state.data.documents.find((item) => item.id === documentId);
    if (!doc) return [];
    return doc.assignedTo.filter((profileId) => {
      const ack = getAcknowledgement(documentId, profileId);
      return !ack?.completedAt;
    });
  }

  function sessionDuration(session) {
    return session.endAt ? minutesBetween(session.startAt, session.endAt) : minutesBetween(session.startAt, new Date().toISOString());
  }

  function minutesBetween(start, end) {
    return Math.max(0, Math.round((new Date(end) - new Date(start)) / 60000));
  }

  function isInPeriod(iso, period) {
    const date = new Date(iso);
    const now = new Date();
    if (period === "today") return date.toDateString() === now.toDateString();
    if (period === "week") {
      const start = new Date(now);
      start.setDate(now.getDate() - now.getDay());
      start.setHours(0, 0, 0, 0);
      return date >= start;
    }
    if (period === "month") return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth();
    return true;
  }

  function loadStore() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) return JSON.parse(stored);
    } catch (error) {
      console.warn("Demo store could not be loaded.", error);
    }
    return seedStore();
  }

  function saveStore() {
    if (state.backend !== "demo") return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.data));
  }

  async function hydrateDemoSecurity() {
    for (const profile of state.data.profiles) {
      if (!profile.pinSalt) profile.pinSalt = cryptoRandom();
      if (profile.demoPin && !profile.pinHash) {
        profile.pinHash = await pinDigest(profile.demoPin, profile.pinSalt);
        delete profile.demoPin;
      }
    }
    if (state.data.demoLeader.demoPassword && !state.data.demoLeader.passwordHash) {
      state.data.demoLeader.passwordHash = await pinDigest(state.data.demoLeader.demoPassword, state.data.demoLeader.salt);
      delete state.data.demoLeader.demoPassword;
    }
    saveStore();
  }

  function seedStore() {
    const now = new Date();
    const daysAgo = (days, hour = 14) => {
      const date = new Date(now);
      date.setDate(now.getDate() - days);
      date.setHours(hour, 0, 0, 0);
      return date.toISOString();
    };

    const profiles = [
      {
        id: "staff-avery",
        kind: "staff",
        fullName: "Avery Stone",
        username: "AveryFRI",
        demoPin: "0426",
        pinSalt: "fri-avery",
        role: "Operations Coordinator",
        department: "Live Operations",
        tags: ["Leadership Track", "Events", "Roblox"],
        employmentType: "Part Time",
        joinDate: "2025-08-12",
        status: "Active",
        activityStatus: "Offline",
        notes: "Eligible for event lead rotations during the Summer '26 content drop.",
        notesVisible: true,
        profilePhoto: "",
      },
      {
        id: "staff-milo",
        kind: "staff",
        fullName: "Milo Reyes",
        username: "MiloFRI",
        demoPin: "2266",
        pinSalt: "fri-milo",
        role: "Community Moderator",
        department: "Community Safety",
        tags: ["Moderation", "Training"],
        employmentType: "Seasonal",
        joinDate: "2026-01-18",
        status: "Active",
        activityStatus: "Offline",
        notes: "Keep assigned to weekend review queues.",
        notesVisible: false,
        profilePhoto: "",
      },
      {
        id: "contractor-nova",
        kind: "contractor",
        fullName: "Nova Buildworks",
        username: "FRI-C901",
        contractorId: "FRI-C901",
        demoPin: "9010",
        pinSalt: "fri-nova",
        role: "",
        serviceType: "Environment Artist",
        department: "Contractor",
        tags: ["Map Art", "Props"],
        employmentType: "Contractor",
        joinDate: "2026-04-01",
        startDate: "2026-04-01",
        endDate: "2026-06-30",
        status: "Contractor",
        activityStatus: "Offline",
        contractAmount: 48000,
        paymentStatus: "Pending",
        notes: "Responsible for three lobby prop passes.",
        notesVisible: true,
        profilePhoto: "",
      },
    ];

    return {
      settings: { branding: { ...DEFAULT_BRANDING } },
      profiles,
      activities: [
        { id: "act-1", profileId: "staff-avery", startAt: daysAgo(1, 12), endAt: daysAgo(1, 15), durationMinutes: 180 },
        { id: "act-2", profileId: "staff-avery", startAt: daysAgo(3, 10), endAt: daysAgo(3, 14), durationMinutes: 240 },
        { id: "act-3", profileId: "staff-milo", startAt: daysAgo(2, 16), endAt: daysAgo(2, 19), durationMinutes: 180 },
        { id: "act-4", profileId: "contractor-nova", startAt: daysAgo(4, 11), endAt: daysAgo(4, 16), durationMinutes: 300 },
      ],
      payouts: [
        { id: "pay-1", profileId: "staff-avery", amount: 12500, date: "2026-05-18", paymentType: "Robux", status: "Complete", notes: "Event operations bonus" },
        { id: "pay-2", profileId: "staff-milo", amount: 8000, date: "2026-05-20", paymentType: "Robux", status: "Pending", notes: "Moderation coverage" },
        { id: "pay-3", profileId: "contractor-nova", amount: 24000, date: "2026-05-24", paymentType: "Robux", status: "Pending", notes: "Milestone 1" },
      ],
      discipline: [
        { id: "disc-1", profileId: "staff-milo", type: "Warning", reason: "Missed response SLA", issuedBy: "Ops Lead", date: "2026-05-06", notes: "Reviewed queue expectations." },
      ],
      documents: [
        {
          id: "doc-handbook",
          title: "Summer '26 Staff Handbook",
          description: "Updated conduct, live operations, and escalation guidance for the current content cycle.",
          fileName: "summer-26-handbook.pdf",
          fileUrl: "#",
          dueDate: "2026-06-07",
          completionRequired: true,
          completionButtonText: "Acknowledge",
          assignedTo: ["staff-avery", "staff-milo", "contractor-nova"],
          createdAt: "2026-05-24T10:00:00.000Z",
        },
        {
          id: "doc-nda",
          title: "Contractor NDA",
          description: "Confidentiality agreement for external production support.",
          fileName: "nda.pdf",
          fileUrl: "#",
          dueDate: "2026-06-01",
          completionRequired: true,
          completionButtonText: "Agree",
          assignedTo: ["contractor-nova"],
          createdAt: "2026-05-22T10:00:00.000Z",
        },
      ],
      acknowledgements: [
        { id: "ack-1", documentId: "doc-handbook", profileId: "staff-avery", openedAt: "2026-05-25T15:15:00.000Z", completedAt: "2026-05-25T15:19:00.000Z" },
      ],
      leadershipAccounts: [{ id: "leader-1", name: "Demo Leadership", email: "leader@fri.local", role: "Director" }],
      demoLeader: {
        email: "leader@fri.local",
        demoPassword: "portal2026",
        salt: "fri-leadership-demo",
      },
      auditLogs: [
        { id: "audit-1", action: "portal_seeded", targetId: "system", details: "Demo operations data initialized", createdAt: new Date().toISOString() },
      ],
    };
  }

  function emptyStore() {
    return {
      settings: { branding: { ...DEFAULT_BRANDING } },
      profiles: [],
      activities: [],
      payouts: [],
      discipline: [],
      documents: [],
      acknowledgements: [],
      leadershipAccounts: [],
      demoLeader: {
        email: "",
        passwordHash: "",
        salt: "",
      },
      auditLogs: [],
    };
  }

  function logAudit(action, targetId, details) {
    const entry = {
      id: cryptoRandom(),
      action,
      targetId,
      details,
      createdAt: new Date().toISOString(),
    };
    state.data.auditLogs.push(entry);
    if (state.backend === "supabase" && state.supabase) {
      state.supabase
        .from("audit_logs")
        .insert({
          id: entry.id,
          action,
          target_id: isUuid(targetId) ? targetId : null,
          target_table: "portal",
          details: { message: details },
        })
        .then(({ error }) => {
          if (error) console.warn("Audit log insert failed", error);
        });
    }
  }

  function isUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value));
  }

  async function pinDigest(value, salt) {
    const input = `${salt}:${value}`;
    if (window.crypto?.subtle) {
      const bytes = new TextEncoder().encode(input);
      const digest = await window.crypto.subtle.digest("SHA-256", bytes);
      return Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    }
    let hash = 0;
    for (let i = 0; i < input.length; i += 1) hash = Math.imul(31, hash) + input.charCodeAt(i);
    return `fallback-${hash >>> 0}`;
  }

  function cryptoRandom() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function openModal(title, bodyHtml) {
    $("#modalTitle").textContent = title;
    $("#modalBody").innerHTML = bodyHtml;
    $("#modalHost").classList.remove("hidden");
  }

  function closeModal() {
    $("#modalHost").classList.add("hidden");
    $("#modalBody").innerHTML = "";
  }

  function options(values, selected) {
    return values.map((value) => `<option value="${escapeAttr(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(value)}</option>`).join("");
  }

  function profileOptions(selected) {
    return state.data.profiles
      .map((profile) => `<option value="${profile.id}" ${profile.id === selected ? "selected" : ""}>${escapeHtml(profile.fullName)}</option>`)
      .join("");
  }

  function splitTags(tags) {
    return String(tags || "")
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
  }

  function normalize(value) {
    return String(value || "").trim().toLowerCase();
  }

  function initials(name) {
    return escapeHtml(
      String(name || "FRI")
        .split(/\s+/)
        .slice(0, 2)
        .map((part) => part[0] || "")
        .join(""),
    );
  }

  function formatRobux(value) {
    return Number(value || 0).toLocaleString();
  }

  function formatDuration(minutes) {
    const total = Math.max(0, Math.round(minutes || 0));
    const hours = Math.floor(total / 60);
    const mins = total % 60;
    return `${hours}h ${String(mins).padStart(2, "0")}m`;
  }

  function elapsed(startIso) {
    const total = Math.max(0, Math.floor((Date.now() - new Date(startIso).getTime()) / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
  }

  function formatDate(value) {
    if (!value) return "Not set";
    return parseCalendarDate(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }

  function formatDateTime(value) {
    if (!value) return "Not set";
    return new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  function formatTime(value) {
    return new Date(value).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }

  function dateInputValue(value) {
    if (!value) return "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return String(value);
    return new Date(value).toISOString().slice(0, 10);
  }

  function parseCalendarDate(value) {
    const text = String(value);
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      const [year, month, day] = text.split("-").map(Number);
      return new Date(year, month - 1, day);
    }
    return new Date(value);
  }

  function lastSevenDays() {
    return Array.from({ length: 7 }, (_, index) => {
      const date = new Date();
      date.setDate(date.getDate() - (6 - index));
      date.setHours(0, 0, 0, 0);
      return date;
    });
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function downloadFile(name, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    URL.revokeObjectURL(url);
  }

  function cleanError(error) {
    return error?.message || "Something went wrong";
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function escapeAttr(value) {
    return escapeHtml(value);
  }
})();
