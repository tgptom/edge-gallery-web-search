(function (root, factory) {
  const shared = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = shared;
  } else {
    root.WebSearchShared = shared;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const CONFIG = Object.freeze({
    maxPages: 3,
    maxPagesDeep: 4,
    maxCharsPerPage: 2500,
    maxWikiArticles: 2,
    fetchTimeoutMs: 12000,
    minGoodPages: 2,
    minPageChars: 400,
    maxTotalChars: 12000,
    maxConcurrentRequests: 4,
    maxRetries: 2,
  });

  const WEATHER_KEYWORDS = Object.freeze([
    "weather", "forecast", "temperature", "wetter", "tiempo", "clima",
    "météo", "meteo", "погода", "天気", "天气", "날씨", "طقس",
    "hava durumu", "hava", "cuaca", "พยากรณ์อากาศ", "พยากรณ์", "อากาศ",
    "天氣", "天气预报", "날씨예보", "طقس اليوم", "मौसम पूर्वानुमान",
    "मौसम", "हवामान",
    "il tempo", "previsão do tempo", "previsão", "pronóstico",
  ]);
  const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const weatherAlternatives = WEATHER_KEYWORDS
    .slice()
    .sort((a, b) => b.length - a.length)
    .map((word) => escapeRegExp(word).replace(/\s+/g, "\\s+"));
  const WEATHER_RE = new RegExp(
    "(?:^|[^\\p{L}\\p{N}])(?:" + weatherAlternatives.join("|") + ")(?=$|[^\\p{L}\\p{N}])",
    "iu"
  );
  const WEATHER_REMOVE_RE = new RegExp(
    "(^|[^\\p{L}\\p{N}])(?:" + weatherAlternatives.join("|") + ")(?=$|[^\\p{L}\\p{N}])",
    "giu"
  );
  const WEATHER_PREPOSITION_RE =
    /^\s*(?:(?:the|el|la|le|der|die|das)\s+)?(?:in|at|for|of|à|en|de|del|do|da|na|no|во|в|في|में|के\s+लिए|の|の天気|に|于|在)\s+/iu;
  const PLACE_STOPWORDS = new Set([
    "right", "now", "today", "tonight", "tomorrow", "yesterday", "current",
    "currently", "outside", "here", "there", "this", "week", "weekend",
    "morning", "afternoon", "evening", "the", "a", "an", "like", "please",
    "forecast", "weather", "temperature", "heute", "jetzt", "morgen", "gestern",
    "draußen", "ahora", "hoy", "mañana", "actual", "actualmente",
    "maintenant", "aujourd'hui", "actuel", "сейчас", "сегодня", "завтра",
  ]);
  const STOPWORDS = new Set([
    "the", "a", "an", "of", "in", "on", "at", "to", "for", "and", "or", "is",
    "are", "was", "were", "be", "by", "with", "as", "it", "this", "that",
    "these", "those", "from", "about", "into", "what", "who", "where", "when",
    "why", "how", "does", "do", "did", "can", "could", "would", "der", "die",
    "das", "und", "oder", "ist", "sind", "ein", "eine", "im", "mit", "von",
    "el", "la", "los", "las", "y", "o", "de", "del", "en", "un", "una", "es",
    "son", "con", "le", "les", "et", "ou", "est", "sont", "une", "du", "des",
    "au", "aux", "il", "lo", "gli", "e", "è", "sono", "della",
  ]);

  function normalizeLanguage(language) {
    if (typeof language !== "string") return "en";
    const value = language.trim();
    if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(value)) return "en";
    return value.toLowerCase();
  }

  function hasWeatherKeyword(value) {
    return typeof value === "string" && WEATHER_RE.test(value);
  }

  function extractWeatherPlace(value) {
    if (typeof value !== "string") return "";
    return value
      .replace(WEATHER_REMOVE_RE, (_match, prefix) => prefix + " ")
      .replace(WEATHER_PREPOSITION_RE, "")
      .replace(/[?.,!]+$/u, "")
      .trim();
  }

  function looksLikePlace(value) {
    if (!value) return false;
    const tokens = value.toLowerCase().split(/[\s,.;:!?]+/u).filter(Boolean);
    const meaningful = tokens.filter((token) => !PLACE_STOPWORDS.has(token));
    return meaningful.length > 0 &&
      !meaningful.every((token) => /^\d+$/u.test(token) || [...token].length < 2);
  }

  function tokenize(value) {
    return (value || "").toLowerCase()
      .normalize("NFKC")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/u)
      .filter((token) => token && [...token].length >= 2 && !STOPWORDS.has(token));
  }

  function characterNgrams(value, size = 2) {
    const compact = (value || "").toLowerCase().normalize("NFKC")
      .replace(/[^\p{L}\p{N}]/gu, "");
    const chars = [...compact];
    const grams = new Set();
    for (let i = 0; i <= chars.length - size; i++) {
      grams.add(chars.slice(i, i + size).join(""));
    }
    return grams;
  }

  function pagesAreOnTopic(query, pages) {
    if (!Array.isArray(pages) || !pages.length) return false;
    const qTokens = tokenize(query);
    const normalizedQuery = (query || "").toLowerCase().normalize("NFKC")
      .replace(/[^\p{L}\p{N}]/gu, "");
    const qGrams = characterNgrams(query);
    for (const page of pages) {
      const blob = ((page.title || "") + " " + (page.content || ""))
        .toLowerCase().normalize("NFKC");
      const normalizedBlob = blob.replace(/[^\p{L}\p{N}]/gu, "");
      if (qTokens.some((token) => blob.includes(token))) return true;
      if (normalizedQuery.length >= 2 && normalizedBlob.includes(normalizedQuery)) {
        return true;
      }
      if (qGrams.size >= 2) {
        const pageGrams = characterNgrams(blob);
        let overlap = 0;
        for (const gram of qGrams) if (pageGrams.has(gram)) overlap++;
        if (overlap / qGrams.size >= 0.5) return true;
      }
    }
    return false;
  }

  function stripHtml(value) {
    return String(value || "")
      .replace(/<script\b[\s\S]*?<\/script\s*>/giu, " ")
      .replace(/<style\b[\s\S]*?<\/style\s*>/giu, " ")
      .replace(/<[^>]+>/gu, " ")
      .replace(/&nbsp;/giu, " ")
      .replace(/&amp;/giu, "&")
      .replace(/&lt;/giu, "<")
      .replace(/&gt;/giu, ">")
      .replace(/&quot;/giu, '"')
      .replace(/&#39;/giu, "'")
      .replace(/&#(\d+);/gu, (_, number) => String.fromCodePoint(Number(number)))
      .replace(/&#x([0-9a-f]+);/giu, (_, number) =>
        String.fromCodePoint(parseInt(number, 16)))
      .replace(/\s+/gu, " ")
      .trim();
  }

  function isEngineUrl(value, engine) {
    try {
      const hostname = new URL(value).hostname.toLowerCase();
      if (engine === "duckduckgo") return hostname === "duckduckgo.com" ||
        hostname.endsWith(".duckduckgo.com");
      return hostname === "bing.com" || hostname.endsWith(".bing.com") ||
        hostname === "microsoft.com" || hostname.endsWith(".microsoft.com") ||
        hostname === "microsofttranslator.com" ||
        hostname.endsWith(".microsofttranslator.com");
    } catch {
      return true;
    }
  }

  function normalizeResultUrl(value, engine) {
    let href = String(value || "").replace(/&amp;/giu, "&").trim();
    if (engine === "duckduckgo") {
      const match = /[?&]uddg=([^&]+)/iu.exec(href);
      if (match) {
        try { href = decodeURIComponent(match[1]); } catch { return ""; }
      }
    }
    try {
      const parsed = new URL(href);
      if (!/^https?:$/iu.test(parsed.protocol) || isEngineUrl(href, engine)) return "";
      return parsed.href;
    } catch {
      return "";
    }
  }

  function extractDuckDuckGoResults(html, limit = 8) {
    const results = [];
    const seen = new Set();
    const anchors = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/giu;
    let match;
    while ((match = anchors.exec(String(html || ""))) !== null) {
      const attrs = match[1];
      const hrefMatch = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/iu.exec(attrs);
      const classMatch = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/iu.exec(attrs);
      const href = hrefMatch && (hrefMatch[1] || hrefMatch[2] || hrefMatch[3]);
      const classes = classMatch && (classMatch[1] || classMatch[2] || classMatch[3]) || "";
      if (!href || (!/result__a/iu.test(classes) && !/[?&]uddg=/iu.test(href))) continue;
      const url = normalizeResultUrl(href, "duckduckgo");
      const title = stripHtml(match[2]);
      if (!url || !title || seen.has(url)) continue;
      seen.add(url);
      results.push({ title, url });
      if (results.length >= limit) break;
    }
    return results;
  }

  function extractBingResults(markdown, limit = 8) {
    const results = [];
    const seen = new Set();
    const add = (title, href) => {
      let url = normalizeResultUrl(href, "bing");
      if (!url) {
        try {
          const parsed = new URL(href);
          if (/^\/ck\/a\/?$/u.test(parsed.pathname) &&
              /(^|\.)bing\.com$/iu.test(parsed.hostname)) {
            let encoded = (parsed.searchParams.get("u") || "")
              .replace(/^a1/u, "").replace(/-/gu, "+").replace(/_/gu, "/");
            encoded += "=".repeat((4 - encoded.length % 4) % 4);
            const decoded = typeof atob === "function" ? atob(encoded) : "";
            url = normalizeResultUrl(decoded, "bing");
          }
        } catch {}
      }
      const cleanTitle = stripHtml(title).replace(/^image\s+\d+:?\s*/iu, "")
        .replace(/^global\s+web\s+icon\s*/iu, "").trim();
      if (!url || cleanTitle.length < 3 || /^image\s+\d+/iu.test(cleanTitle) ||
          seen.has(url)) return;
      seen.add(url);
      results.push({ title: cleanTitle, url });
    };
    const mdLink = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)(?:\s+"[^"]*")?\)/giu;
    let match;
    while ((match = mdLink.exec(String(markdown || ""))) !== null && results.length < limit) {
      add(match[1], match[2]);
    }
    if (results.length < limit) {
      for (const line of String(markdown || "").split(/\r?\n/u)) {
        const pair = /^\s*(.{3,160}?)\s*(?:—|[-:])\s*(https?:\/\/\S+)/u.exec(line);
        if (pair) add(pair[1], pair[2].replace(/[),.]+$/u, ""));
        if (results.length >= limit) break;
      }
    }
    return results.slice(0, limit);
  }

  function isUsableContent(value) {
    const text = String(value || "").trim();
    if (text.length < 200) return false;
    const visible = [...text].filter((character) => !/\s/u.test(character));
    if (!visible.length) return false;
    const textChars = visible.filter((character) => /[\p{L}\p{N}]/u.test(character));
    if (textChars.length < 120 || textChars.length / visible.length < 0.35) return false;
    if (/^(?:access denied|enable javascript|captcha|page not found|robots\.txt)\b/iu
      .test(text) && text.length < 1200) return false;
    const blocks = text.split(/\n{2,}/u).map((block) => block.trim())
      .filter((block) => block.length >= 30);
    if (blocks.length >= 4) {
      const uniqueBlocks = new Set(blocks.map((block) =>
        block.toLowerCase().replace(/\s+/gu, " ")));
      if (uniqueBlocks.size / blocks.length < 0.5) return false;
    }
    const lines = text.split(/\r?\n/u).map((line) => line.trim())
      .filter((line) => line.length >= 30);
    if (lines.length >= 5) {
      const uniqueLines = new Set(lines.map((line) =>
        line.toLowerCase().replace(/\s+/gu, " ")));
      if (uniqueLines.size / lines.length < 0.5) return false;
    }
    return true;
  }

  function truncateSections(header, blocks, maxChars, marker) {
    const footer = marker || "... [TRUNCATED TO SAVE CONTEXT]";
    const sections = [String(header || ""), ...(blocks || []).filter(Boolean)];
    const text = sections.join("\n\n");
    if (text.length <= maxChars) return text;
    let output = sections[0];
    const allowance = Math.max(0, maxChars - footer.length - output.length - 2);
    for (let i = 1; i < sections.length; i++) {
      const section = sections[i];
      const addition = "\n\n" + section;
      if (output.length + addition.length + footer.length + 2 <= maxChars) {
        output += addition;
      } else {
        break;
      }
    }
    if (output.length > allowance + sections[0].length + 2) {
      output = output.slice(0, allowance + sections[0].length + 2);
    }
    return output.trimEnd() + "\n\n" + footer;
  }

  let activeRequests = 0;
  const requestQueue = [];
  async function withRequestSlot(task) {
    if (activeRequests >= CONFIG.maxConcurrentRequests) {
      await new Promise((resolve) => requestQueue.push(resolve));
    } else {
      activeRequests++;
    }
    try {
      return await task();
    } finally {
      const next = requestQueue.shift();
      if (next) next();
      else activeRequests--;
    }
  }

  function createRequestController(settings = {}) {
    const stats = { attempts: 0, retries: 0, failures: 0 };
    const fetchImpl = settings.fetchImpl || ((...args) => fetch(...args));
    const sleep = settings.sleep || ((ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)));
    const random = settings.random || Math.random;
    const retries = settings.maxRetries == null ? CONFIG.maxRetries : settings.maxRetries;
    const timeoutMs = settings.timeoutMs || CONFIG.fetchTimeoutMs;

    async function request(url, options = {}) {
      for (let attempt = 0; ; attempt++) {
        stats.attempts++;
        try {
          const response = await withRequestSlot(async () => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            try {
              return await fetchImpl(url, { ...options, signal: controller.signal });
            } finally {
              clearTimeout(timer);
            }
          });
          if (response.status === 429 || response.status === 503 ||
              response.status >= 500) {
            if (attempt < retries) {
              stats.retries++;
              await sleep(150 * (2 ** attempt) + Math.floor(random() * 150));
              continue;
            }
            stats.failures++;
          }
          return response;
        } catch (error) {
          const retryable = error && (error.name === "AbortError" ||
            error.name === "TimeoutError" || error instanceof TypeError);
          if (retryable && attempt < retries) {
            stats.retries++;
            await sleep(150 * (2 ** attempt) + Math.floor(random() * 150));
            continue;
          }
          stats.failures++;
          throw error;
        }
      }
    }

    return { request, stats };
  }

  return {
    CONFIG,
    WEATHER_KEYWORDS,
    normalizeLanguage,
    hasWeatherKeyword,
    extractWeatherPlace,
    looksLikePlace,
    tokenize,
    pagesAreOnTopic,
    stripHtml,
    extractDuckDuckGoResults,
    extractBingResults,
    isUsableContent,
    truncateSections,
    createRequestController,
  };
});
