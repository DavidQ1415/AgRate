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
    debug: false,
    anexEndpoint: "https://anex.us/grades/getData/",
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
              legacyId
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
  const gpaInFlight = new Map();
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

  const toTitleCase = (s) => s.replace(/\b([a-z])/g, (m) => m.toUpperCase());

  async function rmpFetch(queryText) {
    const response = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          type: "RMP_FETCH",
          endpoint: CONFIG.graphqlEndpoint,
          payload: {
            query: GRAPHQL_QUERY,
            variables: { text: queryText, schoolID: CONFIG.schoolId },
          },
        },
        (res) => {
          const err = chrome.runtime.lastError;
          if (err) {
            reject(new Error(err.message));
            return;
          }
          resolve(res);
        },
      );
    });

    if (!response || !response.ok) {
      throw new Error(response?.error || "RMP fetch failed");
    }

    const json = response.data;
    const edges = json?.data?.newSearch?.teachers?.edges || [];
    return edges.map((e) => e.node).filter(Boolean);
  }

  async function anexFetch(dept, number) {
    const response = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          type: "ANEX_FETCH",
          endpoint: CONFIG.anexEndpoint,
          payload: { dept, number },
        },
        (res) => {
          const err = chrome.runtime.lastError;
          if (err) {
            reject(new Error(err.message));
            return;
          }
          resolve(res);
        },
      );
    });

    if (!response || !response.ok) {
      throw new Error(response?.error || "ANEX fetch failed");
    }

    const data = response.data;
    return data?.classes || [];
  }

  function getInstructorNameElements() {
    const items = Array.from(
      document.querySelectorAll(CONFIG.instructorRowSelector),
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
      names.get(clean).push({
        el,
        course: findCourseForElement(el),
      });
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
      [key]: { value, timestamp: Date.now() },
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
    item
      .fn()
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
          `${node.firstName || ""} ${node.lastName || ""}`.trim(),
        ),
      }));

    if (candidates.length === 0) return null;

    // Step 1: Exact full match
    const fullMatches = candidates.filter(
      (c) => c.parsed.full && c.parsed.full === target.full,
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
        c.parsed.last === target.last,
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
      1,
    )} | ${numRatings} ratings`;
    return { text, color };
  }

  function gpaCacheKey(name, dept, number) {
    const n = normalizeName(name);
    return `gpa:v${CACHE_VERSION}:${dept}:${number}:${n}`;
  }

  async function getCachedGpa(name, dept, number) {
    const key = gpaCacheKey(name, dept, number);
    const data = await chrome.storage.local.get(key);
    const entry = data[key];
    if (!entry) return null;
    const age = Date.now() - entry.timestamp;
    if (!entry.timestamp || age > CONFIG.cacheTtlMs) {
      await chrome.storage.local.remove(key);
      return null;
    }
    return entry.value ?? null;
  }

  async function setCachedGpa(name, dept, number, value) {
    const key = gpaCacheKey(name, dept, number);
    await chrome.storage.local.set({
      [key]: { value, timestamp: Date.now() },
    });
  }

  function normalizeInstructorName(name) {
    return normalizeName(name);
  }

  function parseAnexInstructorName(name) {
    const cleaned = normalizeInstructorName(name);
    if (!cleaned) return { first: "", last: "", firstInitial: "" };
    const parts = cleaned.split(" ").filter(Boolean);
    if (parts.length === 2 && parts[1].length === 1) {
      return {
        first: "",
        last: parts[0],
        firstInitial: parts[1],
      };
    }
    if (parts.length >= 2) {
      const first = parts[0];
      const last = parts[parts.length - 1];
      return {
        first,
        last,
        firstInitial: first ? first[0] : "",
      };
    }
    return { first: "", last: parts[0] || "", firstInitial: "" };
  }

  function classInstructorName(cls) {
    return (
      cls?.instructor ||
      cls?.professor ||
      cls?.prof ||
      cls?.instructor_name ||
      cls?.instructorName ||
      cls?.teacher ||
      cls?.name ||
      ""
    );
  }

  function classGpaValue(cls) {
    const raw =
      cls?.gpa ??
      cls?.avgGpa ??
      cls?.averageGpa ??
      cls?.gpaAverage ??
      cls?.average_gpa ??
      cls?.avg_gpa;
    const num = Number(raw);
    return Number.isFinite(num) ? num : null;
  }

  function classSizeValue(cls) {
    const direct =
      cls?.students ??
      cls?.numStudents ??
      cls?.enrollment ??
      cls?.enrolled ??
      cls?.totalStudents ??
      cls?.total ??
      cls?.size ??
      cls?.count;
    const directNum = Number(direct);
    if (Number.isFinite(directNum) && directNum > 0) return directNum;

    const gradeKeyRegex = /^(a|b|c|d|f|q|i|s|u|w)(\+|_plus|_minus|-)?$/i;
    const gradeKeyRegex2 = /^(a|b|c|d|f)(plus|minus)$/i;
    const gradeKeyRegex3 = /^(grade|count)?[a-f]$/i;
    let sum = 0;
    let found = false;
    for (const [key, value] of Object.entries(cls || {})) {
      if (
        gradeKeyRegex.test(key) ||
        gradeKeyRegex2.test(key) ||
        gradeKeyRegex3.test(key)
      ) {
        const num = Number(value);
        if (Number.isFinite(num)) {
          sum += num;
          found = true;
        }
      }
    }
    if (found && sum > 0) return sum;
    return null;
  }

  function classTermValue(cls) {
    const year = cls?.year || "";
    const semester = cls?.semester || "";
    if (year && semester) return `${year} ${semester}`;
    return (
      cls?.term ||
      cls?.semester ||
      cls?.termName ||
      cls?.term_code ||
      cls?.termCode ||
      cls?.year ||
      ""
    );
  }

  function termToSortValue(term) {
    if (term == null) return -Infinity;
    if (typeof term === "number" && Number.isFinite(term)) return term;
    const str = String(term).trim();
    if (!str) return -Infinity;
    const yearMatch = str.match(/(19|20)\d{2}/);
    if (!yearMatch) return -Infinity;
    const year = Number(yearMatch[0]);
    const lower = str.toLowerCase();
    let season = 0;
    if (lower.includes("spring")) season = 1;
    else if (lower.includes("summer")) season = 2;
    else if (lower.includes("fall")) season = 3;
    else if (lower.includes("winter")) season = 0;
    else {
      const after = str.slice(str.indexOf(yearMatch[0]) + 4);
      const digits = after.match(/\d+/);
      if (digits) {
        season = Number(digits[0]) || 0;
      } else {
        const letter = after.match(/[A-Z]/i);
        if (letter) {
          const c = letter[0].toUpperCase().charCodeAt(0) - 64;
          season = c > 0 ? c : 0;
        }
      }
    }
    return year * 10 + season;
  }

  function matchesInstructor(targetName, instructorName) {
    const target = parseName(targetName);
    const cand = parseAnexInstructorName(instructorName);
    if (!target.full) return false;
    if (cand.last && target.last && cand.last === target.last) {
      const targetInitial = target.first ? target.first[0] : "";
      if (cand.firstInitial && targetInitial) {
        return cand.firstInitial === targetInitial;
      }
      const f2 = target.first || "";
      return f2.length > 0;
    }
    return false;
  }

  function extractMostRecentGpa(classes, profName) {
    if (!Array.isArray(classes) || classes.length === 0) return null;
    const target = normalizeInstructorName(profName);
    const matches = classes
      .map((cls) => {
        const instructor = classInstructorName(cls);
        const gpa = classGpaValue(cls);
        const size = classSizeValue(cls);
        const term = classTermValue(cls);
        const sortValue = termToSortValue(term);
        return {
          cls,
          instructor,
          gpa,
          size,
          term,
          sortValue,
        };
      })
      .filter((item) => {
        if (item.gpa == null) return false;
        const name = normalizeInstructorName(item.instructor);
        if (!name) return false;
        return name === target || matchesInstructor(profName, item.instructor);
      });

    if (matches.length === 0) return null;

    const byTerm = new Map();
    for (const item of matches) {
      const key = item.term || "";
      const entry = byTerm.get(key) || {
        term: key,
        sortValue: item.sortValue,
        totalPoints: 0,
        totalStudents: 0,
      };
      const size = Number.isFinite(item.size) && item.size > 0 ? item.size : 1;
      entry.totalPoints += Number(item.gpa) * size;
      entry.totalStudents += size;
      entry.sortValue = Math.max(entry.sortValue, item.sortValue);
      byTerm.set(key, entry);
    }

    const terms = Array.from(byTerm.values());
    terms.sort((a, b) => b.sortValue - a.sortValue);
    const best = terms[0];
    if (!best || best.totalStudents <= 0) return null;
    return {
      gpa: best.totalPoints / best.totalStudents,
      term: best.term || "",
    };
  }

  async function fetchGpaForProfessorCourse(name, course) {
    if (!course?.dept || !course?.number) return null;
    const cached = await getCachedGpa(name, course.dept, course.number);
    if (cached) return cached;

    const key = gpaCacheKey(name, course.dept, course.number);
    if (gpaInFlight.has(key)) return gpaInFlight.get(key);

    const promise = enqueueRequest(async () => {
      const classes = await anexFetch(course.dept, course.number);
      const gpaInfo = extractMostRecentGpa(classes, name);
      await setCachedGpa(name, course.dept, course.number, gpaInfo);
      return gpaInfo;
    });

    gpaInFlight.set(key, promise);
    try {
      return await promise;
    } finally {
      gpaInFlight.delete(key);
    }
  }

  function buildProfileUrl(prof) {
    const legacyId = prof?.legacyId;
    if (!legacyId) return "";
    return `https://www.ratemyprofessors.com/professor/${legacyId}`;
  }

  function formatGpa(gpaInfo) {
    if (!gpaInfo || gpaInfo.gpa == null) return "";
    const gpa = Number(gpaInfo.gpa);
    if (!Number.isFinite(gpa)) return "";
    const term = gpaInfo.term ? ` (${gpaInfo.term})` : "";
    return `GPA: ${gpa.toFixed(2)}${term}`;
  }

  function buildAnexUrl(course) {
    if (!course?.dept || !course?.number) return "";
    return `https://anex.us/grades/?dept=${encodeURIComponent(
      course.dept,
    )}&number=${encodeURIComponent(course.number)}`;
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

    const profileUrl = buildProfileUrl(data);
    if (profileUrl) {
      const link = document.createElement("a");
      link.className = "rmp-link";
      link.textContent = "RMP";
      link.href = profileUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.style.marginLeft = "6px";
      link.style.fontSize = "0.9em";
      link.style.fontWeight = "600";
      link.style.textDecoration = "underline";
      link.style.color = "#1a73e8";
      span.appendChild(link);
    }

    el.dataset.rmpInjected = "true";
    el.appendChild(span);
  }

  function injectGpa(el, gpaInfo, course) {
    if (!el) return;
    let span = el.querySelector(".rmp-gpa");
    if (!span) {
      span = document.createElement("span");
      span.className = "rmp-gpa";
      span.style.marginLeft = "6px";
      span.style.fontSize = "0.9em";
      span.style.fontWeight = "600";
      span.style.color = "#444";
      el.appendChild(span);
    }
    const text = formatGpa(gpaInfo);
    if (!text) {
      span.textContent = "";
      return;
    }
    span.textContent = text;

    const url = buildAnexUrl(course);
    if (!url) return;
    let link = span.querySelector(".rmp-gpa-link");
    if (!link) {
      link = document.createElement("a");
      link.className = "rmp-gpa-link";
      link.textContent = "ANEX";
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.style.marginLeft = "6px";
      link.style.fontSize = "0.9em";
      link.style.fontWeight = "600";
      link.style.textDecoration = "underline";
      link.style.color = "#1a73e8";
      span.appendChild(link);
    }
    link.href = url;
  }

  async function handleProfessor(name, entries) {
    try {
      const candidates = await fetchProfessorData(name);
      if (CONFIG.debug) {
        console.debug("RMP candidates:", name, candidates);
      }
      const match = matchProfessor(
        { edges: candidates.map((node) => ({ node })) },
        name,
      );
      if (CONFIG.debug) {
        console.debug("RMP match:", name, match);
      }
      for (const entry of entries) {
        injectRating(entry.el, match);
        fetchGpaForProfessorCourse(name, entry.course)
          .then((gpaInfo) => injectGpa(entry.el, gpaInfo, entry.course))
          .catch(() => injectGpa(entry.el, null, entry.course));
      }
    } catch (err) {
      for (const entry of entries) {
        injectRating(entry.el, null);
        injectGpa(entry.el, null, entry.course);
      }
      // Swallow errors to avoid breaking page
      console.warn("RMP fetch failed:", err);
    }
  }

  function scanAndInject() {
    const map = getProfessorNames();
    for (const [name, entries] of map.entries()) {
      handleProfessor(name, entries);
    }
  }

  function findCourseForElement(el) {
    const maxDepth = 6;
    let node = el;
    for (let i = 0; i < maxDepth && node; i += 1) {
      const text = (node.textContent || "").toUpperCase();
      const match = text.match(/\b([A-Z]{2,4})\s*-?\s*([0-9]{3}[A-Z]?)\b/);
      if (match) {
        return { dept: match[1], number: match[2] };
      }
      node = node.parentElement;
    }

    const tbody = el.closest("tbody");
    if (!tbody) return null;
    const rows = Array.from(tbody.querySelectorAll("tr"));
    if (rows.length === 0) return null;
    const rowIndex = rows.findIndex((r) => r.contains(el));
    const startIndex = rowIndex > 0 ? rowIndex - 1 : rows.length - 1;
    for (let i = startIndex; i >= 0; i -= 1) {
      const rowText = (rows[i].textContent || "").toUpperCase();
      const match = rowText.match(/\b([A-Z]{2,4})\s*-?\s*([0-9]{3}[A-Z]?)\b/);
      if (match) {
        return { dept: match[1], number: match[2] };
      }
    }
    return null;
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
