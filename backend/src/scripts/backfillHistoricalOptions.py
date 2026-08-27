"""
Backfill historical EOD options chains from ThetaData into S3.

Usage:
  SYMBOLS=SPY,QQQ,AAPL START_DATE=2023-06-01 END_DATE=2026-08-26 \
    python3 src/scripts/backfillHistoricalOptions.py

  Optional: MAX_DTE (default 60), WORKERS (default 1 — see the note on
  single-request throttling below), FORCE=1 (re-pull dates already in S3),
  MAX_RETRIES (default 3).

MEASURED CONSTRAINTS on the FREE ThetaData tier (probed live 2026-08-27):

  * History floor is EXACTLY 2023-06-01. option_history_eod for 2023-05-31
    returns PERMISSION_DENIED ("requires a VALUE subscription"). Depth is not
    obtainable at this tier at any date range — only BREADTH is, which is why
    this script is built to fan across many symbols rather than reach further
    back.
  * option_history_open_interest -> PERMISSION_DENIED (needs VALUE)
  * option_history_greeks_eod / _implied_volatility -> PERMISSION_DENIED (needs
    STANDARD)
  * option_flat_file_eod (whole-market bulk, one call per date) ->
    PERMISSION_DENIED, so there is no bulk path; it is one call per
    symbol-date.
  * option_history_eod DOES return, per contract:
      symbol expiration strike right created last_trade open high low close
      volume count bid_size bid_exchange bid bid_condition ask_size
      ask_exchange ask ask_condition
    `count` is the NUMBER OF TRADES behind `volume` (AAPL 2026-08-25: 680,285
    contracts across 141,373 trades = 4.81 contracts/trade).
  * Passing max_dte server-side is both smaller AND faster than filtering
    locally (AAPL 2026-08-25: 3,352 rows / 0.73s unfiltered vs 1,460 rows /
    0.50s at max_dte=60).
  * THE TIER IS EFFECTIVELY SINGLE-REQUEST. Measured: a second ThetaClient
    fails UNAUTHENTICATED ("Invalid session ID... more than one terminal is
    running"), and even ONE shared client driven from 2-8 threads returns
    RESOURCE_EXHAUSTED on ~80% of calls. Concurrency is not available; WORKERS
    defaults to 1 for that reason, and raising it makes the run slower, not
    faster. Sustained serial rate measured over 10 consecutive dates:
    0.95 s/symbol-date, i.e. ~12.8 minutes per symbol for a full
    2023-06-01..today backfill (810 trading days).

WHAT CHANGED AND WHY (2026-08-27): the previous version requested all of the
above and then wrote only `close` and `volume`, discarding bid, ask, bid_size,
ask_size and count. Those four are the difference between a dataset that can
only count contracts and one that can say which SIDE the flow was on:

  * bid/ask -> the closing quote. `close` is the last TRADE, which on an
    illiquid strike can be hours stale; the quote midpoint is the honest mark,
    and it is what solved implied volatility should be inverted from.
  * close vs the bid-ask -> Lee-Ready / quote-rule classification of the day's
    volume as buyer- or seller-initiated. Without it there is no directional
    options-flow signal at all, only gross volume.
  * volume / count -> average contracts per trade, i.e. block-size detection.
  * bid_size / ask_size -> quoted book imbalance at the close.

Chains already in S3 that predate this carry neither, and are left alone unless
FORCE=1 — see `schemaVersion` on the record.
"""

import os
import sys
import time
import gzip
import json
import threading
import boto3
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, date, timedelta
from thetadata import ThetaClient

# Constants
S3_BUCKET = os.environ.get("S3_OPTIONS_BUCKET", "handofmidas-options-history")
REGION = "us-east-2"

# Bumped when the per-contract shape changes, so a reader can tell a chain that
# genuinely had no quote data from one written before quotes were captured.
# v1: close + volume only.  v2: adds last_quote (bid/ask/sizes) and trade_count.
SCHEMA_VERSION = 2

# Field-population thresholds for the "fail loudly on a partially-empty chain"
# rule below. A chain missing volume for 50% of its contracts is business as
# usual (illiquid strikes trade zero volume most days); a chain missing OI or
# greeks for anywhere near that share means the fetch itself is broken, not
# that the market was quiet.
MIN_OI_COVERAGE = 0.5
MIN_GREEKS_COVERAGE = 0.5

