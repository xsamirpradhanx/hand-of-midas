# Hand of Midas — working brief for an agent

You are continuing quantitative work on a live trading-intelligence system. Read
this before running anything. The most valuable thing in this repo is not the
code — it is the **measurement discipline**, which was expensive to build and is
easy to throw away.

---

## What this is

A personal, single-user tool with three surfaces over one engine:

- a web UI (`frontend/`) for looking at charts, screeners and AI trade plans
- an **MCP connector** (`npm run mcp --workspace=backend`, see `backend/MCP.md`)
  exposing market intelligence and an order path as tools
- a planned **trading bot** that will drive the same path

Everything runs against the author's own brokerage account. There is no
multi-tenant requirement.

---

## The bar

**A finding is not real until it survives three independent tests.** This is not
methodological theatre. Over one working session, four promising findings were
put through it and **only one survived**:

| claim | looked like | died at |
|---|---|---|
| conviction is anti-predictive | t≈−0.066 correlation, clean gradient | gradient *reversed* on a wider universe |
| factor disagreement beats consensus | +0.519R vs +0.102R, and it **replicated** on a disjoint symbol split (t≈2.04) | vanished at n=3,154 (t≈−0.29) |
| the learning loop improves results | R/DD 12.51 → 24.08, +92% | 50.1% of bootstrap resamples — a coin flip |
| accuracy-based position sizing | t≈5.35 on 171 unseen symbols | **it was a long/short classifier** — see below |

Note the second row. It survived an out-of-sample check *and was still noise*.
n=122 at t≈2.04 could never carry that conclusion however good the story sounded
— and it had a very good story ("consensus is already priced in").

Note the fourth row harder. Sizing passed three of four tests on 11,676 trades
across symbols chosen specifically because they had no part in its design, and
it was **still wrong**. `factor-audit` later showed why: raw directional accuracy
correlates **0.991** with how often a factor votes long, and equities rose in
**55.7%** of 20-bar windows. So a score built from those accuracies is a long
bias wearing a lab coat. The proof is that it stops separating the moment you
hold direction fixed — LONG-only t≈−0.62, SHORT-only t≈1.52 — while sorting
almost perfectly on direction itself (bottom bucket 2.7% long, top 97.5%).

**Four claims went through the gauntlet. Four were retracted.** Assume your
finding is the fifth until it survives a control it cannot game.

### The three tests

1. **Two-sample t-test on expectancy.** Blunt, but catches the obvious.
2. **Paired sign test across calendar years.** Robust to distribution. When
   comparing two weightings of the *same* trades this is genuinely paired and is
   the strongest evidence available; when comparing two different trade
   populations, pair by period, never by trade.
3. **Block bootstrap on return-per-drawdown**, resampling contiguous blocks so
   ordering is preserved. Max drawdown is a single extreme statistic — it is very
   easy to get lucky on, and it is exactly what produced the false "+92%".

A fourth check is often decisive and costs nothing: **does the effect scale
monotonically with how hard you apply it?** Noise does not.

### Rules of thumb earned the hard way

- **t≈2 on a few hundred observations is not a finding.** Two died there.
- **Prefer retraction to hedging.** If it does not survive, say so plainly and
  remove the code it justified. A null mechanism left in place implies an effect
  it does not have.
- **State effect sizes out-of-sample.** Sizing measured +13.4% in-sample and
  +6.4% out. The second number is the one to plan against.
- **Write the retraction down.** `MEMORY`-style notes and commit messages here
  record dead findings specifically so nobody re-litigates them.

---

## Traps that have actually bitten

These are not hypothetical. Each was found in this repo.

**Look-ahead through the back door.** The replay grades a plan decided at bar *i*
using bars *i+1…i+20*, so the loop knows outcomes long before a live system
would. Feeding that into a later decision leaks the future. Worse: the replay
originally walked **symbol by symbol**, so a shared learning tally held AAPL's
2026 outcomes while MSFT's 1985 bars were being decided. `replayEngine.ts` now
walks a **merged timeline in global date order** and releases a graded trade into
the tally only once the calendar reaches its resolution date. Do not undo this.

**Tests that cannot fail.** Two false greens were found. One asserted the
conviction formula by *re-implementing it locally*, so it kept passing after
production changed. Another bounded look-ahead feedback by decision count, which
the leak also satisfied. **After writing a guard, deliberately break the thing it
guards and confirm the suite fails.** If it does not, the test is decoration.

**Duplicate rows masquerading as sample size.** The screener once wrote a fresh
prediction row on every scan pass — 2,672 rows were 693 distinct plans, and one
symbol supplied 184 of 1,043 graded outcomes, all the same losing plan. Before
trusting any n, check how many *distinct* things it represents.

**Modelled R is not realised R.** A win is credited the full planned
reward:risk, a loss debited exactly 1.0, and there is no slippage, partial-fill
or queue model anywhere. Absolute figures are optimistic. Relative comparisons
are sound because both sides share the assumption. Never quote a paper number as
expected live performance.

**Universe exhaustion.** Once you design against a set of symbols, it is
in-sample forever. The store now holds **258 daily series**; 87 were used to
design the current sizing signal and 171 were backfilled specifically to test it.
Track which is which, and backfill more (`npm run backfill-bars`) rather than
re-cutting what you have.

---

## Tooling

