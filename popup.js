(async () => {
  const STORAGE_KEY = "amazonSearchToolkitSettings";
  const LEGACY_STORAGE_KEY = "amazonDeliveryFilterSettings";

  async function loadSavedSettings() {
    const data = await chrome.storage.sync.get([STORAGE_KEY, LEGACY_STORAGE_KEY]);
    const current = data[STORAGE_KEY];
    const legacy = data[LEGACY_STORAGE_KEY];

    if (current) return current;
    if (legacy) {
      await chrome.storage.sync.set({ [STORAGE_KEY]: legacy });
      return legacy;
    }

    return {};
  }

  // --- populate config panel ---
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  async function loadConfig() {
    const s = await loadSavedSettings();

    document.getElementById("cfg-deliver-by").textContent =
      s.maxDate || "none";
    document.getElementById("cfg-include-unknown").textContent =
      s.includeUnknown === false ? "no" : "yes";
    document.getElementById("cfg-mode").textContent = s.mode || "off";
    document.getElementById("cfg-pages").textContent = s.pages ?? 1;

    // Ask content script for the live sort state
    let sortLabel = "none";
    try {
      const response = await chrome.tabs.sendMessage(tab.id, {
        type: "GET_STATE",
      });
      if (response && response.currentSort) {
        sortLabel = response.currentSort;
      }
    } catch (_) {
      // content script may not be active on this tab
    }
    document.getElementById("cfg-sort").textContent = sortLabel;
  }

  await loadConfig();

  // --- export button ---
  document.getElementById("btn-export").addEventListener("click", async () => {
    const status = document.getElementById("status");
    status.textContent = "Exporting…";

    try {
      const s = await loadSavedSettings();

      let currentSort = "none";
      try {
        const response = await chrome.tabs.sendMessage(tab.id, {
          type: "GET_STATE",
        });
        if (response && response.currentSort) {
          currentSort = response.currentSort;
        }
      } catch (_) {}

      const configSnapshot = {
        pages: s.pages ?? 1,
        deliverBy: s.maxDate || null,
        includeUnknown: s.includeUnknown !== false,
        mode: s.mode || "off",
        sortOrder: currentSort,
      };

      // Ask the content script to trigger the download
      await chrome.tabs.sendMessage(tab.id, {
        type: "EXPORT_PAGE",
        config: configSnapshot,
      });

      status.textContent = "Export triggered — check Downloads for amazon-search-page-*.html + amazon-search-debug-*.json.";
    } catch (err) {
      status.textContent = "Error: " + err.message;
    }
  });
})();