# Quotes come back on nearly every contract, liquid or not, because a quote is
# posted whether or not anything trades. A chain where most contracts have no
# quote means the response shape changed, not that the market was quiet — which
# is exactly the silent-degradation family of bug this repo has been bitten by
# twice. Enforced only for v2 writes.
MIN_QUOTE_COVERAGE = 0.5


def get_theta_api_key():
    try:
        ssm = boto3.client('ssm', region_name=REGION)
        resp = ssm.get_parameter(Name="/handofmidas/thetadata-api-key", WithDecryption=True)
        return resp['Parameter']['Value']
    except Exception as e:
        print(f"Error fetching API key from SSM: {e}")
        return None


def _is_permission_error(err) -> bool:
    msg = str(err)
    return 'PERMISSION_DENIED' in msg or 'subscription' in msg.lower()


def _is_throttled(err) -> bool:
    """RESOURCE_EXHAUSTED / session contention — retryable after a pause."""
    msg = str(err)
    return 'RESOURCE_EXHAUSTED' in msg or 'Invalid session' in msg


def contract_key(expiration: str, strike: float, right: str):
    """Join key shared across the eod/OI/greeks endpoints for one contract."""
    return (expiration, round(float(strike), 4), right)


class TierGatedFetcher:
    """
    Wraps an optional ThetaData endpoint (open interest, greeks) that this
    account's subscription may not include. On the first PERMISSION_DENIED it
    prints one warning and stops trying for the rest of the run — every
    subsequent date silently returns None rather than re-paying the RPC and
    re-printing the same warning hundreds of times.

    CONFIRMED GATED on this account (options_subscription == 0 == FREE): both
    option_history_open_interest and option_history_greeks_eod return
    PERMISSION_DENIED before any data comes back, so the response column names
    below are still UNVERIFIED against live data. `build_oi_map` /
    `build_greeks_map` try a couple of plausible variants and this class prints
    the ACTUAL columns the first time a call succeeds, specifically so it can be
    corrected fast against real data after a tier upgrade instead of guessed at
    again. Smoke-test on 1-2 dates after upgrading before trusting a full
    re-backfill.
    """

    def __init__(self, name: str):
        self.name = name
        self.gated = False
        self._logged_columns = False
        self._lock = threading.Lock()

    def fetch(self, fn, *args, **kwargs):
        if self.gated:
            return None
        try:
            df = fn(*args, **kwargs)
            with self._lock:
                if not self._logged_columns:
                    print(f"[{self.name}] live response columns: {list(df.columns)}")
                    self._logged_columns = True
            return df
        except Exception as e:
            if _is_permission_error(e):
                with self._lock:
                    if not self.gated:
                        print(f"[{self.name}] Not available on this ThetaData subscription tier ({e}). "
                              f"Continuing WITHOUT {self.name} for the rest of this run — contracts will "
                              f"omit the field rather than write a fabricated 0.")
                    self.gated = True
                return None
            # A real, non-tier failure (timeout, bad request, etc). Don't silently
            # eat it into "no data" — that's exactly how the last bug hid.
            print(f"[{self.name}] fetch failed (not a subscription issue): {e}")
            return None


def build_oi_map(df) -> dict:
    if df is None or df.shape[0] == 0:
        return {}
    out = {}
    for row in df.to_dicts():
        exp = row.get("expiration")
        strike = row.get("strike")
        right = (row.get("right") or "").upper()
        oi = row.get("open_interest", row.get("oi"))
        if exp is None or strike is None or not right or oi is None:
            continue
        out[contract_key(exp, strike, right)] = oi
    return out


def build_greeks_map(df) -> dict:
    if df is None or df.shape[0] == 0:
        return {}
    out = {}
    for row in df.to_dicts():
        exp = row.get("expiration")
        strike = row.get("strike")
        right = (row.get("right") or "").upper()
        if exp is None or strike is None or not right:
            continue
        out[contract_key(exp, strike, right)] = {
            "delta": row.get("delta"),
            "gamma": row.get("gamma"),
            "theta": row.get("theta"),
            "vega": row.get("vega"),
            "iv": row.get("implied_vol", row.get("iv")),
        }
    return out


