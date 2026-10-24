// Web Search skill — multi-source: DuckDuckGo + Wikipedia + Jina Reader.
// Usage (Edge Gallery webview / Node 18+): search(query) -> Promise<object>
// CLI:  node scripts/search.js "your query"
//
// Strategy (each layer is best-effort; failures are skipped, not thrown):
//   1. DuckDuckGo Instant Answer API for direct abstracts/definitions.
//   2. Wikipedia full-text search + REST summary for the top matching
//      articles. Works for almost any noun-phrase query and is highly
//      reliable (no bot blocks).
//   3. DuckDuckGo HTML SERP scrape for organic web results.
//   4. Page content fetched via Jina Reader (https://r.jina.ai/<url>),
//      which returns clean markdown and bypasses most bot/JS walls.
//      Direct fetch is used as a fallback if Jina fails.

const Shared = require('./shared.js');
const {
  CONFIG,
  extractBingResults,
  extractDuckDuckGoResults,
  isUsableContent,
  normalizeLanguage,
  stripHtml,
} = Shared;

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const {
  maxPages: MAX_PAGES,
  maxPagesDeep: MAX_PAGES_DEEP,
  maxCharsPerPage: MAX_CHARS_PER_PAGE,
  maxWikiArticles: MAX_WIKI_ARTICLES,
  minGoodPages: MIN_GOOD_PAGES,
  minPageChars: MIN_PAGE_CHARS,
} = CONFIG;
const REQUESTS = Shared.createRequestController();

async function fetchWithTimeout(url, opts = {}) {
  return REQUESTS.request(url, opts);
}

async function instantAnswer(query) {
  const url =
    'https://api.duckduckgo.com/?q=' +
    encodeURIComponent(query) +
    '&format=json&no_html=1&skip_disambig=1';
  try {
    const res = await fetchWithTimeout(url, {
      headers: { Accept: 'application/json', 'User-Agent': UA },
    });
    if (!res.ok) return {};
    return await res.json();
  } catch {
    return {};
  }
}

async function wikipediaArticles(query, lang) {
  try {
    const host = 'https://' + normalizeLanguage(lang) + '.wikipedia.org';
    const sUrl =
      host + '/w/api.php?action=query&format=json' +
      '&list=search&srlimit=' +
      MAX_WIKI_ARTICLES +
      '&srsearch=' +
      encodeURIComponent(query) +
      '&origin=*';
    const sRes = await fetchWithTimeout(sUrl, {
      headers: { Accept: 'application/json', 'User-Agent': UA },
    });
    if (!sRes.ok) return [];
    const sJson = await sRes.json();
    const titles = (sJson.query && sJson.query.search ? sJson.query.search : [])
      .map((h) => h.title)
      .filter(Boolean)
      .slice(0, MAX_WIKI_ARTICLES);

    const summaries = await Promise.all(
      titles.map(async (title) => {
        try {
          const u =
            host + '/api/rest_v1/page/summary/' +
            encodeURIComponent(title.replace(/ /g, '_'));
          const r = await fetchWithTimeout(u, {
            headers: { Accept: 'application/json', 'User-Agent': UA },
          });
          if (!r.ok) return null;
          const j = await r.json();
          if (!j.extract) return null;
          return {
            title: j.title || title,
            url:
              (j.content_urls &&
                j.content_urls.desktop &&
                j.content_urls.desktop.page) ||
              host + '/wiki/' +
                encodeURIComponent(title.replace(/ /g, '_')),
            extract: j.extract,
          };
        } catch {
          return null;
        }
      })
    );
    return summaries.filter(Boolean);
  } catch {
    return [];
  }
}

async function bingSearchViaJina(query) {
  // Fetches Bing's SERP through Jina Reader (which returns markdown) and
  // extracts external result URLs. Used as an alternate SERP when DDG is
  // empty or blocked.
  try {
    const url =
      'https://r.jina.ai/https://www.bing.com/search?q=' +
      encodeURIComponent(query);
    const res = await fetchWithTimeout(url, {
      headers: { 'User-Agent': UA, Accept: 'text/plain, text/markdown' },
    });
    if (!res.ok) return [];
    return extractBingResults(await res.text());
  } catch {
    return [];
  }
}

async function duckduckgoHtmlSearch(query) {
  try {
    const url =
      'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
    const res = await fetchWithTimeout(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
    });
    if (!res.ok) return [];
    return extractDuckDuckGoResults(await res.text());
  } catch {
    return [];
  }
}

async function fetchViaJina(url) {
  try {
    const res = await fetchWithTimeout('https://r.jina.ai/' + url, {
      headers: { 'User-Agent': UA, Accept: 'text/plain, text/markdown' },
    });
    if (!res.ok) return '';
    const text = (await res.text()).trim();
    return isUsableContent(text)
      ? { content: text.slice(0, MAX_CHARS_PER_PAGE), via: 'jina' }
      : null;
  } catch {
    return null;
  }
}