```bash
# backtest — replays the REAL engine point-in-time over the bar store
SYMS=AAPL,MSFT STEP=8 npm run backtest --workspace=backend
ZONES=1        # emit NO-TRADE bars too, to score zone placement on a big sample
DUMP=/tmp/x.jsonl   # raw trades for analysis the summaries do not cover
SAVE_BASELINE=1     # record a baseline keyed to this exact universe+period
NO_LEARNING=1       # A/B the walk-forward factor feedback

npm run quant-report    --workspace=backend   # graded win rate, factor accuracy, setup cross-tab
npm run rebuild-stats   --workspace=backend   # recompute stats from raw rows, deduplicated (dry-run default)
npm run evaluate-quant  --workspace=backend   # grade stored predictions
npm run factor-audit    --workspace=backend   # audit REGISTERED factors
npm run indicator-lab   --workspace=backend   # search candidates that actually forecast
npm run macro-audit     --workspace=backend   # does outcome depend on macro state at entry
npm run backfill-bars   --workspace=backend -- --symbols=A,B --years=40
npm run audit-bars      --workspace=backend   # check the local mirror against Yahoo
```

Baselines are keyed to the exact universe and period and **only compared on an
exact match** — an unmatched run says so rather than inventing a comparison.
Comparing across universes reports a regression whenever the universe changes,
which is worse than reporting nothing.

---

## What is settled (do not re-litigate)

**Established**

- Base engine earns **~+0.10R per trade**, positive in every decade 1985–2026
  (t≈5). This is the load-bearing result.
- **LONG carries the edge** (+0.206R, t≈5.57). SHORT is +0.068R at t≈1.90 — not
  distinguishable from zero, but *not negative*. Deliberately **not gated**:
  cutting half the trades for an unproven gain is not justified by that number.
- **The up-drift base rate is 55.7%** over 20 bars. Any long-leaning rule clears
  that without knowing anything. This is the control every directional claim must
  beat, and most do not.
- **No registered factor has demonstrated directional skill.** `factor-audit`
  measures `edge` — accuracy minus what a coin with that factor's own long/short
  mix would score on the same bars. Across the registered set, every edge sits
  between −0.6pp and +0.4pp, i.e. nothing. Raw accuracy correlates 0.991 with
  long-share and −0.940 with edge.

**Retracted** — see the table above, all four rows. Conviction does **not**
predict (top-vs-bottom t≈1.42 on 5,989 trades) and could not be rescued by
tilting; a regression test asserts `computeConviction` ignores an `accuracyEdge`
input. Never present conviction as a win probability.

`positionSizing.ts` remains in the tree and is still ADVISORY — but it is a
direction proxy, not a quality score, and must not be described as measuring
plan quality until it beats a same-direction control.

**The open question this leaves.** If no factor has edge and the base rate is
55.7% up, then the engine's ~+0.10R may be drift capture rather than skill. That
is the single most important thing to settle, and `edge` is the metric to settle
it with. See "Where to take it".

---

## Where to take it

Ordered by expected value. Each is measurable with the tooling above, so **record
a baseline first, then change one thing.**

1. **Settle whether the engine has skill or only drift.** Re-measure the base
   +0.10R against a same-direction, same-exposure control: a rule that takes the
   same number of longs and shorts on random entries. If the engine does not beat
   it, everything downstream is decoration and the honest move is to say so. This
   is the highest-value question in the repo.

2. **Find one factor with non-zero `edge`.** `indicator-lab` and
   `invent-indicators` exist for exactly this and already run the right protocol
   — a discovery/holdout symbol split crossed with an era split, and a null run
   on shuffled forward returns so you know what the search extracts from noise.
   One indicator with a real edge is worth more than every scoring refinement
   attempted so far.

3. **Screeners are unmeasured.** The backtest replays `CompositeScoreAgent`, not
   `runScreener`. Nothing has ever graded whether `premarket` / `open` /
   `momentum` / `highdemand` surface better candidates than a random liquid name.
   Build a screener strategy adapter for the replay engine and find out. Expect
   this to be the largest single source of unmeasured risk in the product.

4. **Position state and concentration limits for the bot.** Nothing tracks what is open or
   decides quantity, so a bot could stack correlated entries into one thesis
   without noticing. The sizing signal now has a defensible basis; concentration
   limits do not exist yet.

5. **A fill model honest enough to size against.** `PaperExecutor` has no
   slippage, partial fills or queue position. Until that exists, no backtest
   number should be used to size real money.

6. **Conviction, or its replacement.** It drives ranking and display while
   carrying no relationship to outcome. Either find a formulation that separates,
   or stop presenting it as a quality score.

---

## Conventions

- TypeScript throughout; `npm run typecheck --workspace=backend`.
- `npm run test --workspace=backend`. Several integration tests hit live Yahoo and
  fail under rate limiting; one gamma-flip unit test in `quantAudit.test.ts` is a
  known pre-existing failure. Check whether a failure is *yours* before chasing it.
- Comments explain **why**, especially where a non-obvious choice was measured.
  Several comments carry the figures that justified the code; keep them accurate
  or delete them, and never leave one that a later measurement falsified.
- Commit messages record what was measured, including negative results.
- Trading is **PAPER by default**. `LIVE` requires `TRADING_ENABLED=true` on the
  server *and* a stored account opt-in, and is refused rather than silently
  downgraded. The halt latch is sticky and no automated path clears it. Do not
  add a live venue adapter casually — the only executor in the repo is
  `PaperExecutor`, which keeps "can this send a real order?" answerable by grep.