def _num(value):
    """
    None stays None; anything numeric passes through.

    Deliberately NOT `value or 0`. A real 0 bid and an unreported bid are
    different facts, and collapsing them is precisely the bug that made every
    backfilled contract carry `open_interest: 0` as though it had been measured.
    """
    return value if isinstance(value, (int, float)) else None


def build_contract(row: dict, oi_map: dict, greeks_map: dict) -> dict:
    # ThetaData's `right` column is the full word "CALL"/"PUT", not a single
    # letter — comparing it to "C" here previously matched nothing, so every
    # contract silently wrote as a put regardless of its real side. Confirmed
    # live: a 50/50 CALL/PUT split comes back from this exact endpoint.
    right_raw = (row.get("right") or "").upper()
    contract_type = "call" if right_raw == "CALL" else "put"

    key = contract_key(row.get("expiration"), row.get("strike"), right_raw)
    oi = oi_map.get(key)
    greeks = greeks_map.get(key)

    close = _num(row.get("close"))
    if close is None:
        close = _num(row.get("ask"))
    if close is None:
        close = _num(row.get("bid"))

    bid = _num(row.get("bid"))
    ask = _num(row.get("ask"))
    bid_size = _num(row.get("bid_size"))
    ask_size = _num(row.get("ask_size"))
    trade_count = _num(row.get("count"))

    day = {
        "volume": row.get("volume", 0),
    }
    if close is not None:
        day["close"] = close
    # Omit rather than default to 0 when we don't have OI — 0 means "confirmed
    # no open interest", not "unknown". Downstream factors already treat
    # missing the same as zero (`contract.day?.open_interest || 0`), so this
    # changes nothing about factor behavior, only honesty about what was
    # actually measured.
    if oi is not None:
        day["open_interest"] = oi
    # Number of separate trades behind `volume`. volume/trade_count is average
    # contracts per trade — the block-size read that substitutes for the open
    # interest this tier cannot provide.
    if trade_count is not None:
        day["trade_count"] = trade_count

    c = {
        "details": {
            "contract_type": contract_type,
            "expiration_date": row.get("expiration"),
            "strike_price": row.get("strike"),
        },
        "day": day,
    }

    # The closing quote. Written under `last_quote` to match the shape the live
    # Polygon path already produces (PolygonOptionsContract.last_quote), so
    # every consumer reads one field name regardless of which feed filled it.
    if bid is not None or ask is not None:
        quote = {}
        if bid is not None:
            quote["bid"] = bid
        if ask is not None:
            quote["ask"] = ask
        if close is not None:
            quote["last"] = close
        if bid_size is not None:
            quote["bid_size"] = bid_size
        if ask_size is not None:
            quote["ask_size"] = ask_size
        c["last_quote"] = quote

    if greeks and greeks.get("iv") is not None:
        c["implied_volatility"] = greeks["iv"]
    if greeks:
        c["greeks"] = {
            "delta": greeks.get("delta"),
            "gamma": greeks.get("gamma"),
            "theta": greeks.get("theta"),
            "vega": greeks.get("vega"),
        }

    return c


# One ThetaClient per worker thread. The gRPC channel is not documented as
# thread-safe for concurrent streaming calls, and a client is cheap next to the
# request itself.
_thread_local = threading.local()


def get_client(api_key: str) -> ThetaClient:
    client = getattr(_thread_local, "client", None)
    if client is None:
        client = ThetaClient(api_key=api_key)
        _thread_local.client = client
    return client


def get_s3():
    s3 = getattr(_thread_local, "s3", None)
    if s3 is None:
        s3 = boto3.client('s3', region_name=REGION)
        _thread_local.s3 = s3
    return s3


