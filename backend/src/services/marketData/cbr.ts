/**
 * Bank of Russia key rate, from the CBR's own web service.
 *
 * WHY NOT FRED, WHICH EVERY OTHER BANK USES HERE. FRED's Russian series stopped
 * updating: `IRSTCB01RUM156N` (central bank rate) ends 2023-10 and
 * `IRSTCI01RUM156N` (call money) ends 2025-10. Showing a rate that is months
 * stale beside six current ones is worse than showing nothing, because nothing
 * on the row says it is old.
 *
 * The CBR publishes the key rate through a documented SOAP service returning
 * XML. That is a structured API, not a scrape of a rendered page — the same
 * standard applied when declining to pull CNN's undocumented Fear & Greed
 * endpoint.
 */

const ENDPOINT = 'https://www.cbr.ru/DailyInfoWebServ/DailyInfo.asmx';

export interface KeyRatePoint { date: string; rate: number }

function soapEnvelope(fromDate: string, toDate: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">` +
    `<soap:Body><KeyRateXML xmlns="http://web.cbr.ru/">` +
    `<fromDate>${fromDate}</fromDate><ToDate>${toDate}</ToDate>` +
    `</KeyRateXML></soap:Body></soap:Envelope>`;
}

/**
 * Daily key-rate observations, oldest first.
 *
 * Parsed with a tag-pair regex rather than an XML library: the response is a
 * flat, fixed list of <DT>/<Rate> pairs, so a dependency would buy nothing.
 * Returns an empty list on any failure — the rates page must render without it.
 */
export async function fetchKeyRate(years = 3): Promise<KeyRatePoint[]> {
  const to = new Date();
  const from = new Date(to.getTime() - years * 365 * 86_400_000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': 'http://web.cbr.ru/KeyRateXML',
      },
      body: soapEnvelope(iso(from), iso(to)),
    });
    if (!res.ok) throw new Error(`CBR: HTTP ${res.status}`);
    const xml = await res.text();
    const out: KeyRatePoint[] = [];
    const re = /<DT>(.*?)<\/DT>\s*<Rate>(.*?)<\/Rate>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) {
      const rate = Number(m[2]);
      if (Number.isFinite(rate)) out.push({ date: m[1].slice(0, 10), rate });
    }
    out.sort((a, b) => a.date.localeCompare(b.date));
    return out;
  } catch (e) {
    console.error('[CBR] key rate fetch failed', e);
    return [];
  }
}
