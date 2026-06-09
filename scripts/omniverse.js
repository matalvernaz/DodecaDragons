// Dodeca Constellation board — post-"omniverse" New Game+ layer.
//
// FIRST-PASS BALANCE: the numbers here are deliberate placeholders meant to be
// tuned with playtesting. Every node maps to a field that updateSmall()
// recomputes from scratch each tick, so omniApply() (called at the end of
// updateSmall) only ever multiplies a freshly-built rate — never compounds.
//
// Reconstitution = a hard reset of the whole progression spine in exchange for
// Omniversal Echoes, the board's currency. The board itself (echoes + owned
// nodes) is preserved across the reset, so each run starts stronger.
//
// Depends on globals: game, Decimal, reset, save, format.

(function () {
  "use strict";

  const ENDGAME_THRESHOLD = "ee1e12"; // same gold gate as bigFinishCheck()

  // Each node maps to a confirmed per-tick rate field or a flag.
  const NODES = [
    { id: "gold1",     branch: "Golden Hoard",  name: "Golden Hoard I",   cost: 1,  desc: "Gold per second ×5" },
    { id: "gold2",     branch: "Golden Hoard",  name: "Golden Hoard II",  cost: 6,  desc: "Gold per second ×100" },
    { id: "autominer", branch: "Golden Hoard",  name: "Tireless Miners",  cost: 3,  desc: "Miners always auto-buy max" },

    { id: "fire1",     branch: "Eternal Flame",  name: "Eternal Flame",   cost: 2,  desc: "Fire per second ×8" },
    { id: "bluefire1", branch: "Eternal Flame",  name: "Cold Fire",       cost: 10, desc: "Blue fire per second ×8" },
    { id: "holyfire1", branch: "Eternal Flame",  name: "Sacred Fire",     cost: 18, desc: "Holy fire per second ×8" },

    { id: "magic1",    branch: "Arcana",         name: "Arcane Memory",   cost: 4,  desc: "Magic effect ×4" },
    { id: "sigil1",    branch: "Arcana",         name: "Sigil Resonance", cost: 7,  desc: "All sigil power ×8" },

    { id: "blood1",    branch: "Cosmos",         name: "Bloodtide",       cost: 9,  desc: "Blood per second ×8" },
    { id: "plague1",   branch: "Cosmos",         name: "Virulence",       cost: 12, desc: "Cosmic plague per second ×8" },
    { id: "essence1",  branch: "Cosmos",         name: "Essence Bloom",   cost: 14, desc: "All essences per second ×4" },

    { id: "echo1",     branch: "Finality",       name: "Echo Amplifier",  cost: 5,  desc: "+25% Echoes gained on reconstitution" },
    { id: "global1",   branch: "Finality",       name: "Omniversal Pressure", cost: 25, desc: "Gold per second is raised to ^1.03 (compounds)" }
  ];
  const NODE_BY_ID = {};
  NODES.forEach(function (n) { NODE_BY_ID[n.id] = n; });

  function nodes() { return (game.omniverse && game.omniverse.nodes) || {}; }
  function hasNode(id) { return !!nodes()[id]; }

  // Applied at the end of every updateSmall(). Multiplies freshly-recomputed
  // per-second rates; safe to run every tick.
  function omniApply() {
    if (!game || !game.omniverse || !game.omniverse.nodes) return;
    try { omniApplyInner(); } catch (e) { /* never let a board bug break the tick */ }
  }
  function omniApplyInner() {
    const n = game.omniverse.nodes;
    if (n.gold1 && game.goldPerSecond) game.goldPerSecond = game.goldPerSecond.mul(5);
    if (n.gold2 && game.goldPerSecond) game.goldPerSecond = game.goldPerSecond.mul(100);
    if (n.autominer) game.minerAutoBuyMax = true;
    if (n.fire1 && game.firePerSecond) game.firePerSecond = game.firePerSecond.mul(8);
    if (n.bluefire1 && game.blueFirePerSecond) game.blueFirePerSecond = game.blueFirePerSecond.mul(8);
    if (n.holyfire1 && game.holyFirePerSecond) game.holyFirePerSecond = game.holyFirePerSecond.mul(8);
    if (n.magic1 && game.magicEffect) game.magicEffect = game.magicEffect.mul(4);
    if (n.sigil1) ["cyan", "blue", "indigo", "violet", "pink", "red", "orange", "yellow"].forEach(function (c) {
      const k = c + "SigilPowerPerSecond";
      if (game[k]) game[k] = game[k].mul(8);
    });
    if (n.blood1 && game.bloodPerSecond) game.bloodPerSecond = game.bloodPerSecond.mul(8);
    if (n.plague1 && game.cosmicPlaguePerSecond) game.cosmicPlaguePerSecond = game.cosmicPlaguePerSecond.mul(8);
    if (n.essence1) ["lightEssencePerSecond", "darkEssencePerSecond", "deathEssencePerSecond", "finalityEssencePerSecond"].forEach(function (k) {
      if (game[k]) game[k] = game[k].mul(4);
    });
    if (n.global1 && game.goldPerSecond) game.goldPerSecond = game.goldPerSecond.pow(1.03);
  }
  window.omniApply = omniApply;

  // Echoes awarded for the current run's depth. First-pass formula, tunable.
  function computeEchoGain() {
    let g = new Decimal(1);
    g = g.add(new Decimal(game.finalityCubes || 0).add(1).log10().floor());
    g = g.add(game.hypergodsDefeated || 0);
    const ach = (game.unlockedAchievements || []).reduce(function (a, b) { return a + (b || 0); }, 0);
    g = g.add(Math.floor(ach / 4));
    if (hasNode("echo1")) g = g.mul(1.25);
    return g.floor().max(1);
  }

  function canReconstitute() {
    return game && game.gold && new Decimal(game.gold).gte(ENDGAME_THRESHOLD);
  }

  function reconstitute() {
    if (!canReconstitute()) { alert("You must reach the omniverse (" + format(new Decimal(ENDGAME_THRESHOLD)) + " gold) before you can reconstitute."); return; }
    const gain = computeEchoGain();
    if (!confirm("Reconstitute the omniverse?\n\nThis HARD RESETS your entire run (all resources, upgrades, sigils, layers) but keeps your Constellation board.\n\nYou will gain " + format(gain) + " Omniversal Echoes.")) return;

    const ov = game.omniverse;
    ov.echoes = new Decimal(ov.echoes || 0).add(gain);
    ov.totalEchoes = new Decimal(ov.totalEchoes || 0).add(gain);
    ov.reconstitutions = (ov.reconstitutions || 0) + 1;

    // Preserve the board + lifetime stats across the spine wipe. (Decimals
    // round-trip through strings here; ensureDefaults rebuilds them on reload.)
    const savedOv = JSON.stringify(ov);
    const savedStats = game.stats ? JSON.stringify(game.stats) : null;

    reset();
    game.omniverse = JSON.parse(savedOv);
    if (savedStats) game.stats = JSON.parse(savedStats);
    if (typeof save === "function") save();
    location.reload();
  }
  window.reconstitute = reconstitute;

  // ---- board UI (reuses expansion.js .exp-overlay styles) -----------------
  function openConstellation() {
    const old = document.getElementById("omniBoard");
    if (old) old.remove();
    const root = document.createElement("div");
    root.id = "omniBoard";
    root.className = "exp-overlay";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "Dodeca Constellation");
    root.tabIndex = -1;

    const bar = document.createElement("div");
    bar.className = "exp-overlay-bar";
    const h = document.createElement("span");
    h.textContent = "Dodeca Constellation";
    h.setAttribute("role", "heading"); h.setAttribute("aria-level", "2");
    const close = document.createElement("button");
    close.textContent = "X"; close.setAttribute("aria-label", "Close Constellation");
    close.onclick = function () { root.remove(); };
    bar.appendChild(h); bar.appendChild(close);
    root.appendChild(bar);

    const body = document.createElement("div");
    body.className = "exp-overlay-body";
    root.appendChild(body);

    function rerender() {
      const ov = game.omniverse;
      const echoes = new Decimal(ov.echoes || 0);
      let html = "<p><b>" + format(echoes) + "</b> Omniversal Echoes &nbsp;|&nbsp; " +
        (ov.reconstitutions || 0) + " reconstitution" + ((ov.reconstitutions === 1) ? "" : "s") + "</p>";
      html += "<p style='font-size:12px;color:#333'>Reconstitute to hard-reset your run for Echoes, then spend them here. Bonuses persist across every future run.</p>";
      body.innerHTML = html;

      const recBtn = document.createElement("button");
      recBtn.textContent = canReconstitute() ? ("Reconstitute for " + format(computeEchoGain()) + " Echoes") : "Reconstitute (reach the omniverse first)";
      recBtn.disabled = !canReconstitute();
      recBtn.onclick = reconstitute;
      body.appendChild(recBtn);

      // group nodes by branch
      const branches = {};
      NODES.forEach(function (nd) { (branches[nd.branch] = branches[nd.branch] || []).push(nd); });
      Object.keys(branches).forEach(function (br) {
        const head = document.createElement("p");
        head.setAttribute("role", "heading"); head.setAttribute("aria-level", "3");
        head.style.margin = "8px 0 2px"; head.style.fontWeight = "bold";
        head.textContent = br;
        body.appendChild(head);
        branches[br].forEach(function (nd) {
          const owned = hasNode(nd.id);
          const b = document.createElement("button");
          b.className = "exp-menu-item";
          b.textContent = (owned ? "✓ " : "") + nd.name + " — " + nd.desc + (owned ? " (owned)" : " [" + nd.cost + " Echoes]");
          b.disabled = owned || new Decimal(game.omniverse.echoes || 0).lt(nd.cost);
          b.setAttribute("aria-label", nd.name + ". " + nd.desc + ". " + (owned ? "Owned." : "Costs " + nd.cost + " echoes."));
          b.onclick = function () {
            if (owned) return;
            if (new Decimal(game.omniverse.echoes || 0).gte(nd.cost)) {
              game.omniverse.echoes = new Decimal(game.omniverse.echoes).sub(nd.cost);
              game.omniverse.nodes[nd.id] = true;
              if (typeof save === "function") save();
              if (typeof window.announce === "function") window.announce(nd.name + " purchased.");
              rerender();
            }
          };
          body.appendChild(b);
        });
      });
    }
    rerender();
    document.body.appendChild(root);
    root.addEventListener("keydown", function (e) { if (e.key === "Escape") root.remove(); });
    root.focus();
  }
  window.openConstellation = openConstellation;
})();