def backfill_one(symbol: str, current_date: date, api_key: str, max_dte: int,
                 oi_fetcher: TierGatedFetcher, greeks_fetcher: TierGatedFetcher,
                 max_retries: int) -> str:
    """Fetch, validate and upload one symbol-date. Returns a short status word."""
    client = get_client(api_key)

    df = None
    for attempt in range(max_retries + 1):
        try:
            df = client.option_history_eod(
                current_date, current_date, symbol, "*",
                strike='*', right='both', max_dte=max_dte,
            )
            break
        except Exception as e:
            if _is_permission_error(e):
                # Before 2023-06-01 on the FREE tier. Not retryable, not a bug.
                return "denied"
            if attempt == max_retries:
                detail = str(e).split('details =')[-1].strip()[:120] if 'details =' in str(e) else str(e)[:120]
                print(f"[{symbol} {current_date}] failed after {max_retries + 1} attempts: {detail}")
                return "error"
            # Back off on throttling rather than hammering — this tier serves one
            # request at a time and answers a burst with RESOURCE_EXHAUSTED.
            time.sleep((2 ** attempt) if _is_throttled(e) else 0.5)

    if df is None or df.shape[0] == 0:
        return "empty"

    daily_contracts = df.to_dicts()

    oi_map = build_oi_map(oi_fetcher.fetch(
        client.option_history_open_interest, symbol, "*", date=current_date, strike='*', right='both'))
    greeks_map = build_greeks_map(greeks_fetcher.fetch(
        client.option_history_greeks_eod, symbol, "*", current_date, current_date, strike='*', right='both'))

    contracts = []
    oi_populated = greeks_populated = quote_populated = 0
    for row in daily_contracts:
        c = build_contract(row, oi_map, greeks_map)
        if "open_interest" in c["day"]:
            oi_populated += 1
        if "greeks" in c:
            greeks_populated += 1
        if "last_quote" in c:
            quote_populated += 1
        contracts.append(c)

    n = len(contracts)
    oi_coverage = oi_populated / n if n else 0
    greeks_coverage = greeks_populated / n if n else 0
    quote_coverage = quote_populated / n if n else 0

    # Only enforce the OI/greeks floors once the endpoint is actually answering
    # (not gated by tier) — a gated endpoint is expected to contribute 0% and
    # that's not a bug, it's already logged above.
    if not oi_fetcher.gated and oi_populated > 0 and oi_coverage < MIN_OI_COVERAGE:
        print(f"[{symbol} {current_date}] ABORTING upload: open_interest populated for only "
              f"{oi_coverage:.0%} of {n} contracts (< {MIN_OI_COVERAGE:.0%} floor). "
              f"This looks like a broken join, not a quiet market — investigate before re-running.")
        return "aborted"
    if not greeks_fetcher.gated and greeks_populated > 0 and greeks_coverage < MIN_GREEKS_COVERAGE:
        print(f"[{symbol} {current_date}] ABORTING upload: greeks populated for only "
              f"{greeks_coverage:.0%} of {n} contracts (< {MIN_GREEKS_COVERAGE:.0%} floor). "
              f"This looks like a broken join, not a quiet market — investigate before re-running.")
        return "aborted"
    if quote_coverage < MIN_QUOTE_COVERAGE:
        print(f"[{symbol} {current_date}] ABORTING upload: a closing quote was present for only "
              f"{quote_coverage:.0%} of {n} contracts (< {MIN_QUOTE_COVERAGE:.0%} floor). Quotes are posted "
              f"whether or not a contract trades, so this means the response shape changed — not a quiet market.")
        return "aborted"

    formatted_chain = {
        # OptionsChainRecord (marketData/optionsStore.ts) requires symbol/asOf/
        # expirations/contracts/source. This previously wrote underlying_ticker/
        # date and never set expirations at all — RiskReversalSkewFactor and
        # TermStructureFactor both hard-require `expirations.length`, and
        # IvRvRatioFactor filters contracts by `expiration_date === expirations[0]`,
        # so all three returned null on every single backfilled day regardless of
        # whether the contract data itself was usable.
        "symbol": symbol,
        "asOf": current_date.strftime("%Y-%m-%d"),
        "expirations": sorted({r.get("expiration") for r in daily_contracts if r.get("expiration")}),
        "source": "thetadata",
        "schemaVersion": SCHEMA_VERSION,
        "contracts": contracts,
    }

    compressed_data = gzip.compress(json.dumps(formatted_chain).encode('utf-8'))
    s3_key = f"options/{symbol}/{current_date.strftime('%Y-%m-%d')}.json.gz"
    get_s3().put_object(
        Bucket=S3_BUCKET,
        Key=s3_key,
        Body=compressed_data,
        ContentType="application/json",
        ContentEncoding="gzip",
    )
    return "uploaded"


