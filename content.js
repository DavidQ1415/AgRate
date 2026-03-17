(() => {
  "use strict";

  // ===== Config =====
  const CONFIG = {
    // TAMU College Scheduler: instructor appears in a list item like:
    // <li><strong><span>Instructor</span>:</strong><span>Nguyen, Tung T.</span></li>
    instructorRowSelector: "ul.css-fgox3d-fieldsCss li",
    // Texas A&M University (College Station) RMP school ID (School-1003)
    schoolId: "U2Nob29sLTEwMDM=",
    graphqlEndpoint: "https://www.ratemyprofessors.com/graphql",
    cacheTtlMs: 24 * 60 * 60 * 1000,
    emptyCacheTtlMs: 60 * 60 * 1000,
    debounceMs: 300,
    maxConcurrent: 4,
    debug: false
  };

  const CACHE_VERSION = 3;

  const GRAPHQL_QUERY = `
    query ($text: String!, $schoolID: ID!) {
      newSearch {
        teachers(query: { text: $text, schoolID: $schoolID }) {
          edges {
            node {
              firstName
              lastName
              avgRating
              avgDifficulty
              numRatings
              wouldTakeAgainPercent
              department
            }
          }
        }
      }
    }
  `;

  const inFlight = new Map();
  const queue = [];
  let activeCount = 0;
  let debounceTimer = null;

  const normalizeName = (name) => {
    if (!name || typeof name !== "string") return "";
    let n = name;
    if (n.includes(",")) {
      const [last, first] = n.split(",").map((s) => s.trim());
      if (first) n = `${first} ${last}`.trim();
    }
    return n
      .replace(/\b(Dr\.?|Prof\.?|Professor|Mr\.?|Ms\.?|Mrs\.?)\b/gi, "")
      .replace(/\./g, "")
      .replace(/,/g, " ")
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\s'-]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  };

  const parseName = (name) => {
    const full = normalizeName(name);
    if (!full) return { first: "", last: "", full: "" };
    const parts = full.split(" ").filter(Boolean);
    const first = parts[0] || "";
    const last = parts.length > 1 ? parts[parts.length - 1] : "";
    return { first, last, full };
  };

  const buildQueryName = (name) => {
    const { first, last } = parseName(name);
    if (!first && !last) return normalizeName(name);
    return `${first} ${last}`.trim();
  };

  const toTitleCase = (s) =>
    s.replace(/\b([a-z])/g, (m) => m.toUpperCase());

  async function rmpFetch(queryText) {
    const response = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          type: "RMP_FETCH",
          endpoint: CONFIG.graphqlEndpoint,
          payload: {
            query: GRAPHQL_QUERY,
            variables: { text: queryText, schoolID: CONFIG.schoolId }
          }
        },
        (res) => {
          const err = chrome.runtime.lastError;
          if (err) {
            reject(new Error(err.message));
            return;
          }
          resolve(res);
        }
      );
    });

    if (!response || !response.ok) {
      throw new Error(response?.error || "RMP fetch failed");
    }

    const json = response.data;
    const edges =
      json?.data?.newSearch?.teachers?.edges ||
      [];
    return edges.map((e) => e.node).filter(Boolean);
  }

  function getInstructorNameElements() {
    const items = Array.from(
      document.querySelectorAll(CONFIG.instructorRowSelector)
    );
    const results = [];
    for (const li of items) {
      const label = li.querySelector("strong span");
      if (!label) continue;
      const labelText = (label.textContent || "").trim().toLowerCase();
      if (labelText !== "instructor") continue;

      const strong = li.querySelector("strong");
      const nameSpan = strong ? strong.nextElementSibling : null;
      if (!nameSpan) continue;
      if (nameSpan.classList.contains("rmp-rating")) continue;
      results.push(nameSpan);
    }
    return results;
  }

  function getProfessorNames() {
    const elements = getInstructorNameElements();
    const names = new Map();
    for (const el of elements) {
      const raw = el.textContent || "";
      const clean = normalizeName(raw);
      if (!clean) continue;
      if (!names.has(clean)) names.set(clean, []);
      names.get(clean).push(el);
    }
    return names;
  }

  function cacheKey(name) {
    return `rmp:v${CACHE_VERSION}:${name.toLowerCase()}`;
  }

  async function getCached(name) {
    const key = cacheKey(name);
    const data = await chrome.storage.local.get(key);
    const entry = data[key];
    if (!entry) return null;
    const age = Date.now() - entry.timestamp;
    if (Array.isArray(entry.value) && entry.value.length === 0) {
      if (!entry.timestamp || age > CONFIG.emptyCacheTtlMs) {
        await chrome.storage.local.remove(key);
        return null;
      }
      return entry.value;
    }
    if (!entry.timestamp || age > CONFIG.cacheTtlMs) {
      await chrome.storage.local.remove(key);
      return null;
    }
    return entry.value || null;
  }

  async function setCached(name, value) {
    const key = cacheKey(name);
    await chrome.storage.local.set({
      [key]: { value, timestamp: Date.now() }
    });
  }

  async function fetchProfessorData(name) {
    const cached = await getCached(name);
    if (cached) return cached;

    if (inFlight.has(name)) return inFlight.get(name);

    const promise = enqueueRequest(async () => {
      const queryText = buildQueryName(name);
      let nodes = await rmpFetch(queryText);
      if (nodes.length === 0) {
        nodes = await rmpFetch(toTitleCase(queryText));
      }
      if (nodes.length === 0) {
        const { last } = parseName(name);
        if (last) {
          nodes = await rmpFetch(last);
        }
      }
      await setCached(name, nodes);
      return nodes;
    });

    inFlight.set(name, promise);
    try {
      const result = await promise;
      return result;
    } finally {
      inFlight.delete(name);
    }
  }

  function enqueueRequest(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      processQueue();
    });
  }

  function processQueue() {
    if (activeCount >= CONFIG.maxConcurrent) return;
    const item = queue.shift();
    if (!item) return;
    activeCount += 1;
    item.fn()
      .then((result) => item.resolve(result))
      .catch((err) => item.reject(err))
      .finally(() => {
        activeCount -= 1;
        processQueue();
      });
  }

  const matchProfessor = (results, targetName) => {
    const edges = results?.edges || [];
    if (!Array.isArray(edges) || edges.length === 0) return null;

    const target = parseName(targetName);

    const candidates = edges
      .map((e) => e?.node)
      .filter(Boolean)
      .map((node) => ({
        node,
        parsed: parseName(
          `${node.firstName || ""} ${node.lastName || ""}`.trim()
        )
      }));

    if (candidates.length === 0) return null;

    // Step 1: Exact full match
    const fullMatches = candidates.filter(
      (c) => c.parsed.full && c.parsed.full === target.full
    );
    if (fullMatches.length > 0) {
      return fullMatches.reduce((best, cur) => {
        const bestRatings = Number(best.node?.numRatings || 0);
        const curRatings = Number(cur.node?.numRatings || 0);
        return curRatings > bestRatings ? cur : best;
      }).node;
    }

    // Step 2: Exact first + last match
    const firstLastMatches = candidates.filter(
      (c) =>
        c.parsed.first &&
        c.parsed.last &&
        c.parsed.first === target.first &&
        c.parsed.last === target.last
    );
    if (firstLastMatches.length > 0) {
      return firstLastMatches.reduce((best, cur) => {
        const bestRatings = Number(best.node?.numRatings || 0);
        const curRatings = Number(cur.node?.numRatings || 0);
        return curRatings > bestRatings ? cur : best;
      }).node;
    }

    // Step 3: Variation match (same last, first startsWith)
    const variations = candidates.filter((c) => {
      if (!c.parsed.last || !target.last) return false;
      if (c.parsed.last !== target.last) return false;
      const f1 = c.parsed.first || "";
      const f2 = target.first || "";
      return f1.startsWith(f2) || f2.startsWith(f1);
    });

    if (variations.length > 0) {
      return variations.reduce((best, cur) => {
        const bestRatings = Number(best.node?.numRatings || 0);
        const curRatings = Number(cur.node?.numRatings || 0);
        return curRatings > bestRatings ? cur : best;
      }).node;
    }

    // Step 4: Final fallback — highest numRatings overall
    return candidates.reduce((best, cur) => {
      const bestRatings = Number(best.node?.numRatings || 0);
      const curRatings = Number(cur.node?.numRatings || 0);
      return curRatings > bestRatings ? cur : best;
    }).node;
  };

  function formatRating(prof) {
    if (!prof || prof.avgRating == null || prof.avgDifficulty == null) {
      return { text: "⭐ N/A", color: "#999" };
    }
    const rating = Number(prof.avgRating);
    const difficulty = Number(prof.avgDifficulty);
    const numRatings = Number(prof.numRatings || 0);
    let color = "#d9534f";
    if (rating >= 4) color = "#2e8b57";
    else if (rating >= 3) color = "#f0ad4e";

    const text = `⭐ ${rating.toFixed(1)} | Diff: ${difficulty.toFixed(
      1
    )} | ${numRatings} ratings`;
    return { text, color };
  }

  function injectRating(el, data) {
    if (!el) return;
    if (el.dataset.rmpInjected === "true") return;
    if (el.querySelector(".rmp-rating")) {
      el.dataset.rmpInjected = "true";
      return;
    }

    const span = document.createElement("span");
    span.className = "rmp-rating";
    span.style.marginLeft = "6px";
    span.style.fontSize = "0.9em";
    span.style.fontWeight = "600";

    const { text, color } = formatRating(data);
    span.textContent = text;
    span.style.color = color;

    el.dataset.rmpInjected = "true";
    el.appendChild(span);
  }

  async function handleProfessor(name, elements) {
    try {
      const candidates = await fetchProfessorData(name);
      if (CONFIG.debug) {
        console.debug("RMP candidates:", name, candidates);
      }
      const match = matchProfessor(
        { edges: candidates.map((node) => ({ node })) },
        name
      );
      if (CONFIG.debug) {
        console.debug("RMP match:", name, match);
      }
      for (const el of elements) {
        injectRating(el, match);
      }
    } catch (err) {
      for (const el of elements) {
        injectRating(el, null);
      }
      // Swallow errors to avoid breaking page
      console.warn("RMP fetch failed:", err);
    }
  }

  function scanAndInject() {
    const map = getProfessorNames();
    for (const [name, elements] of map.entries()) {
      handleProfessor(name, elements);
    }
  }

  function debounceScan() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(scanAndInject, CONFIG.debounceMs);
  }

  function observeDom() {
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.addedNodes && m.addedNodes.length > 0) {
          debounceScan();
          break;
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function init() {
    if (!document.body) {
      window.addEventListener("DOMContentLoaded", () => {
        scanAndInject();
        observeDom();
      });
      return;
    }
    scanAndInject();
    observeDom();
  }

  init();
})();
