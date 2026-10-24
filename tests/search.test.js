const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const Shared = require("../scripts/shared.js");

test("language tags are normalized and malformed input falls back to English", () => {
  assert.equal(Shared.normalizeLanguage("pt-BR"), "pt-br");
  assert.equal(Shared.normalizeLanguage("zh-Hans"), "zh-hans");
  for (const value of ["foo/bar", "en..", "x", "en-"]) {
    assert.equal(Shared.normalizeLanguage(value), "en");
  }
});

test("weather intent and place extraction cover multiple writing systems", () => {
  const examples = [
    ["weather in London", "London"],
    ["tiempo en Madrid", "Madrid"],
    ["météo à Paris", "Paris"],
    ["погода в Москве", "Москве"],
    ["天気 東京", "東京"],
    ["날씨 서울", "서울"],
    ["طقس في القاهرة", "القاهرة"],
    ["मौसम मुंबई", "मुंबई"],
  ];
  for (const [query, place] of examples) {
    assert.equal(Shared.hasWeatherKeyword(query), true, query);
    assert.equal(Shared.extractWeatherPlace(query), place, query);
    assert.equal(Shared.looksLikePlace(place), true, place);
  }
  assert.equal(Shared.hasWeatherKeyword("best weather apps"), true);
  assert.equal(Shared.hasWeatherKeyword("theater in London"), false);
});

test("SERP extraction tolerates attribute order and filters engine URLs", () => {
  const ddg = [
    '<a href="https://example.com/a" data-x="1" class="result__a">Example &amp; title</a>',
    '<a class="result__a" href="//duckduckgo.com/about">Engine result</a>',
    '<a class="result__a" href="https://example.com/a">Duplicate</a>',
  ].join("");
  assert.deepEqual(Shared.extractDuckDuckGoResults(ddg), [
    { title: "Example & title", url: "https://example.com/a" },
  ]);

  const bing = [
    "[Useful result](https://example.org/article)",
    "Another useful result — https://example.net/page",
    "[Bing chrome](https://www.bing.com/search?q=x)",
  ].join("\n");
  assert.deepEqual(Shared.extractBingResults(bing), [
    { title: "Useful result", url: "https://example.org/article" },
    { title: "Another useful result", url: "https://example.net/page" },
  ]);
});

test("HTML text extraction handles variant closing tags without double decoding", () => {
  assert.equal(
    Shared.stripHtml("<script>discard me</script \n extra>Visible &amp; text"),
    "Visible & text"
  );
  assert.equal(Shared.stripHtml("&amp;lt;script&amp;gt;"), "&lt;script&gt;");
});

test("proxied content validation rejects boilerplate and repeated junk", () => {
  assert.equal(Shared.isUsableContent("Access denied. ".repeat(30)), false);
  const repeated = "A repeated paragraph with enough readable words. ".repeat(10);
  assert.equal(Shared.isUsableContent(Array(5).fill(repeated).join("\n\n")), false);
  const prose = "A useful article contains readable sentences and details. ".repeat(8);
  assert.equal(Shared.isUsableContent(prose), true);
});

test("relevance matching supports short and CJK queries", () => {
  assert.equal(
    Shared.pagesAreOnTopic("東京駅", [{ title: "東京駅の案内", content: "乗り換え情報" }]),
    true
  );
  assert.equal(
    Shared.pagesAreOnTopic("AI", [{ title: "AI research", content: "A brief overview" }]),
    true
  );
  assert.equal(
    Shared.pagesAreOnTopic("無関係な語", [{ title: "Generic portal", content: "Other material" }]),
    false
  );
});

test("truncation keeps complete sections and a marker", () => {
  const text = Shared.truncateSections(
    "QUERY: example\nRESPONSE_LANGUAGE: en",
    ["DRAFT_ANSWER: Short answer.", "PAGES:\n[1] First page — https://example.com\n" + "content ".repeat(30)],
    100
  );
  assert.match(text, /^QUERY: example\nRESPONSE_LANGUAGE: en/u);
  assert.match(text, /DRAFT_ANSWER: Short answer\./u);
  assert.match(text, /\[TRUNCATED TO SAVE CONTEXT\]/u);
  assert.doesNotMatch(text, /\[1\] First page/u);
});

test("request controller retries transient statuses and caps concurrency", async () => {
  let calls = 0;
  const retried = Shared.createRequestController({
    maxRetries: 2,
    fetchImpl: async () => ({ status: ++calls === 1 ? 503 : 200 }),
    sleep: async () => {},
    random: () => 0,
  });
  assert.equal((await retried.request("https://example.com")).status, 200);
  assert.equal(retried.stats.retries, 1);

  let active = 0;
  let peak = 0;
  const concurrent = Shared.createRequestController({
    maxRetries: 0,
    fetchImpl: async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return { status: 200 };
    },
  });
  await Promise.all(Array.from({ length: 12 }, (_, i) =>
    concurrent.request("https://example.com/" + i)));
  assert.ok(peak <= Shared.CONFIG.maxConcurrentRequests, `peak was ${peak}`);
});

test("Edge Gallery handler safely falls back for invalid language and adds opt-in debug", async () => {
  const html = fs.readFileSync(
    path.join(__dirname, "../scripts/index.html"),
    "utf8"
  );
  const inlineScript = html.match(/<script>\s*([\s\S]*?)<\/script>/iu)[1];
  const urls = [];
  const context = {
    window: { WebSearchShared: Shared },
    fetch: async (url) => {
      urls.push(url);
      return { ok: false, status: 404 };
    },
    AbortController,
    URL,
    atob,
    setTimeout,
    clearTimeout,
    console,
  };
  vm.runInNewContext(inlineScript, context);
  const handler = context.window.ai_edge_gallery_get_result;
  const normal = JSON.parse(await handler(JSON.stringify({
    query: "example topic",
    lang: "foo/bar",
  })));
  assert.deepEqual(Object.keys(normal), ["result"]);
  assert.ok(urls.every((url) => {
    try { new URL(url); return true; } catch { return false; }
  }));
  assert.ok(urls.some((url) => url.startsWith("https://en.wikipedia.org/")));
  assert.ok(!urls.some((url) => url.includes("foo/bar")));

  const debug = JSON.parse(await handler(JSON.stringify({
    query: "example topic",
    debug: true,
  })));
  assert.ok(debug.result);
  assert.deepEqual(Object.keys(debug).sort(), ["debug", "result"]);
  assert.equal(typeof debug.debug.counts.results, "number");
  assert.ok(Array.isArray(debug.debug.escalationSteps));
});
