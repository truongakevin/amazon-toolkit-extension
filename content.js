(() => {
  "use strict";

  const STORAGE_KEY = "amazonSearchToolkitSettings";
  const LEGACY_STORAGE_KEY = "amazonDeliveryFilterSettings";
  const HIDDEN_CLASS = "amz-search-toolkit-hidden";
  const HIDDEN_ATTR = "data-amz-search-toolkit-hidden";
  const DEBUG_BADGE_ID = "amz-search-toolkit-debug-badge";
  const MORE_RESULTS_HIDDEN_ATTR = "data-amz-more-results-hidden";
  const SPONSORED_HIDDEN_ATTR = "data-amz-sponsored-hidden";
  const SPONSORED_WIDGET_HIDDEN_ATTR = "data-amz-sponsored-widget-hidden";
  const SEARCH_RESULT_SELECTOR = 'div[data-component-type="s-search-result"]';
  const SEARCH_RESULT_FALLBACK_SELECTOR = '#search div.s-result-item[data-asin]:not([data-asin=""])';
  const RESULTS_CONTAINER_SELECTOR = ".s-main-slot.s-result-list.s-search-results";
  const NEXT_PAGE_SELECTOR = "a.s-pagination-next";
  const PAGES_INPUT_ID = "amz-toolkit-inline-pages";
  const SUPPORT_URL = "https://buymeacoffee.com/kevinatruong";

  const MONTHS = {
    jan: 0,
    january: 0,
    feb: 1,
    february: 1,
    mar: 2,
    march: 2,
    apr: 3,
    april: 3,
    may: 4,
    jun: 5,
    june: 5,
    jul: 6,
    july: 6,
    aug: 7,
    august: 7,
    sep: 8,
    sept: 8,
    september: 8,
    oct: 9,
    october: 9,
    nov: 10,
    november: 10,
    dec: 11,
    december: 11
  };

  let settings = {
    mode: "off",
    maxDate: "",
    includeUnknown: true,
    includeSponsored: false,
    minPrice: "",
    maxPrice: ""
  };

  let observer;
  let debounceTimer;
  let guardIntervalId;
  let pageLoadInFlight = false;

  // ============================================
  // CONSOLE LOG BUFFER (for export debug)
  // ============================================
  const LOG_BUFFER_MAX = 500;
  const logBuffer = [];

  (() => {
    const _intercept = (level, original) => (...args) => {
      original(...args);
      const line = args.map((a) => {
        try { return typeof a === "object" ? JSON.stringify(a) : String(a); }
        catch (_) { return String(a); }
      }).join(" ");
      logBuffer.push({ t: Date.now(), level, msg: line });
      if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
    };
    console.log   = _intercept("log",   console.log.bind(console));
    console.info  = _intercept("info",  console.info.bind(console));
    console.warn  = _intercept("warn",  console.warn.bind(console));
    console.error = _intercept("error", console.error.bind(console));
  })();
  let loadedPageCount = 1;
  let nextPageUrl = "";
  const loadedAsins = new Set();
  const REAPPLY_GUARD_MS = 800;

  function getOrCreateDebugBadge() {
    let badge = document.getElementById(DEBUG_BADGE_ID);
    if (badge) return badge;

    badge = document.createElement("div");
    badge.id = DEBUG_BADGE_ID;
    badge.className = "amz-search-toolkit-debug-badge";
    badge.setAttribute("role", "status");
    badge.setAttribute("aria-live", "polite");
    badge.textContent = "Shown: 0 / Hidden: 0";

    const toolbar = document.getElementById(INLINE_FILTER_UI_ID);
    if (toolbar) {
      toolbar.appendChild(badge);
    } else {
      document.body.appendChild(badge);
    }
    return badge;
  }

  function updateDebugBadge(total, hidden) {
    const badge = getOrCreateDebugBadge();
    const shown = Math.max(total - hidden, 0);
    badge.textContent = `Shown: ${shown} / Hidden: ${hidden}`;
    badge.classList.remove("amz-search-toolkit-debug-badge-hidden");
    // Re-parent into toolbar if badge ended up on body and toolbar now exists
    const toolbar = document.getElementById(INLINE_FILTER_UI_ID);
    if (toolbar && badge.parentElement === document.body) {
      toolbar.appendChild(badge);
    }
  }

  function hideDebugBadge() {
    const badge = document.getElementById(DEBUG_BADGE_ID);
    if (!badge) return;
    badge.classList.add("amz-search-toolkit-debug-badge-hidden");
  }

  function isAmazonSearchPage() {
    const path = window.location.pathname;
    return path.startsWith("/s") || path.startsWith("/gp/search");
  }

  function startOfLocalDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  function parseInputDate(dateString) {
    if (!dateString) return null;
    const date = new Date(dateString + "T00:00:00");
    if (Number.isNaN(date.getTime())) return null;
    return startOfLocalDay(date);
  }

  function getResultsContainer() {
    return document.querySelector(RESULTS_CONTAINER_SELECTOR);
  }

  function discoverNextPageUrl(doc = document) {
    return doc.querySelector(NEXT_PAGE_SELECTOR)?.href || "";
  }

  function indexCurrentPageAsins() {
    loadedAsins.clear();
    getSearchResultCards().forEach((card) => {
      const asin = card.getAttribute("data-asin");
      if (asin) loadedAsins.add(asin);
    });
  }

  async function fetchDocument(url) {
    const response = await fetch(url, { credentials: "include" });
    const html = await response.text();
    const wrapper = document.createElement("div");
    wrapper.innerHTML = html;
    return wrapper;
  }

  function extractCardsFromFetchedPage(pageDoc) {
    const primary = Array.from(pageDoc.querySelectorAll(SEARCH_RESULT_SELECTOR));
    const fallback = Array.from(pageDoc.querySelectorAll(SEARCH_RESULT_FALLBACK_SELECTOR));
    const out = [];
    const seen = new Set();

    for (const card of [...primary, ...fallback]) {
      const asin = card.getAttribute("data-asin");
      if (!asin || seen.has(asin) || loadedAsins.has(asin)) continue;
      seen.add(asin);
      out.push(card);
    }

    return out;
  }

  async function loadPagesUpTo(targetPage) {
    const target = Math.max(1, Math.min(50, Number(targetPage) || 1));
    if (pageLoadInFlight || target <= loadedPageCount) return;

    const container = getResultsContainer();
    if (!container) return;

    pageLoadInFlight = true;

    // Pause observer while we append many cards
    if (observer) observer.disconnect();

    try {
      let url = nextPageUrl || discoverNextPageUrl(document);

      while (loadedPageCount < target && url) {
        const pageDoc = await fetchDocument(url);
        const cards = extractCardsFromFetchedPage(pageDoc);

        cards.forEach((card) => {
          const asin = card.getAttribute("data-asin");
          if (asin) loadedAsins.add(asin);
          container.appendChild(card);
        });

        loadedPageCount += 1;
        nextPageUrl = discoverNextPageUrl(pageDoc);
        url = nextPageUrl;
      }

      applyFilters();
    } catch (error) {
      console.error("[Amazon Search Toolkit] Failed to load additional pages:", error);
    } finally {
      pageLoadInFlight = false;
      observeDynamicContent();
    }
  }

  function shouldKeepItem(deliveryWindow) {
    if (settings.mode === "off") return true;
    if (!deliveryWindow) return settings.includeUnknown;
    if (settings.mode === "byDate") {
      const maxDate = parseInputDate(settings.maxDate);
      if (!maxDate) return true;
      return deliveryWindow.end <= maxDate;
    }
    return true;
  }

  function inferYear(monthIndex, dayOfMonth) {
    const now = new Date();
    const currentYear = now.getFullYear();
    const today = startOfLocalDay(now);

    let candidate = new Date(currentYear, monthIndex, dayOfMonth);
    candidate = startOfLocalDay(candidate);

    if (candidate < new Date(today.getTime() - 24 * 60 * 60 * 1000)) {
      candidate = startOfLocalDay(new Date(currentYear + 1, monthIndex, dayOfMonth));
    }

    return candidate;
  }

  function extractMonthDayDates(text) {
    const normalized = text.toLowerCase().replace(/\s+/g, " ");
    const regex = /(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})/gi;

    const dates = [];
    let match;

    while ((match = regex.exec(normalized)) !== null) {
      const monthText = match[1].toLowerCase().replace(".", "");
      const monthIndex = MONTHS[monthText];
      const dayOfMonth = Number(match[2]);

      if (monthIndex === undefined || dayOfMonth < 1 || dayOfMonth > 31) continue;

      dates.push(inferYear(monthIndex, dayOfMonth));
    }

    return dates;
  }

  function parseDeliveryWindow(rawText) {
    if (!rawText) return null;

    const text = rawText
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!text) return null;

    const lower = text.toLowerCase();
    const today = startOfLocalDay(new Date());

    if (lower.includes("today")) {
      return { start: today, end: today, source: text };
    }

    if (lower.includes("tomorrow")) {
      const tomorrow = startOfLocalDay(new Date(today.getTime() + 24 * 60 * 60 * 1000));
      return { start: tomorrow, end: tomorrow, source: text };
    }

    if (lower.includes("overnight")) {
      // Overnight arrives early morning tomorrow (e.g. 4-8am) — before regular
      // "tomorrow" daytime deliveries. Use a sort key just after today but before
      // midnight of tomorrow so overnight sorts ahead of normal tomorrow listings.
      const overnightKey = new Date(today.getTime() + 1);
      return { start: overnightKey, end: overnightKey, source: text };
    }

    const dates = extractMonthDayDates(text);
    if (dates.length === 0) return null;

    dates.sort((a, b) => a - b);

    const isRangeText = /\-|\bto\b|\bthrough\b|\bthru\b/.test(lower) && dates.length >= 2;
    if (isRangeText) {
      return {
        start: startOfLocalDay(dates[0]),
        end: startOfLocalDay(dates[dates.length - 1]),
        source: text
      };
    }

    return {
      start: startOfLocalDay(dates[0]),
      end: startOfLocalDay(dates[0]),
      source: text
    };
  }

  function getCandidateDeliveryTexts(card) {
    const selectors = [
      '[data-cy="delivery-recipe"]',
      '[data-cy="delivery-block"]',
      '.a-color-base.a-text-bold',
      '.a-row.a-size-base.a-color-secondary',
      '.a-row span'
    ];

    const out = [];

    selectors.forEach((selector) => {
      card.querySelectorAll(selector).forEach((el) => {
        const text = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (!text) return;

        if (
          /delivery|get it|arrives|overnight|today|tomorrow|\bby\b|\bmon\b|\btue\b|\bwed\b|\bthu\b|\bfri\b|\bsat\b|\bsun\b/i.test(
            text
          )
        ) {
          out.push(text);
        }
      });
    });

    return [...new Set(out)];
  }

  function extractDeliveryWindowFromCard(card) {
    const candidates = getCandidateDeliveryTexts(card);

    for (const text of candidates) {
      const parsed = parseDeliveryWindow(text);
      if (parsed) return parsed;
    }

    return null;
  }

  function parsePriceTextToNumber(text) {
    if (!text) return null;

    let normalized = text.replace(/[^\d.,-]/g, "").trim();
    if (!normalized) return null;

    if (normalized.includes(",") && normalized.includes(".")) {
      normalized = normalized.replace(/,/g, "");
    } else if (normalized.includes(",") && !normalized.includes(".")) {
      normalized = normalized.replace(/,/g, ".");
    }

    const value = Number.parseFloat(normalized);
    return Number.isFinite(value) ? value : null;
  }

  function extractPriceFromCard(card) {
    const selectors = [
      ".a-price:not(.a-text-price) .a-offscreen",
      ".a-price .a-offscreen"
    ];

    for (const selector of selectors) {
      const nodes = Array.from(card.querySelectorAll(selector));
      for (const node of nodes) {
        const text = (node.textContent || "").trim();
        const value = parsePriceTextToNumber(text);
        if (value !== null) return value;
      }
    }

    return null;
  }

  function shouldKeepItem(card, deliveryWindow) {
    const hasDeliveryFilter = settings.mode === "byDate";
    const minPrice = Number.parseFloat(settings.minPrice);
    const maxPrice = Number.parseFloat(settings.maxPrice);
    const hasMinPrice = Number.isFinite(minPrice);
    const hasMaxPrice = Number.isFinite(maxPrice);

    if (hasDeliveryFilter) {
      if (!deliveryWindow && !settings.includeUnknown) return false;
      if (deliveryWindow) {
        const maxDate = parseInputDate(settings.maxDate);
        if (maxDate && deliveryWindow.end > maxDate) return false;
      }
    }

    if (hasMinPrice || hasMaxPrice) {
      const price = extractPriceFromCard(card);
      if (price === null) return false;
      if (hasMinPrice && price < minPrice) return false;
      if (hasMaxPrice && price > maxPrice) return false;
    }

    return true;
  }

  function setCardHiddenState(card, shouldHide) {
    card.classList.toggle(HIDDEN_CLASS, shouldHide);

    if (shouldHide) {
      card.setAttribute(HIDDEN_ATTR, "1");
      card.style.setProperty("display", "none", "important");
      card.setAttribute("aria-hidden", "true");
      return;
    }

    card.removeAttribute(HIDDEN_ATTR);
    card.style.removeProperty("display");
    card.removeAttribute("aria-hidden");
  }

  function isSponsoredCard(card) {
    // Prefer explicit, visible sponsored markers only.
    const explicitMarkers = card.querySelectorAll(
      'a.s-widget-sponsored-label-text, [data-action="multi-ad-feedback-form-trigger"], .puis-sponsored-label-text, span.a-color-secondary[aria-label*="Sponsored information"]'
    );

    for (const marker of explicitMarkers) {
      const style = window.getComputedStyle(marker);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const rect = marker.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      return true;
    }

    // Some sponsored cards live inside dedicated sponsored widgets where the
    // label is rendered at widget level (not directly in each card).
    const sponsoredWidgetRoot =
      card.closest('[cel_widget_id*="FEATURED_ASINS_LIST"]') ||
      card.closest('[data-cel-widget*="FEATURED_ASINS_LIST"]');

    if (
      sponsoredWidgetRoot &&
      sponsoredWidgetRoot.querySelector(
        'a.s-widget-sponsored-label-text, [data-action="multi-ad-feedback-form-trigger"]'
      )
    ) {
      return true;
    }

    return false;
  }

  function setSponsoredHiddenState(card, shouldHide) {
    if (!shouldHide) {
      card.removeAttribute(SPONSORED_HIDDEN_ATTR);
      return;
    }

    card.setAttribute(SPONSORED_HIDDEN_ATTR, "1");
    setCardHiddenState(card, true);
  }

  function getSearchResultCards() {
    const container = getResultsContainer();

    let scopedCards = [];
    if (container) {
      scopedCards = Array.from(
        container.querySelectorAll(
          ':scope > div[data-component-type="s-search-result"], :scope > div.s-result-item[data-asin]:not([data-asin=""])'
        )
      );
    }

    const primaryCards = scopedCards.length > 0
      ? scopedCards
      : Array.from(document.querySelectorAll(SEARCH_RESULT_SELECTOR));
    const fallbackCards = scopedCards.length > 0
      ? []
      : Array.from(document.querySelectorAll(SEARCH_RESULT_FALLBACK_SELECTOR));

    const seenAsins = new Set();
    const merged = [];

    for (const card of [...primaryCards, ...fallbackCards]) {
      const asin = card.getAttribute("data-asin");
      if (!asin) continue;
      if (seenAsins.has(asin)) continue;
      seenAsins.add(asin);
      merged.push(card);
    }

    return merged;
  }

  function hasActiveFilter() {
    const minPrice = Number.parseFloat(settings.minPrice);
    const maxPrice = Number.parseFloat(settings.maxPrice);
    return settings.mode === "byDate" || Number.isFinite(minPrice) || Number.isFinite(maxPrice);
  }

  function removeMoreResultsHeading() {
    // Amazon inserts a split marker widget with header text "More results".
    // Hide it so all listings appear as one continuous section.
    const hideRow = (node) => {
      const row = node?.closest(".s-result-item") || node;
      if (row instanceof HTMLElement) {
        row.setAttribute(MORE_RESULTS_HIDDEN_ATTR, "1");
        row.style.setProperty("display", "none", "important");
        row.setAttribute("aria-hidden", "true");
      }
    };

    const headers = Array.from(document.querySelectorAll(".s-messaging-widget-results-header h2"));

    headers.forEach((h2) => {
      const txt = (h2.textContent || "").trim().toLowerCase();
      if (txt !== "more results") return;

      const messageRoot =
        h2.closest('[data-component-type="s-messaging-widget-results-header"]') ||
        h2.closest('[data-cel-widget*="MESSAGING"]') ||
        h2.closest(".s-result-item");

      hideRow(messageRoot);

      // Hide any adjacent accessibility header row created for this widget too.
      const parent = messageRoot?.parentElement;
      if (parent) {
        parent
          .querySelectorAll('[data-component-type="s-messaging-widget-results-header-accessibility-header"]')
          .forEach((el) => {
            hideRow(el);
          });
      }
    });

    // Hide "Related searches" reformulation blocks that appear inline between
    // search result cards and split the grid/list into sections.
    const relatedHeaders = Array.from(document.querySelectorAll("h2"));
    relatedHeaders.forEach((h2) => {
      const txt = (h2.textContent || "").trim().toLowerCase();
      if (txt !== "related searches") return;

      const relatedRoot =
        h2.closest('[data-component-type="text-reformulation-widget"]') ||
        h2.closest('[data-cel-widget*="MAIN-TEXT_REFORMULATION"]') ||
        h2.closest('[cel_widget_id*="MAIN-TEXT_REFORMULATION"]') ||
        h2.closest('[class*="template=TEXT_REFORMULATION"]') ||
        h2.closest(".s-result-item");

      hideRow(relatedRoot);
    });

    // Hide pagination/help/teaser blocks that can appear between product rows,
    // especially after multipage append or sort.
    const dividerSelectors = [
      ".s-pagination-container",
      '[cel_widget_id*="MAIN-PAGINATION"]',
      '[data-cel-widget*="MAIN-PAGINATION"]',
      '[class*="template=PAGINATION"]',
      '[cel_widget_id*="MAIN-FEEDBACK"]',
      '[data-cel-widget*="MAIN-FEEDBACK"]',
      '[class*="widgetId=feedback"]',
      'a[href*="/gp/help/customer/display.html?nodeId="]',
      'a[href*="/gp/help/customer/contact-us"]',
      '[cel_widget_id*="MAIN-RUFUS_TEASER"]',
      '[data-cel-widget*="MAIN-RUFUS_TEASER"]',
      '[cel_widget_id*="MAIN-TEXT_REFORMULATION"]',
      '[data-cel-widget*="MAIN-TEXT_REFORMULATION"]',
      '[class*="template=TEXT_REFORMULATION"]',
      '[class*="widgetId=loom-desktop-bottom-slot_related-searches"]',
      '[data-component-type="text-reformulation-widget"]',
      '[aria-label^="Related searches in"]'
    ];

    dividerSelectors.forEach((sel) => {
      document.querySelectorAll(sel).forEach((el) => hideRow(el));
    });

    // Hide sponsored widgets/rows (including inline sponsored carousels)
    // unless user explicitly enables "Include sponsored".
    if (!settings.includeSponsored) {
      const sponsoredSelectors = [
        "a.s-widget-sponsored-label-text",
        '[aria-label*="Sponsored information"]',
        '[data-action="multi-ad-feedback-form-trigger"]'
      ];

      sponsoredSelectors.forEach((sel) => {
        document.querySelectorAll(sel).forEach((el) => {
          const root =
            el.closest('[cel_widget_id*="FEATURED_ASINS_LIST"]') ||
            el.closest('[data-cel-widget*="FEATURED_ASINS_LIST"]') ||
            el.closest(".s-widget-container") ||
            el.closest(".s-result-item");

          const row = root?.closest(".s-result-item") || root || el;
          if (row instanceof HTMLElement) {
            row.setAttribute(SPONSORED_WIDGET_HIDDEN_ATTR, "1");
            row.style.setProperty("display", "none", "important");
            row.setAttribute("aria-hidden", "true");
          }
        });
      });
    } else {
      document
        .querySelectorAll(`[${SPONSORED_WIDGET_HIDDEN_ATTR}="1"]`)
        .forEach((row) => {
          if (!(row instanceof HTMLElement)) return;
          row.removeAttribute(SPONSORED_WIDGET_HIDDEN_ATTR);
          row.style.removeProperty("display");
          row.removeAttribute("aria-hidden");
        });
    }
  }

  function applyFilters() {
    if (!isAmazonSearchPage()) {
      hideDebugBadge();
      return;
    }

    // Apply section/widget visibility adjustments first so card counting can
    // account for rows hidden at widget level (e.g. sponsored carousels).
    removeMoreResultsHeading();

    const cards = getSearchResultCards();
    let totalCount = 0;
    let hiddenCount = 0;

    cards.forEach((card) => {
      totalCount += 1;

      const hiddenBySponsoredWidget =
        card.hasAttribute(SPONSORED_WIDGET_HIDDEN_ATTR) ||
        Boolean(card.closest(`[${SPONSORED_WIDGET_HIDDEN_ATTR}="1"]`));

      if (hiddenBySponsoredWidget) {
        hiddenCount += 1;
        return;
      }

      const sponsored = isSponsoredCard(card);
      if (sponsored && !settings.includeSponsored) {
        setSponsoredHiddenState(card, true);
        hiddenCount += 1;
        return;
      }

      setSponsoredHiddenState(card, false);
      const deliveryWindow = extractDeliveryWindowFromCard(card);
      const keep = shouldKeepItem(card, deliveryWindow);
      setCardHiddenState(card, !keep);
      if (!keep) hiddenCount += 1;
    });

    updateDebugBadge(totalCount, hiddenCount);
  }

  function debounceApplyFilters() {
    clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => {
      applyFilters();
      injectToolbar();
    }, 120);
  }

  function stopReapplyGuard() {
    if (!guardIntervalId) return;
    window.clearInterval(guardIntervalId);
    guardIntervalId = undefined;
  }

  function ensureReapplyGuard() {
    stopReapplyGuard();

    if (!isAmazonSearchPage() || !hasActiveFilter()) return;

    guardIntervalId = window.setInterval(() => {
      applyFilters();
    }, REAPPLY_GUARD_MS);
  }

  function injectStyle() {
    if (document.getElementById("amz-search-toolkit-style")) return;

    const style = document.createElement("style");
    style.id = "amz-search-toolkit-style";
    style.textContent = `
      .${HIDDEN_CLASS} {
        display: none !important;
      }

      .amz-search-toolkit-debug-badge {
        font-size: 13px;
        font-family: 'Amazon Ember', Arial, sans-serif;
        color: #565959;
        white-space: nowrap;
        pointer-events: none;
        user-select: none;
      }

      .amz-search-toolkit-debug-badge-hidden {
        display: none !important;
      }
    `;
    document.documentElement.appendChild(style);
  }

  async function loadSettings() {
    const result = await chrome.storage.sync.get([STORAGE_KEY, LEGACY_STORAGE_KEY]);
    const current = result[STORAGE_KEY];
    const legacy = result[LEGACY_STORAGE_KEY];
    const mergedSettings = current || legacy || {};

    settings = {
      ...settings,
      ...mergedSettings
    };

    if (!current && legacy) {
      await chrome.storage.sync.set({ [STORAGE_KEY]: mergedSettings });
    }
  }

  function observeDynamicContent() {
    if (observer) observer.disconnect();

    observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (
          mutation.type === "attributes" ||
          mutation.addedNodes.length ||
          mutation.removedNodes.length
        ) {
          debounceApplyFilters();
          break;
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style"]
    });
  }

  function setupStorageListener() {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "sync") return;
      const incoming = changes[STORAGE_KEY]?.newValue || changes[LEGACY_STORAGE_KEY]?.newValue;
      if (!incoming) return;
      settings = { ...settings, ...incoming };
      ensureReapplyGuard();
      debounceApplyFilters();
    });
  }

  const INLINE_FILTER_UI_ID = "amz-search-toolkit-inline-ui";

  function injectToolbar() {
    if (!isAmazonSearchPage()) return;
    if (document.getElementById(INLINE_FILTER_UI_ID)) return;

    const anchor = document.querySelector('[cel_widget_id="UPPER-RESULT_INFO_BAR-0"]');
    if (!anchor) return;

    const root = document.createElement("div");
    root.id = INLINE_FILTER_UI_ID;
    root.style.cssText =
      "display:flex; flex-direction:column; align-items:stretch; gap:8px;" +
      "padding:6px 18px; background:#fff; border-bottom:1px solid #ddd;" +
      "font-family:'Amazon Ember',Arial,sans-serif; font-size:13px; color:#0F1111;";

    const row1 = document.createElement("div");
    row1.style.cssText = "display:flex; align-items:center; justify-content:flex-end; gap:10px; flex-wrap:wrap;";
    const row2 = document.createElement("div");
    row2.style.cssText = "display:flex; align-items:center; justify-content:flex-end; gap:10px; flex-wrap:wrap;";

    root.appendChild(row1);
    root.appendChild(row2);

    const makeBtn = (text, onClick) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = text;
      btn.style.cssText =
        "background:#fff; border:1px solid #888c8c; border-radius:3px;" +
        "height:29px; padding:0 10px; font-size:13px; font-family:inherit; font-weight:400; cursor:pointer;" +
        "color:#0F1111; line-height:1; white-space:nowrap; box-shadow:0 2px 5px rgba(213,217,217,.5);";
      btn.addEventListener("mouseenter", () => { btn.style.background = "#f7f8f8"; });
      btn.addEventListener("mouseleave", () => { btn.style.background = "#fff"; });
      btn.addEventListener("click", onClick);
      return btn;
    };

    const makeLabel = (text) => {
      const s = document.createElement("span");
      s.textContent = text;
      s.style.cssText = "font-size:13px; color:#0F1111; white-space:nowrap;";
      return s;
    };

    const downloadCurrentPageHtml = () => {
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const htmlBlob = new Blob(
        ["<!DOCTYPE html>\n", document.documentElement.outerHTML],
        { type: "text/html" }
      );

      const htmlUrl = URL.createObjectURL(htmlBlob);
      const dl = Object.assign(document.createElement("a"), {
        href: htmlUrl,
        download: `amazon-search-page-${ts}.html`
      });

      document.body.appendChild(dl);
      dl.click();
      dl.remove();

      setTimeout(() => {
        URL.revokeObjectURL(htmlUrl);
      }, 300);
    };

    const supportBtn = makeBtn("☕ Support", () => {
      window.open(SUPPORT_URL, "_blank", "noopener,noreferrer");
    });
    supportBtn.style.marginRight = "auto";
    row1.appendChild(supportBtn);

    const pagesItem = document.createElement("div");
    pagesItem.className = "filter-item";
    pagesItem.style.cssText = "display:flex; flex-direction:row; column-gap:8px; align-items:center; white-space:nowrap;";

    const pagesTitle = document.createElement("span");
    pagesTitle.className = "filter-sort-title sort-by sort-desc";
    pagesTitle.textContent = "Pages";
    pagesTitle.style.cssText = "font-size:13px; color:#0F1111;";

    const pagesInput = document.createElement("input");
    pagesInput.id = PAGES_INPUT_ID;
    pagesInput.type = "number";
    pagesInput.className = "value-input grey";
    pagesInput.min = "0";
    pagesInput.max = "50";
    pagesInput.step = "1";
    pagesInput.value = String(Math.max(1, Number(settings.pages) || 1));
    pagesInput.style.cssText =
      "height:29px; width:70px; border:1px solid #888c8c; border-radius:3px; background:#fff;" +
      "padding:0 8px; font-size:13px; font-family:inherit; color:#0F1111;" +
      "box-shadow:0 2px 5px rgba(213,217,217,.5);";

    const loadPagesFromInput = async () => {
      const targetPages = Math.max(1, Math.min(50, Number(pagesInput.value) || 1));
      pagesInput.value = String(targetPages);
      settings = { ...settings, pages: targetPages };
      await chrome.storage.sync.set({ [STORAGE_KEY]: settings });
      await loadPagesUpTo(targetPages);
    };

    pagesInput.addEventListener("change", () => {
      loadPagesFromInput();
    });

    pagesItem.appendChild(pagesTitle);
    pagesItem.appendChild(pagesInput);
    row1.appendChild(pagesItem);

    row1.appendChild(makeLabel("Deliver by:"));

    const maxDateEl = document.createElement("input");
    maxDateEl.id = "amz-toolkit-inline-max-date";
    maxDateEl.type = "date";
    maxDateEl.value = settings.maxDate || "";
    maxDateEl.style.cssText =
      "height:29px; border:1px solid #888c8c; border-radius:3px; background:#fff;" +
      "padding:0 8px; font-size:13px; font-family:inherit; color:#0F1111;" +
      "box-shadow:0 2px 5px rgba(213,217,217,.5);";
    row1.appendChild(maxDateEl);

    row1.appendChild(makeLabel("Price:"));

    const minPriceEl = document.createElement("input");
    minPriceEl.id = "amz-toolkit-inline-min-price";
    minPriceEl.type = "number";
    minPriceEl.step = "0.01";
    minPriceEl.min = "0";
    minPriceEl.placeholder = "Min";
    minPriceEl.value = settings.minPrice || "";
    minPriceEl.style.cssText =
      "height:29px; width:80px; border:1px solid #888c8c; border-radius:3px; background:#fff;" +
      "padding:0 8px; font-size:13px; font-family:inherit; color:#0F1111;" +
      "box-shadow:0 2px 5px rgba(213,217,217,.5);";
    row1.appendChild(minPriceEl);

    const maxPriceEl = document.createElement("input");
    maxPriceEl.id = "amz-toolkit-inline-max-price";
    maxPriceEl.type = "number";
    maxPriceEl.step = "0.01";
    maxPriceEl.min = "0";
    maxPriceEl.placeholder = "Max";
    maxPriceEl.value = settings.maxPrice || "";
    maxPriceEl.style.cssText =
      "height:29px; width:80px; border:1px solid #888c8c; border-radius:3px; background:#fff;" +
      "padding:0 8px; font-size:13px; font-family:inherit; color:#0F1111;" +
      "box-shadow:0 2px 5px rgba(213,217,217,.5);";
    row1.appendChild(maxPriceEl);

    const includeUnknownEl = document.createElement("input");
    includeUnknownEl.id = "amz-toolkit-inline-include-unknown";
    includeUnknownEl.type = "checkbox";
    includeUnknownEl.checked = settings.includeUnknown !== false;
    includeUnknownEl.style.cssText = "cursor:pointer; margin:0;";

    const includeUnknownLabel = document.createElement("label");
    includeUnknownLabel.htmlFor = "amz-toolkit-inline-include-unknown";
    includeUnknownLabel.style.cssText = "font-size:13px; color:#0F1111; white-space:nowrap; cursor:pointer; display:flex; align-items:center; gap:5px;";
    includeUnknownLabel.appendChild(includeUnknownEl);
    includeUnknownLabel.appendChild(document.createTextNode("Include unknown"));
    row1.appendChild(includeUnknownLabel);

    const includeSponsoredEl = document.createElement("input");
    includeSponsoredEl.id = "amz-toolkit-inline-include-sponsored";
    includeSponsoredEl.type = "checkbox";
    includeSponsoredEl.checked = settings.includeSponsored === true;
    includeSponsoredEl.style.cssText = "cursor:pointer; margin:0;";

    const includeSponsoredLabel = document.createElement("label");
    includeSponsoredLabel.htmlFor = "amz-toolkit-inline-include-sponsored";
    includeSponsoredLabel.style.cssText = "font-size:13px; color:#0F1111; white-space:nowrap; cursor:pointer; display:flex; align-items:center; gap:5px;";
    includeSponsoredLabel.appendChild(includeSponsoredEl);
    includeSponsoredLabel.appendChild(document.createTextNode("Include sponsored"));
    row1.appendChild(includeSponsoredLabel);

    row1.appendChild(makeBtn("Apply", async () => {
      const date = maxDateEl.value;
      const minPrice = minPriceEl.value.trim();
      const maxPrice = maxPriceEl.value.trim();
      const next = {
        ...settings,
        mode: date ? "byDate" : "off",
        maxDate: date,
        includeUnknown: includeUnknownEl.checked,
        includeSponsored: includeSponsoredEl.checked,
        minPrice,
        maxPrice
      };

      const min = Number.parseFloat(minPrice);
      const max = Number.parseFloat(maxPrice);
      if (Number.isFinite(min) && Number.isFinite(max) && min > max) {
        const corrected = String(min);
        maxPriceEl.value = corrected;
        next.maxPrice = corrected;
      }

      settings = next;
      ensureReapplyGuard();
      applyFilters();
      await chrome.storage.sync.set({ [STORAGE_KEY]: next });
    }));

    row1.appendChild(makeBtn("Reset", async () => {
      maxDateEl.value = "";
      includeUnknownEl.checked = true;
      includeSponsoredEl.checked = true;
      minPriceEl.value = "";
      maxPriceEl.value = "";
      const next = {
        ...settings,
        mode: "off",
        maxDate: "",
        includeUnknown: true,
        includeSponsored: true,
        minPrice: "",
        maxPrice: ""
      };
      settings = next;
      ensureReapplyGuard();
      applyFilters();
      await chrome.storage.sync.set({ [STORAGE_KEY]: next });
    }));

    const badge = getOrCreateDebugBadge();
    row1.appendChild(badge);

    const downloadHtmlBtn = makeBtn("Download HTML", downloadCurrentPageHtml);
    downloadHtmlBtn.style.marginRight = "auto";
    row2.appendChild(downloadHtmlBtn);

    row2.appendChild(makeLabel("Sort:"));
    row2.appendChild(makeBtn("Delivery Date", () => doSort("deliveryDate")));
    row2.appendChild(makeBtn("Price ↑", () => doSort("priceAsc")));
    row2.appendChild(makeBtn("Price ↓", () => doSort("priceDesc")));
    row2.appendChild(makeBtn("Review Count", () => doSort("reviewCount")));
    row2.appendChild(makeBtn("Reset", () => doSort("reset")));

    const GRID_STYLE_ID = "amz-toolkit-grid-style";
    let gridActive = false;
    // Store original inline styles so we can restore on toggle-off
    const gridOriginalStyles = new WeakMap();

    row2.appendChild(makeBtn("⊞ Grid View", () => {
      gridActive = !gridActive;

      const container = document.querySelector(RESULTS_CONTAINER_SELECTOR);
      if (!container) return;

      if (!gridActive) {
        // Restore container
        const saved = gridOriginalStyles.get(container);
        container.setAttribute("style", saved != null ? saved : "");
        container.classList.remove("s-grid-view", "amz-toolkit-grid-active");
        // Restore each direct child
        Array.from(container.children).forEach((child) => {
          const s = gridOriginalStyles.get(child);
          child.setAttribute("style", s != null ? s : "");
        });
        const injected = document.getElementById(GRID_STYLE_ID);
        if (injected) injected.remove();
        return;
      }

      // Save and override container
      gridOriginalStyles.set(container, container.getAttribute("style") || "");
      container.style.cssText += ";display:flex!important;flex-wrap:wrap!important;align-items:flex-start!important;";
      container.classList.add("s-grid-view", "amz-toolkit-grid-active");
      container.classList.remove("s-list-view");

      // Inject a style tag to convert list-mode internals into card-mode internals
      if (!document.getElementById(GRID_STYLE_ID)) {
        const style = document.createElement("style");
        style.id = GRID_STYLE_ID;
        style.textContent = `
          .amz-toolkit-grid-active [data-component-type="s-messaging-widget-results-header"],
          .amz-toolkit-grid-active [data-component-type="s-messaging-widget-results-header-accessibility-header"] {
            display: none !important;
          }

          .amz-toolkit-grid-active [data-component-type="s-search-result"] .puisg-row,
          .amz-toolkit-grid-active [data-component-type="s-search-result"] .a-section.a-spacing-base {
            display: flex !important;
            flex-direction: column !important;
            align-items: stretch !important;
          }

          .amz-toolkit-grid-active [data-component-type="s-search-result"] .puis-list-col-left,
          .amz-toolkit-grid-active [data-component-type="s-search-result"] .puis-list-col-right,
          .amz-toolkit-grid-active [data-component-type="s-search-result"] .s-list-item-margin-right-adjustment {
            display: block !important;
            width: 100% !important;
            max-width: 100% !important;
            flex: 0 0 auto !important;
          }
        `;
        document.head.appendChild(style);
      }

      // Override each direct child's flex width inline (beats all CSS specificity)
      Array.from(container.children).forEach((child) => {
        gridOriginalStyles.set(child, child.getAttribute("style") || "");
        if (child.matches('div[data-asin]:not([data-asin=""])')) {
          child.style.cssText += ";flex:0 0 calc(25% - 10px)!important;width:calc(25% - 10px)!important;max-width:calc(25% - 10px)!important;margin:5px!important;box-sizing:border-box!important;";
        } else {
          child.style.cssText += ";flex:0 0 100%!important;width:100%!important;max-width:100%!important;";
        }
      });
    }));

    anchor.insertAdjacentElement("beforebegin", root);
  }

  // ============================================
  // SORT
  // ============================================

  let originalCardOrder = null;
  let currentSort = "none";

  function getReviewCount(card) {
    // Try aria-label: "4.5 out of 5 stars 1,234 ratings"
    const link = card.querySelector("a[aria-label*='ratings']");
    if (link) {
      const m = link.getAttribute("aria-label").match(/([\d.,]+K?)\s*ratings/i);
      if (m) {
        let text = m[1].replace(/,/g, "");
        if (/k$/i.test(text)) return Math.round(parseFloat(text) * 1000);
        return parseInt(text, 10) || 0;
      }
    }
    // Fallback to visible span (e.g. "(1,234)" or "1,234")
    const span = card.querySelector(".a-size-small.s-underline-text");
    if (span) {
      let text = span.textContent.trim().replace(/[(),]/g, "").replace(/,/g, "");
      if (/k$/i.test(text)) return Math.round(parseFloat(text) * 1000);
      return parseInt(text, 10) || 0;
    }
    return 0;
  }

  function getDeliverySortKey(card) {
    const win = extractDeliveryWindowFromCard(card);
    return win ? win.start.getTime() : Infinity;
  }

  function getPriceSortKey(card) {
    const price = extractPriceFromCard(card);
    return price != null ? price : Infinity;
  }

  function applySortToDOM(sortedCards) {
    const container = document.querySelector(".s-main-slot.s-result-list.s-search-results");
    if (!container) return;

    // Disconnect observer so our DOM moves don't trigger cascading re-renders
    if (observer) observer.disconnect();

    // Insert sorted cards starting at the position of the first card.
    // Using appendChild would leave non-card nodes (headers, "More results", pagination)
    // stranded at the top of the container.
    const directCards = sortedCards.filter((c) => c instanceof HTMLElement && c.parentNode === container);
    if (directCards.length > 0) {
      // Place a temporary marker just before the first card currently in the container
      const firstInContainer = container.querySelector('div.s-result-item[data-asin]:not([data-asin=""])');
      const marker = document.createComment("amz-sort-marker");
      if (firstInContainer) {
        container.insertBefore(marker, firstInContainer);
      } else {
        container.appendChild(marker);
      }

      // Re-insert each card in sorted order immediately after the growing tail
      let ref = marker;
      for (const card of directCards) {
        ref.after(card);
        ref = card;
      }
      marker.remove();
    }

    applyFilters();
    observeDynamicContent(); // reconnect
  }

  function doSort(type) {
    const container = document.querySelector(".s-main-slot.s-result-list.s-search-results");
    if (!container) return;

    // Snapshot original DOM order once, before any sort
    if (!originalCardOrder) {
      originalCardOrder = Array.from(
        container.querySelectorAll('div.s-result-item[data-asin][class*="s-asin"]')
      );
    }

    let sorted;
    if (type === "reviewCount") {
      sorted = [...originalCardOrder].sort((a, b) => getReviewCount(b) - getReviewCount(a));
      currentSort = "reviewCount";
    } else if (type === "deliveryDate") {
      sorted = [...originalCardOrder].sort((a, b) => getDeliverySortKey(a) - getDeliverySortKey(b));
      currentSort = "deliveryDate";
    } else if (type === "priceAsc") {
      sorted = [...originalCardOrder].sort((a, b) => getPriceSortKey(a) - getPriceSortKey(b));
      currentSort = "priceAsc";
    } else if (type === "priceDesc") {
      sorted = [...originalCardOrder].sort((a, b) => getPriceSortKey(b) - getPriceSortKey(a));
      currentSort = "priceDesc";
    } else {
      // reset — use original order, then clear snapshot so next sort re-snapshots fresh
      sorted = [...originalCardOrder];
      originalCardOrder = null;
      currentSort = "none";
    }

    applySortToDOM(sorted);
  }

  async function init() {
    injectStyle();
    await loadSettings();
    loadedPageCount = 1;
    nextPageUrl = discoverNextPageUrl(document);
    indexCurrentPageAsins();
    setupStorageListener();
    observeDynamicContent();
    ensureReapplyGuard();
    applyFilters();
    setTimeout(injectToolbar, 1500);

    const targetPages = Math.max(1, Math.min(50, Number(settings.pages) || 1));
    if (targetPages > 1) {
      setTimeout(() => {
        loadPagesUpTo(targetPages);
      }, 1600);
    }
  }

  // ============================================
  // RUNTIME MESSAGE LISTENER (popup communication)
  // ============================================

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "GET_STATE") {
      sendResponse({ currentSort });
      return false;
    }

    if (message.type === "EXPORT_PAGE") {
      const config = message.config || {};

      // --- per-card delivery debug ---
      const cardDebug = [];
      getSearchResultCards().forEach((card) => {
        const asin = card.dataset.asin || "?";
        const hidden = card.hasAttribute(HIDDEN_ATTR);
        const candidates = getCandidateDeliveryTexts(card);
        const win = extractDeliveryWindowFromCard(card);
        cardDebug.push({
          asin,
          hidden,
          candidateTexts: candidates,
          parsedStart: win ? win.start.toISOString() : null,
          parsedEnd: win ? win.end.toISOString() : null,
          source: win ? win.source : null,
        });
      });

      // --- network resource timing ---
      let networkEntries = [];
      try {
        networkEntries = performance.getEntriesByType("resource").map((e) => ({
          name: e.name,
          type: e.initiatorType,
          duration: Math.round(e.duration),
          size: e.transferSize || 0,
          start: Math.round(e.startTime),
        }));
      } catch (_) {}

      // --- layout toggle candidates (for grid-view debugging) ---
      const layoutToggleCandidates = Array.from(
        document.querySelectorAll('[data-action="s-layout-toggle"] *, [data-layout-id], span[role="button"]')
      ).filter((el) => !el.closest('[data-asin]')).map((el) => ({
        tag: el.tagName,
        id: el.id || null,
        className: el.className || null,
        ariaLabel: el.getAttribute("aria-label") || null,
        dataAction: el.getAttribute("data-action") || null,
        dataLayoutId: el.getAttribute("data-layout-id") || null,
        text: (el.textContent || "").trim().slice(0, 80),
      }));

      const debugBundle = {
        exportedAt: new Date().toISOString(),
        url: location.href,
        config,
        cardDeliveryDebug: cardDebug,
        layoutToggleCandidates,
        networkRequests: networkEntries,
        consoleLogs: [...logBuffer],
      };

      const ts = new Date().toISOString().replace(/[:.]/g, "-");

      const htmlBlob = new Blob(
        ["<!DOCTYPE html>\n", document.documentElement.outerHTML],
        { type: "text/html" }
      );
      const debugBlob = new Blob(
        [JSON.stringify(debugBundle, null, 2)],
        { type: "application/json" }
      );

      const htmlUrl  = URL.createObjectURL(htmlBlob);
      const debugUrl = URL.createObjectURL(debugBlob);

      const dlHtml = Object.assign(document.createElement("a"), {
        href: htmlUrl,
        download: `amazon-search-page-${ts}.html`,
      });
      const dlDebug = Object.assign(document.createElement("a"), {
        href: debugUrl,
        download: `amazon-search-debug-${ts}.json`,
      });

      document.body.appendChild(dlHtml);
      dlHtml.click();
      dlHtml.remove();

      setTimeout(() => {
        document.body.appendChild(dlDebug);
        dlDebug.click();
        dlDebug.remove();
        URL.revokeObjectURL(htmlUrl);
        URL.revokeObjectURL(debugUrl);
      }, 300);

      sendResponse({ ok: true });
      return false;
    }
  });

  init().catch((error) => {
    console.error("[Amazon Search Toolkit] Failed to initialize:", error);
  });
})();