async function fetchDirect(url) {
  try {
    const res = await fetchWithTimeout(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,*/*' },
      redirect: 'follow',
    });
    if (!res.ok) return '';
    const ct = res.headers.get('content-type') || '';
    if (!/text\/html|text\/plain|application\/xhtml/i.test(ct)) return '';
    const html = await res.text();
    const text = stripHtml(html).slice(0, MAX_CHARS_PER_PAGE);
    return isUsableContent(text) ? text : '';
  } catch {
    return '';
  }
}

async function fetchPageContent(url) {
  const viaJina = await fetchViaJina(url);
  if (viaJina) return viaJina;
  const direct = await fetchDirect(url);
  if (direct) return { content: direct, via: 'direct' };
  return { content: '', via: '' };
}

async function search(query, options = {}) {
  if (!query || typeof query !== 'string') {
    throw new Error('search(query): query must be a non-empty string');
  }
  options = options || {};
  const lang = normalizeLanguage(options.lang);

  // Run the three lookups in parallel.
  const [ia, wiki, serp] = await Promise.all([
    instantAnswer(query),
    wikipediaArticles(query, lang),
    duckduckgoHtmlSearch(query),
  ]);

  const relatedTopics = [];
  for (const t of ia.RelatedTopics || []) {
    if (t.Text && t.FirstURL) {
      relatedTopics.push({ text: t.Text, url: t.FirstURL });
    } else if (Array.isArray(t.Topics)) {
      for (const sub of t.Topics) {
        if (sub.Text && sub.FirstURL) {
          relatedTopics.push({ text: sub.Text, url: sub.FirstURL });
        }
      }
    }
    if (relatedTopics.length >= 8) break;
  }

  const wikiUrls = new Set(wiki.map((w) => w.url));
  const fetchedUrls = new Set();
  const pages = [];

  async function fetchBatch(candidates) {
    const fresh = [];
    for (const r of candidates) {
      if (!r || !r.url) continue;
      if (fetchedUrls.has(r.url)) continue;
      if (wikiUrls.has(r.url)) continue;
      fresh.push(r);
      fetchedUrls.add(r.url);
    }
    const got = await Promise.all(
      fresh.map(async (r) => {
        const { content, via } = await fetchPageContent(r.url);
        return content && content.length >= MIN_PAGE_CHARS
          ? { title: r.title, url: r.url, via, content }
          : null;
      })
    );
    for (const p of got) if (p) pages.push(p);
  }

  // Phase 1: top-N from primary SERP.
  let allResults = serp.slice();
  await fetchBatch(allResults.slice(0, MAX_PAGES));

  const escalations = [];
  const hasInstant = ia.Answer || ia.AbstractText || ia.Definition;

  // Phase 2: dig deeper if the first pass came up thin.
  if (pages.length < MIN_GOOD_PAGES && !hasInstant) {
    escalations.push('serp-deep');
    await fetchBatch(allResults.slice(MAX_PAGES, MAX_PAGES + MAX_PAGES_DEEP));
  }

  // Phase 3: alternate SERP (Bing via Jina) if DDG was empty/blocked or
  // the deep dig still hasn't produced enough content.
  if (pages.length < MIN_GOOD_PAGES && !hasInstant) {
    escalations.push('bing');
    const bing = await bingSearchViaJina(query);
    const seenUrls = new Set(allResults.map((r) => r.url));
    for (const r of bing) if (!seenUrls.has(r.url)) allResults.push(r);
    await fetchBatch(bing.slice(0, MAX_PAGES_DEEP));
  }

  // Phase 4: pull full Wikipedia article bodies via Jina if we have wiki
  // candidates but still nothing else substantive.
  if (pages.length < MIN_GOOD_PAGES && wiki.length > 0) {
    escalations.push('wiki-full');
    await fetchBatch(
      wiki.map((w) => ({ title: w.title, url: w.url })).slice(0, 2)
    );
  }

  const output = {
    heading: ia.Heading || '',
    answer: ia.Answer || '',
    abstract: ia.AbstractText || '',
    abstractUrl: ia.AbstractURL || '',
    definition: ia.Definition || '',
    definitionUrl: ia.DefinitionURL || '',
    relatedTopics,
    wikipedia: wiki,
    results: allResults,
    pages,
    escalations,
  };
  if (options.debug === true) {
    output.debug = {
      counts: {
        results: allResults.length,
        wikipedia: wiki.length,
        pages: pages.length,
      },
      escalationSteps: escalations.slice(),
      sourceUsage: pages.reduce((usage, page) => {
        if (page.via) usage[page.via] = (usage[page.via] || 0) + 1;
        return usage;
      }, {}),
    };
  }
  return output;
}

if (typeof module !== 'undefined') {
  module.exports = { search };
}

if (typeof require !== 'undefined' && require.main === module) {
  const query = process.argv.slice(2).join(' ');
  search(query)
    .then((r) => {
      process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    })
    .catch((err) => {
      process.stderr.write('error: ' + err.message + '\n');
      process.exit(1);
    });
}