def existing_dates(symbol: str) -> set:
    """Dates already in S3 for this symbol, so a long run is resumable."""
    s3 = boto3.client('s3', region_name=REGION)
    paginator = s3.get_paginator('list_objects_v2')
    found = set()
    for page in paginator.paginate(Bucket=S3_BUCKET, Prefix=f"options/{symbol}/"):
        for obj in page.get('Contents', []):
            name = obj['Key'].rsplit('/', 1)[-1]
            if name.endswith('.json.gz'):
                found.add(name[:-len('.json.gz')])
    return found


def main():
    raw_symbols = os.environ.get("SYMBOLS") or os.environ.get("SYMBOL")
    start_date_str = os.environ.get("START_DATE")
    end_date_str = os.environ.get("END_DATE")

    if not raw_symbols or not start_date_str or not end_date_str:
        print("Usage: SYMBOLS=SPY,QQQ START_DATE=YYYY-MM-DD END_DATE=YYYY-MM-DD "
              "[MAX_DTE=60] [WORKERS=4] [FORCE=1] python3 backfillHistoricalOptions.py")
        sys.exit(1)

    symbols = [s.strip().upper() for s in raw_symbols.split(',') if s.strip()]
    start_date = datetime.strptime(start_date_str, "%Y-%m-%d").date()
    end_date = datetime.strptime(end_date_str, "%Y-%m-%d").date()
    max_dte = int(os.environ.get("MAX_DTE", "60"))
    # 1, not a higher default: measured, this tier answers concurrent requests
    # with RESOURCE_EXHAUSTED (see the module docstring). Left configurable
    # because it stops being true after a paid upgrade.
    workers = int(os.environ.get("WORKERS", "1"))
    force = os.environ.get("FORCE") == "1"
    max_retries = int(os.environ.get("MAX_RETRIES", "3"))

    if start_date > end_date:
        print("START_DATE must be <= END_DATE")
        sys.exit(1)

    api_key = os.environ.get("THETA_API_KEY") or get_theta_api_key()
    if not api_key:
        print("Missing ThetaData API key.")
        sys.exit(1)

    probe = ThetaClient(api_key=api_key)
    print(f"options_subscription tier: {getattr(probe, 'options_subscription', 'unknown')} "
          f"(0 = FREE; open interest needs VALUE, greeks need STANDARD or higher)")
    print(f"{len(symbols)} symbol(s), {start_date}..{end_date}, max_dte={max_dte}, "
          f"workers={workers}, force={force}")
    if workers > 1 and getattr(probe, 'options_subscription', 0) == 0:
        print("  WARNING: WORKERS>1 on a FREE subscription. Measured, concurrent requests come back "
              "RESOURCE_EXHAUSTED ~80% of the time and the run gets SLOWER, not faster.")

    oi_fetcher = TierGatedFetcher("open_interest")
    greeks_fetcher = TierGatedFetcher("greeks")

    tasks = []
    for symbol in symbols:
        have = set() if force else existing_dates(symbol)
        d = start_date
        symbol_tasks = 0
        while d <= end_date:
            if d.weekday() < 5 and d.strftime("%Y-%m-%d") not in have:
                tasks.append((symbol, d))
                symbol_tasks += 1
            d += timedelta(days=1)
        print(f"  {symbol}: {symbol_tasks} dates to fetch ({len(have)} already stored)")

    if not tasks:
        print("Nothing to do.")
        return

    print(f"\n{len(tasks)} symbol-dates queued.\n")
    counts = {}
    done = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {
            pool.submit(backfill_one, sym, d, api_key, max_dte, oi_fetcher, greeks_fetcher, max_retries): (sym, d)
            for sym, d in tasks
        }
        for future in as_completed(futures):
            sym, d = futures[future]
            try:
                status = future.result()
            except Exception as e:
                status = "error"
                print(f"[{sym} {d}] unhandled: {e}")
            counts[status] = counts.get(status, 0) + 1
            done += 1
            if done % 100 == 0 or done == len(tasks):
                print(f"  {done}/{len(tasks)}  {counts}")

    print(f"\nBackfill complete: {counts}")
    if counts.get("denied"):
        print(f"  {counts['denied']} date(s) refused by the subscription tier — on FREE that means "
              f"before 2023-06-01, which is the hard floor for this account.")
    print("Verify before trusting the data: "
          "SYMS=... npm run check-options-coverage --workspace=backend")


if __name__ == "__main__":
    main()
