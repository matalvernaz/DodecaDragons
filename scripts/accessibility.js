// Accessibility layer for DodecaDragons.
//
// Additive only: this enhances the existing DOM with screen-reader semantics
// and keyboard operability without touching game logic. It is loaded after all
// game scripts, so the rendered DOM, `tabData`, and (shortly after) `game`
// already exist. Anything that depends on `game` is guarded and runs on an
// interval, because the inline `load()` call that creates `game` fires after
// this file executes.

(function () {
  "use strict";

  const ENHANCE_INTERVAL_MS = 1000; // re-sweep so dynamically added controls get enhanced
  const UNLOCK_POLL_MS = 500;       // cadence for watching game.unlocks
  const ENHANCED_ATTR = "data-a11y"; // marks an element we've already processed
  const RELISTEN_DELAY_MS = 50;      // gap before re-setting identical live text

  // --- Write-on-change guard (NVDA churn fix) ------------------------------
  // The game rewrites ~275 text nodes every 150ms; most writes set the SAME
  // value, but each one still mutates the DOM and forces NVDA to rebuild its
  // virtual buffer, which is what makes navigation lag. We redefine textContent
  // on the game's value spans so an identical-text write on a pure-text leaf is
  // skipped — behaviourally a no-op (the DOM ends up identical), but no mutation
  // event fires. Scoped per element (not a global prototype override) and only
  // short-circuits leaves with no child elements, so it can't drop a write that
  // is meant to replace child nodes.
  const TEXT_DESC = Object.getOwnPropertyDescriptor(Node.prototype, "textContent");
  function guardTextContent(el) {
    if (!el || el.__a11yTextGuarded || !TEXT_DESC) return;
    el.__a11yTextGuarded = true;
    Object.defineProperty(el, "textContent", {
      configurable: true,
      enumerable: false,
      get: function () { return TEXT_DESC.get.call(this); },
      set: function (v) {
        if (this.childElementCount === 0 && TEXT_DESC.get.call(this) === String(v)) return;
        TEXT_DESC.set.call(this, v);
      }
    });
  }

  // --- Live regions --------------------------------------------------------
  // The game rewrites resource counters many times per second; those must NOT
  // be announced or the screen reader is rendered useless. Only discrete events
  // (a new area unlocking, an on-demand readout) are spoken here.
  let politeRegion = null;
  let assertiveRegion = null;
  let politeTimer = null;
  let assertiveTimer = null;

  function makeLiveRegion(id, politeness) {
    const el = document.createElement("div");
    el.id = id;
    el.className = "sr-only";
    el.setAttribute("aria-live", politeness);
    el.setAttribute("role", politeness === "assertive" ? "alert" : "status");
    el.setAttribute("aria-atomic", "true");
    document.body.appendChild(el);
    return el;
  }

  // Announce a discrete message. Clearing then re-setting the text forces the
  // screen reader to speak repeated identical messages (e.g. two readouts).
  function announce(message, assertive) {
    const region = assertive ? assertiveRegion : politeRegion;
    if (!region || !message) return;
    // Clear any pending write for this region so rapid calls don't stack timers
    // and race; the latest message wins rather than all firing at once.
    if (assertive && assertiveTimer) clearTimeout(assertiveTimer);
    if (!assertive && politeTimer) clearTimeout(politeTimer);
    region.textContent = "";
    const id = setTimeout(function () {
      region.textContent = message;
      if (assertive) assertiveTimer = null; else politeTimer = null;
    }, RELISTEN_DELAY_MS);
    if (assertive) assertiveTimer = id; else politeTimer = id;
  }
  window.announce = announce; // exposed so game code can be wired to it later

  function textOf(id) {
    const el = document.getElementById(id);
    return el ? el.textContent.trim() : "";
  }

  // "cyanSigils" -> "Cyan sigils"
  function humanize(key) {
    const spaced = key.replace(/([A-Z])/g, " $1").toLowerCase().trim();
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
  }

  // --- Enhancement sweep (idempotent) -------------------------------------
  function asButton(el, label) {
    if (el.hasAttribute(ENHANCED_ATTR)) return;
    el.setAttribute(ENHANCED_ATTR, "");
    el.setAttribute("role", "button");
    el.setAttribute("tabindex", "0");
    if (label) el.setAttribute("aria-label", label);
  }

  function enhance() {
    // Window title bars become level-2 headings so NVDA's H key can jump
    // between the ~47 panels. role/aria-level avoids changing the tag and
    // breaking 98.css styling.
    document.querySelectorAll(".title-bar-text").forEach(function (el) {
      if (!el.hasAttribute("role")) {
        el.setAttribute("role", "heading");
        el.setAttribute("aria-level", "2");
      }
    });

    // Click-only controls that have no keyboard path in the base game.
    document.querySelectorAll(".resourceRow").forEach(function (el) { asButton(el); });
    document.querySelectorAll(".magicChallenge").forEach(function (el) { asButton(el); });
    document.querySelectorAll(".achievement").forEach(function (el) { asButton(el); });

    const dragon = document.getElementById("dragonImg");
    if (dragon) asButton(dragon, "Pet the dragon to produce fire");

    // Decorative imagery (resource icons, logo, sigil art) is labelled by
    // adjacent text, so silence it. Controls given an aria-label above keep
    // their name regardless of alt="".
    document.querySelectorAll("img:not([alt])").forEach(function (img) {
      img.setAttribute("alt", "");
    });

    // Pan arrows and the FPS readout are purely visual; the canvas pan they
    // drive is cosmetic for a screen-reader user.
    ["navArrows", "fps"].forEach(function (id) {
      const el = document.getElementById(id);
      if (el && !el.hasAttribute("aria-hidden")) el.setAttribute("aria-hidden", "true");
    });

    // Each window becomes a labelled landmark region, so NVDA's D key cycles
    // window-to-window as an alternative to the H (heading) navigation above.
    document.querySelectorAll(".box").forEach(function (box) {
      if (box.getAttribute("role") === "region") return;
      const t = box.querySelector(".title-bar-text");
      if (t) { box.setAttribute("role", "region"); box.setAttribute("aria-label", t.textContent.trim()); }
    });

    // Write-on-change guard on the game's value spans (see TEXT_DESC above).
    document.querySelectorAll(".window-body a").forEach(guardTextContent);

    applyQuietMode();
  }

  // Quiet mode: the game rewrites ~275 text nodes every 150ms. For a screen
  // reader that is a constant flood of accessibility-tree events that keeps
  // NVDA's virtual buffer churning and makes browse mode and keystrokes lag.
  // The continuously-updating rate displays are redundant with the R readout,
  // so we drop them from the accessibility tree (aria-hidden) — their text is
  // still readable by JS for the readout. Toggleable; default on.
  // Quiet mode was a mistake: aria-hiding the inline rate spans stripped numbers
  // out of sentences ("You have X gold (/s, /click)" -> blanks) without helping
  // navigation. This now only UN-hides anything a prior version hid, cleaning up
  // existing sessions. Churn is to be handled by write-on-change instead.
  function applyQuietMode() {
    document.querySelectorAll('[id$="PerSecond"][aria-hidden], [id$="PerClick"][aria-hidden]').forEach(function (el) {
      el.removeAttribute("aria-hidden");
    });
    const firstRow = document.querySelector(".resourceRow");
    const resTab = firstRow && firstRow.closest(".box");
    if (resTab) resTab.removeAttribute("aria-hidden");
  }
  window.applyQuietMode = applyQuietMode;

  // --- Keyboard activation -------------------------------------------------
  // Enter/Space triggers a click on any control we promoted to role="button".
  // Native <button>s are untouched (they already handle both keys).
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
    const el = e.target;
    if (el && el.getAttribute && el.getAttribute("role") === "button" &&
        el.hasAttribute(ENHANCED_ATTR)) {
      e.preventDefault();
      el.click();
    }
  });

  // --- Hover-only info mirrored to focus -----------------------------------
  // Magic-challenge and achievement descriptions are revealed only on
  // mouseover in the base game. Mirror that on keyboard focus and speak the
  // resulting description, which lands in a panel far from the focused tile.
  document.addEventListener("focusin", function (e) {
    const el = e.target;
    if (!el || !el.closest) return;

    const challenge = el.closest(".magicChallenge");
    if (challenge && typeof showMagicChallenge === "function") {
      const tiles = document.querySelectorAll(".magicChallenge");
      const idx = Array.prototype.indexOf.call(tiles, challenge) + 1;
      showMagicChallenge(idx);
      announce(textOf("magicChallengeTitle") + ". " + textOf("magicChallengeInfo"));
      return;
    }

    const achievement = el.closest(".achievement");
    if (achievement && achievement.id && typeof showAchievementInfo === "function") {
      const parsed = achievement.id.slice(3).split("x"); // "ach1x3" -> ["1","3"]
      showAchievementInfo(parseInt(parsed[0], 10), parseInt(parsed[1], 10));
      announce(textOf("achievementInfo"));
    }
  });

  // --- Announce newly unlocked areas --------------------------------------
  let lastUnlocks = null;
  function watchUnlocks() {
    if (typeof game !== "object" || !game || typeof tabData !== "object") return;
    // First tick after the save loads: adopt the current count as the baseline so
    // we don't announce every already-unlocked area to a returning player.
    if (lastUnlocks === null) { lastUnlocks = game.unlocks; return; }
    if (game.unlocks > lastUnlocks) {
      const names = [];
      for (let lvl = lastUnlocks + 1; lvl <= game.unlocks; lvl++) {
        Object.keys(tabData).forEach(function (k) {
          if (tabData[k][2] === lvl) names.push(humanize(k));
        });
      }
      // Coalesce into one message; separate announce() calls would clobber.
      if (names.length) announce("New area unlocked: " + names.join(", "));
    }
    lastUnlocks = game.unlocks;
  }

  // --- On-demand stat readout ----------------------------------------------
  // The core idle loop is "watch a number rise". R speaks the headline totals
  // so a screen-reader user needn't re-hunt for them in browse mode.
  // Full on-demand snapshot of every unlocked resource. Reuses the already
  // labelled ".resourceRow" elements ("Gold: 1.2M", "Fire: 3.4K", ...), which
  // are hidden from the live a11y tree in quiet mode but still readable here.
  function readAll() {
    const rows = Array.prototype.slice.call(document.querySelectorAll(".resourceRow"))
      .filter(function (r) { return r.offsetParent !== null; }) // unlocked = not display:none
      .map(function (r) { return r.textContent.replace(/\s+/g, " ").trim(); })
      .filter(Boolean);
    const gps = textOf("goldPerSecond");
    let msg = rows.join(". ");
    if (gps) msg += (msg ? ". " : "") + gps + " gold per second";
    announce(msg || "No resources yet.");
  }

  // --- Bootstrap -----------------------------------------------------------
  function init() {
    const style = document.createElement("style");
    style.textContent =
      ".sr-only{position:absolute!important;width:1px;height:1px;padding:0;" +
      "margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;}";
    document.head.appendChild(style);

    const h1 = document.createElement("h1");
    h1.className = "sr-only";
    h1.textContent = "DodecaDragons";
    document.body.insertBefore(h1, document.body.firstChild);

    politeRegion = makeLiveRegion("a11yLive", "polite");
    assertiveRegion = makeLiveRegion("a11yAlert", "assertive");

    enhance();
    setInterval(enhance, ENHANCE_INTERVAL_MS);
    setInterval(watchUnlocks, UNLOCK_POLL_MS);

    if (typeof Mousetrap !== "undefined") Mousetrap.bind("r", readAll);

    announce("DodecaDragons loaded. Press R at any time to hear your resources.");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
