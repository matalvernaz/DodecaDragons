// Expansion layer: save safety, offline progress, and QoL overlays.
//
// Additive and decoupled. All new UI is fixed-position overlay DOM built here
// in JS, never a pannable ".box" canvas window, so none of this touches the
// fragile cachedBoxes[47] indexing or render() positioning. Loaded after the
// game scripts but before the inline load() call, so it can wrap load().
//
// Depends on globals from the base game: game, tabData, format, save,
// exportGame, importGame, updateSmall, updateLarge, timeSinceLastUpdate,
// panToTab, Decimal, Mousetrap.

(function () {
  "use strict";

  const BACKUP_SLOTS = 3;            // rolling pre-session save backups
  const OFFLINE_MIN_MS = 60 * 1000;  // ignore gaps shorter than this
  const OFFLINE_BASE_HOURS = 2;      // cap = base + unlocks, clamped
  const OFFLINE_MAX_HOURS = 24;
  const OFFLINE_MAX_STEPS = 300;     // chunked sub-ticks; bounds CPU on long gaps

  // ---- defaults / migration ------------------------------------------------
  // New save namespaces. loadGame copies these in as raw objects (it only
  // Decimal-converts top-level string fields), so nested Decimals are rebuilt
  // here. Missing fields fall back to defaults — old saves migrate silently.
  function ensureDefaults() {
    if (typeof game !== "object" || !game) return;
    if (game.saveVersion === undefined) game.saveVersion = 1;

    if (typeof game.settings !== "object" || game.settings === null) game.settings = {};
    if (game.settings.offlineEnabled === undefined) game.settings.offlineEnabled = true;
    if (game.settings.quietMode === undefined) game.settings.quietMode = true;

    if (typeof game.stats !== "object" || game.stats === null) game.stats = {};
    if (game.stats.firstPlayed === undefined) game.stats.firstPlayed = Date.now();
    game.stats.sessionStart = Date.now();
    if (game.stats.bestGoldPerSecond === undefined) game.stats.bestGoldPerSecond = "0";

    if (typeof game.omniverse !== "object" || game.omniverse === null) {
      game.omniverse = { echoes: new Decimal(0), totalEchoes: new Decimal(0), reconstitutions: 0, nodes: {} };
    } else {
      game.omniverse.echoes = new Decimal(game.omniverse.echoes || 0);
      game.omniverse.totalEchoes = new Decimal(game.omniverse.totalEchoes || 0);
      if (game.omniverse.reconstitutions === undefined) game.omniverse.reconstitutions = 0;
      if (typeof game.omniverse.nodes !== "object" || game.omniverse.nodes === null) game.omniverse.nodes = {};
    }
  }
  window.ensureDefaults = ensureDefaults;

  // ---- rolling backups -----------------------------------------------------
  function makeBackup() {
    const cur = localStorage.getItem("dodecaSave");
    if (!cur) return;
    let backups = [];
    try { backups = JSON.parse(localStorage.getItem("dodecaBackups")) || []; } catch (e) { backups = []; }
    if (backups[0] && backups[0].data === cur) return; // don't duplicate identical
    backups.unshift({ t: Date.now(), data: cur });
    backups = backups.slice(0, BACKUP_SLOTS);
    try { localStorage.setItem("dodecaBackups", JSON.stringify(backups)); } catch (e) { /* quota: drop oldest silently */ }
  }
  function listBackups() {
    try { return JSON.parse(localStorage.getItem("dodecaBackups")) || []; } catch (e) { return []; }
  }
  function restoreBackup(i) {
    const backups = listBackups();
    if (!backups[i]) return;
    if (!confirm("Restore backup from " + new Date(backups[i].t).toLocaleString() + "? Your current progress will be overwritten.")) return;
    localStorage.setItem("dodecaSave", backups[i].data);
    location.reload();
  }

  // ---- file save / load ----------------------------------------------------
  function downloadSave() {
    if (typeof save === "function") save();
    const data = localStorage.getItem("dodecaSave") || "";
    const b64 = encodeSave(data); // reuse the game's unicode-safe encoder
    const blob = new Blob([b64], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    a.href = url;
    a.download = "dodecadragons-" + stamp + ".txt";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
  function uploadSave(file) {
    const reader = new FileReader();
    reader.onload = function () {
      try {
        const raw = decodeSave(String(reader.result).trim());
        // The download wraps the raw localStorage JSON; importGame expects a
        // base64 of the game object, so route through localStorage + reload.
        JSON.parse(raw); // validate it parses
        localStorage.setItem("dodecaSave", raw);
        alert("Save file loaded. Reloading.");
        location.reload();
      } catch (e) {
        alert("That file could not be read as a DodecaDragons save.");
      }
    };
    reader.readAsText(file);
  }

  // ---- bounded offline progress -------------------------------------------
  function offlineCapMs() {
    const hours = Math.min(OFFLINE_BASE_HOURS + (game.unlocks || 0), OFFLINE_MAX_HOURS);
    return hours * 3600 * 1000;
  }
  function applyOfflineProgress(elapsedMs) {
    if (!game || !game.settings || game.settings.offlineEnabled === false) return;
    if (!(elapsedMs > OFFLINE_MIN_MS)) return;
    if (typeof updateLarge !== "function" || typeof updateSmall !== "function") return;

    const simMs = Math.min(elapsedMs, offlineCapMs());
    const goldBefore = new Decimal(game.gold || 0);
    const steps = Math.min(OFFLINE_MAX_STEPS, Math.max(1, Math.floor(simMs / 1000)));
    const chunkMs = simMs / steps;

    const wasTimeStopped = window.timeStopped;
    window.timeStopped = false;
    for (let s = 0; s < steps; s++) {
      try { updateSmall(); } catch (e) { /* keep simulating */ }
      window.timeSinceLastUpdate = Date.now() - chunkMs; // makes timeDivider = this chunk's length
      try { updateLarge(); } catch (e) { /* keep simulating */ }
    }
    window.timeStopped = wasTimeStopped;
    window.timeSinceLastUpdate = Date.now();
    game.lastUpdate = Date.now();

    showOfflineSummary(elapsedMs, simMs, goldBefore, new Decimal(game.gold || 0));
  }
  window.applyOfflineProgress = applyOfflineProgress;

  function fmtDuration(ms) {
    let s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400); s -= d * 86400;
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60); s -= m * 60;
    const parts = [];
    if (d) parts.push(d + "d");
    if (h) parts.push(h + "h");
    if (m) parts.push(m + "m");
    if (!d && !h) parts.push(s + "s");
    return parts.join(" ");
  }
  function showOfflineSummary(elapsedMs, simMs, goldBefore, goldAfter) {
    const gained = goldAfter.sub(goldBefore);
    const capped = simMs < elapsedMs;
    const box = makeOverlay("a11yOfflineSummary", "Welcome back");
    box.body.innerHTML =
      "<p>You were away for <b>" + fmtDuration(elapsedMs) + "</b>" +
      (capped ? " (offline progress capped at " + fmtDuration(simMs) + ")" : "") + ".</p>" +
      "<p>While away you earned <b>" + format(gained.max(0)) + "</b> gold" +
      (game.unlocks >= 1 ? " plus your other passive resources." : ".") + "</p>";
    const ok = document.createElement("button");
    ok.textContent = "Continue";
    ok.onclick = function () { box.root.remove(); };
    box.body.appendChild(ok);
    announceIf("Welcome back. Away for " + fmtDuration(elapsedMs) + ". Earned " + format(gained.max(0)) + " gold.");
    ok.focus();
  }

  // ---- overlay helpers -----------------------------------------------------
  // Minimal Windows-98-ish floating panel, keyboard-focusable and labelled.
  function makeOverlay(id, title) {
    const existing = document.getElementById(id);
    if (existing) existing.remove();
    const root = document.createElement("div");
    root.id = id;
    root.className = "exp-overlay";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", title);
    root.tabIndex = -1;

    const bar = document.createElement("div");
    bar.className = "exp-overlay-bar";
    const h = document.createElement("span");
    h.textContent = title;
    h.setAttribute("role", "heading");
    h.setAttribute("aria-level", "2");
    const close = document.createElement("button");
    close.textContent = "X";
    close.setAttribute("aria-label", "Close " + title);
    close.onclick = function () { root.remove(); };
    bar.appendChild(h);
    bar.appendChild(close);

    const body = document.createElement("div");
    body.className = "exp-overlay-body";

    root.appendChild(bar);
    root.appendChild(body);
    document.body.appendChild(root);
    root.addEventListener("keydown", function (e) { if (e.key === "Escape") root.remove(); });
    return { root: root, body: body };
  }
  function announceIf(msg) { if (typeof window.announce === "function") window.announce(msg); }

  // ---- stats window --------------------------------------------------------
  function highestLayerName() {
    let best = "Gold";
    Object.keys(tabData).forEach(function (k) {
      if (tabData[k][2] <= (game.unlocks || 0)) best = k;
    });
    return best.replace(/([A-Z])/g, " $1").replace(/^./, function (c) { return c.toUpperCase(); }).trim();
  }
  function openStats() {
    const o = makeOverlay("expStats", "Statistics");
    const rows = [
      ["Total time played", fmtDuration((game.timePlayed || 0) * 1000)],
      ["This session", fmtDuration(Date.now() - (game.stats.sessionStart || Date.now()))],
      ["First played", new Date(game.stats.firstPlayed || Date.now()).toLocaleDateString()],
      ["Gold", format(game.gold || 0)],
      ["Gold / second", format(game.goldPerSecond || 0)],
      ["Best gold / second", format(game.stats.bestGoldPerSecond || 0)],
      ["Highest layer reached", highestLayerName()],
      ["Achievements", (game.unlockedAchievements || []).reduce(function (a, b) { return a + (b || 0); }, 0)],
      ["Omniverse reconstitutions", (game.omniverse && game.omniverse.reconstitutions) || 0],
      ["Omniversal Echoes", format((game.omniverse && game.omniverse.echoes) || 0)]
    ];
    let html = "<table class='exp-table'>";
    rows.forEach(function (r) { html += "<tr><td>" + r[0] + "</td><td>" + r[1] + "</td></tr>"; });
    html += "</table>";
    o.body.innerHTML = html;
    o.root.focus();
  }
  function trackBests() {
    if (!game || !game.stats || !game.goldPerSecond) return;
    try {
      if (new Decimal(game.goldPerSecond).gt(new Decimal(game.stats.bestGoldPerSecond || 0))) {
        game.stats.bestGoldPerSecond = game.goldPerSecond.toString();
      }
    } catch (e) { /* ignore */ }
  }

  // ---- command palette -----------------------------------------------------
  function paletteEntries() {
    const entries = [];
    Object.keys(tabData).forEach(function (k) {
      if (tabData[k][2] <= (game.unlocks || 0)) {
        entries.push({ label: "Go to: " + k.replace(/([A-Z])/g, " $1").replace(/^./, function (c) { return c.toUpperCase(); }).trim(),
          run: function () { if (typeof panToTab === "function") panToTab(k); } });
      }
    });
    entries.push({ label: "Save now", run: function () { if (typeof save === "function") save(); announceIf("Saved."); } });
    entries.push({ label: "Download save to file", run: downloadSave });
    entries.push({ label: "Open statistics", run: openStats });
    entries.push({ label: "Open map", run: openMap });
    if (game.omniverse) entries.push({ label: "Open Constellation board", run: function () { if (typeof window.openConstellation === "function") window.openConstellation(); } });
    return entries;
  }
  function openPalette() {
    const o = makeOverlay("expPalette", "Command palette");
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Type to filter, Enter to run, Esc to close";
    input.setAttribute("aria-label", "Command palette filter");
    input.className = "exp-palette-input";
    const list = document.createElement("ul");
    list.className = "exp-palette-list";
    list.setAttribute("role", "listbox");
    o.body.appendChild(input);
    o.body.appendChild(list);

    let entries = paletteEntries();
    let sel = 0;
    function render() {
      const q = input.value.toLowerCase();
      const filtered = entries.filter(function (e) { return e.label.toLowerCase().indexOf(q) > -1; });
      list.innerHTML = "";
      filtered.forEach(function (e, i) {
        const li = document.createElement("li");
        li.textContent = e.label;
        li.setAttribute("role", "option");
        li.className = i === sel ? "exp-sel" : "";
        li.setAttribute("aria-selected", i === sel ? "true" : "false");
        li.onclick = function () { o.root.remove(); e.run(); };
        list.appendChild(li);
      });
      list._filtered = filtered;
    }
    input.addEventListener("input", function () { sel = 0; render(); });
    input.addEventListener("keydown", function (e) {
      const f = list._filtered || [];
      if (e.key === "ArrowDown") { sel = Math.min(sel + 1, f.length - 1); render(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { sel = Math.max(sel - 1, 0); render(); e.preventDefault(); }
      else if (e.key === "Enter") { if (f[sel]) { o.root.remove(); f[sel].run(); } e.preventDefault(); }
    });
    render();
    input.focus();
  }

  // ---- minimap -------------------------------------------------------------
  function openMap() {
    const o = makeOverlay("expMap", "Map");
    const W = 240, H = 200, PAD = 12;
    const keys = Object.keys(tabData).filter(function (k) { return tabData[k][2] <= (game.unlocks || 0); });
    let minX = 0, maxX = 0, minY = 0, maxY = 0;
    keys.forEach(function (k) {
      minX = Math.min(minX, tabData[k][0]); maxX = Math.max(maxX, tabData[k][0]);
      minY = Math.min(minY, tabData[k][1]); maxY = Math.max(maxY, tabData[k][1]);
    });
    const spanX = (maxX - minX) || 1, spanY = (maxY - minY) || 1;
    const map = document.createElement("div");
    map.className = "exp-map";
    map.style.width = W + "px";
    map.style.height = H + "px";
    keys.forEach(function (k) {
      const dot = document.createElement("button");
      dot.className = "exp-map-dot";
      dot.style.left = (PAD + (tabData[k][0] - minX) / spanX * (W - 2 * PAD)) + "px";
      dot.style.top = (PAD + (tabData[k][1] - minY) / spanY * (H - 2 * PAD)) + "px";
      const name = k.replace(/([A-Z])/g, " $1").replace(/^./, function (c) { return c.toUpperCase(); }).trim();
      dot.title = name;
      dot.setAttribute("aria-label", "Go to " + name);
      dot.onclick = function () { if (typeof panToTab === "function") panToTab(k); o.root.remove(); };
      map.appendChild(dot);
    });
    o.body.appendChild(map);
    o.root.focus();
  }

  // ---- launcher + settings buttons ----------------------------------------
  function buildLauncher() {
    const bar = document.createElement("div");
    bar.id = "expLauncher";
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", "DodecaDragons tools");
    const buttons = [
      ["Menu ☰", function () { togglePanel(); }, "Open tools menu"]
    ];
    buttons.forEach(function (b) {
      const btn = document.createElement("button");
      btn.textContent = b[0];
      btn.setAttribute("aria-label", b[2]);
      btn.onclick = b[1];
      bar.appendChild(btn);
    });
    document.body.appendChild(bar);
  }
  function togglePanel() {
    const existing = document.getElementById("expMenu");
    if (existing) { existing.remove(); return; }
    const o = makeOverlay("expMenu", "Tools");
    const items = [
      ["Statistics", openStats],
      ["Map", openMap],
      ["Command palette (Ctrl+K)", openPalette],
      ["Download save to file", downloadSave],
      ["Load save from file", function () { fileInput.click(); }],
      ["Backups", openBackups],
      ["Constellation board", function () { if (typeof window.openConstellation === "function") window.openConstellation(); else alert("Reach the omniverse to unlock this."); }],
      ["Offline progress: " + (game.settings.offlineEnabled ? "On" : "Off"), function () {
        game.settings.offlineEnabled = !game.settings.offlineEnabled; togglePanel(); togglePanel();
      }],
      ["Screen reader quiet mode: " + (game.settings.quietMode !== false ? "On" : "Off"), function () {
        game.settings.quietMode = (game.settings.quietMode === false);
        if (typeof window.applyQuietMode === "function") window.applyQuietMode();
        togglePanel(); togglePanel();
      }]
    ];
    items.forEach(function (it) {
      const b = document.createElement("button");
      b.textContent = it[0];
      b.className = "exp-menu-item";
      b.onclick = it[1];
      o.body.appendChild(b);
    });
    o.root.focus();
  }
  function openBackups() {
    const o = makeOverlay("expBackups", "Backups");
    const backups = listBackups();
    if (!backups.length) { o.body.innerHTML = "<p>No backups yet. One is made automatically each time the game loads.</p>"; return; }
    backups.forEach(function (b, i) {
      const row = document.createElement("button");
      row.className = "exp-menu-item";
      row.textContent = "Restore: " + new Date(b.t).toLocaleString();
      row.onclick = function () { restoreBackup(i); };
      o.body.appendChild(row);
    });
  }

  // hidden file input for uploads
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".txt,text/plain";
  fileInput.style.display = "none";
  fileInput.addEventListener("change", function () { if (fileInput.files[0]) uploadSave(fileInput.files[0]); });

  // ---- styles --------------------------------------------------------------
  function injectStyle() {
    const s = document.createElement("style");
    s.textContent =
      "#expLauncher{position:fixed;top:4px;right:4px;z-index:9000;display:flex;gap:4px}" +
      "#expLauncher button{font-family:inherit;cursor:pointer}" +
      ".exp-overlay{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:9100;" +
      "background:#c0c0c0;border:2px solid;border-color:#fff #808080 #808080 #fff;min-width:260px;max-width:90vw;" +
      "max-height:85vh;overflow:auto;box-shadow:2px 2px 6px rgba(0,0,0,.4);font-family:inherit}" +
      ".exp-overlay-bar{display:flex;justify-content:space-between;align-items:center;background:linear-gradient(90deg,#008,#10a);" +
      "color:#fff;padding:2px 4px;font-weight:bold}" +
      ".exp-overlay-bar button{cursor:pointer}" +
      ".exp-overlay-body{padding:8px}" +
      ".exp-overlay-body button{display:block;margin:4px 0;cursor:pointer;font-family:inherit}" +
      ".exp-menu-item{width:100%;text-align:left;padding:4px}" +
      ".exp-table{border-collapse:collapse;width:100%}" +
      ".exp-table td{border:1px solid #808080;padding:2px 6px}" +
      ".exp-table td:last-child{font-weight:bold;text-align:right}" +
      ".exp-palette-input{width:100%;box-sizing:border-box;margin-bottom:6px;font-family:inherit}" +
      ".exp-palette-list{list-style:none;margin:0;padding:0;max-height:300px;overflow:auto}" +
      ".exp-palette-list li{padding:4px 6px;cursor:pointer}" +
      ".exp-palette-list li.exp-sel{background:#008;color:#fff}" +
      ".exp-map{position:relative;background:#000;border:1px solid #808080}" +
      ".exp-map-dot{position:absolute;width:10px;height:10px;padding:0;transform:translate(-50%,-50%);" +
      "background:#0f0;border:1px solid #060;cursor:pointer}";
    document.head.appendChild(s);
  }

  // ---- bootstrap -----------------------------------------------------------
  // Wrap load() so we back up + run offline progress without editing the
  // audited save path. load() is a global function declaration (window.load);
  // this file is included before the inline load() call, so the wrapper wins.
  function installLoadHook() {
    const origLoad = window.load;
    if (typeof origLoad !== "function") return;
    window.load = function () {
      // Everything the expansion adds is wrapped so a bug here can never block
      // the base game from loading — origLoad must always run.
      let lastSave = 0;
      try {
        makeBackup();
        const s = JSON.parse(localStorage.getItem("dodecaSave"));
        if (s) lastSave = s.lastSave || 0;
      } catch (e) { console.warn("expansion pre-load skipped:", e); }
      origLoad.apply(this, arguments);
      try { ensureDefaults(); } catch (e) { console.warn("ensureDefaults skipped:", e); }
      if (lastSave) {
        try { applyOfflineProgress(Date.now() - lastSave); } catch (e) { console.warn("offline progress skipped:", e); }
      }
    };
  }

  function init() {
    try {
      injectStyle();
      document.body.appendChild(fileInput);
      buildLauncher();
      setInterval(trackBests, 2000);
      if (typeof Mousetrap !== "undefined") {
        Mousetrap.bind(["ctrl+k", "command+k"], function () { openPalette(); return false; });
      }
    } catch (e) { console.warn("expansion init failed:", e); }
  }

  installLoadHook(); // must run before the inline load()
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
