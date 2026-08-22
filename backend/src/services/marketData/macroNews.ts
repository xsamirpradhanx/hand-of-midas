/**
 * Macro and geopolitical headlines for the rates page.
 *
 * Finnhub's `general` category is the usable feed on a free key — the `forex`
 * category returned a single item — but it is a general business wire, so it
 * arrives mixed with consumer and lifestyle stories. This filters it down to
 * what bears on rates, currencies and geopolitical risk.
 *
 * KEYWORD MATCHING, AND SAID SO. This is a display filter, not comprehension.
 * It cannot tell a headline about gold bullion from one about a gold watch, and
 * a tag is a hint about why an item surfaced rather than a claim about what it
 * means. Nothing here is scored, weighted, or fed to a decision — news has no
 * clean backtestable history, so a news-driven factor could never be validated
 * in this project and none is attempted.
 */

export type MacroNewsTag = 'Policy' | 'Geopolitics' | 'Currency' | 'Commodities' | 'Data';

export interface MacroHeadline {
  id: string;
  headline: string;
  summary: string;
  source: string;
  url: string;
  /** Epoch seconds, as Finnhub reports it. */
  datetime: number;
  tags: MacroNewsTag[];
}

/**
 * Topic vocabulary, deliberately narrow.
 *
 * Terms are matched as whole words against the lower-cased headline and
 * summary. Short, ambiguous tokens ("war" inside "warrant", "fed" inside
 * "federated") are the reason for the word-boundary match rather than a
 * substring test.
 */
const VOCAB: Record<MacroNewsTag, string[]> = {
  Policy: [
    'fed', 'federal reserve', 'fomc', 'powell', 'rate cut', 'rate cuts', 'rate hike', 'rate hikes',
    'interest rate', 'interest rates', 'ecb', 'lagarde', 'bank of england', 'bank of japan', 'boj',
    'central bank', 'central banks', 'monetary policy', 'quantitative', 'basis points', 'policy rate',
    'yield curve', 'treasury yields', 'bond yields',
  ],
  Geopolitics: [
    'war', 'invasion', 'sanctions', 'sanction', 'tariff', 'tariffs', 'trade war', 'embargo',
    'missile', 'strike', 'strikes', 'ceasefire', 'conflict', 'military', 'nato', 'opec',
    'hormuz', 'blockade', 'coup', 'election', 'geopolitical', 'nuclear',
  ],
  Currency: [
    'dollar', 'euro', 'yen', 'sterling', 'pound', 'yuan', 'renminbi', 'rupee', 'rouble', 'ruble',
    'currency', 'currencies', 'forex', 'fx', 'devaluation', 'devalue', 'exchange rate', 'peg',
    // Majors alone missed emerging-market moves — a rand or lira headline is
    // squarely a currency story and was surfacing untagged.
    'rand', 'lira', 'peso', 'real', 'won', 'baht', 'ringgit', 'zloty', 'forint',
    'krona', 'krone', 'franc', 'shekel', 'dinar',
  ],
  Commodities: [
    'oil', 'crude', 'brent', 'wti', 'gold', 'silver', 'natural gas', 'commodity', 'commodities',
    'energy prices', 'copper',
  ],
  Data: [
    'inflation', 'cpi', 'ppi', 'jobs report', 'payrolls', 'unemployment', 'gdp', 'recession',
    'consumer price', 'economic growth', 'jobless',
  ],
};

/** Whole-word test, so "fed" does not match "federated" or "war" match "warrant". */
function mentions(text: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(text);
}

export function tagHeadline(headline: string, summary = ''): MacroNewsTag[] {
  const text = `${headline} ${summary}`.toLowerCase();
  const tags: MacroNewsTag[] = [];
  for (const [tag, terms] of Object.entries(VOCAB) as Array<[MacroNewsTag, string[]]>) {
    if (terms.some(t => mentions(text, t))) tags.push(tag);
  }
  return tags;
}

interface FinnhubNewsItem {
  id?: number; category?: string; datetime?: number; headline?: string;
  source?: string; summary?: string; url?: string;
}

/**
 * Fetch and filter. Returns newest first, only items matching at least one topic.
 *
 * Never throws: the rates page must still render when a news provider is down.
 */
export async function fetchMacroHeadlines(limit = 12): Promise<MacroHeadline[]> {
  const token = process.env['FINNHUB_API_KEY'];
  if (!token) return [];
  try {
    const res = await fetch(`https://finnhub.io/api/v1/news?category=general&token=${token}`);
    if (!res.ok) throw new Error(`Finnhub news: HTTP ${res.status}`);
    const items = await res.json() as FinnhubNewsItem[];
    if (!Array.isArray(items)) return [];

    const seen = new Set<string>();
    const out: MacroHeadline[] = [];
    for (const it of items) {
      const headline = (it.headline ?? '').trim();
      if (!headline) continue;
      const tags = tagHeadline(headline, it.summary ?? '');
      if (tags.length === 0) continue;
      // Wires syndicate the same story under different ids; dedupe on the
      // headline so one event does not fill the panel.
      const key = headline.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: String(it.id ?? key),
        headline,
        summary: (it.summary ?? '').trim().slice(0, 240),
        source: it.source ?? 'unknown',
        url: it.url ?? '',
        datetime: it.datetime ?? 0,
        tags,
      });
    }
    out.sort((a, b) => b.datetime - a.datetime);
    return out.slice(0, limit);
  } catch (e) {
    console.error('[MacroNews] fetch failed', e);
    return [];
  }
}
