# Research runbook

How to run an experiment on this repo and get an answer you can trust. Written
for any capable model — Gemini, ChatGPT/Codex, Claude — with shell access to the
checkout. Read `AGENTS.md` first for the standard of proof; this file is the
mechanics.

---

## Kickoff prompt

Paste this to start a session. It is deliberately blunt about the failure mode.

> You are doing quantitative research on Hand of Midas, a trading-intelligence
> engine, at `~/Git/handofmidas`. Read `AGENTS.md` and `docs/RESEARCH_RUNBOOK.md`
> before running anything.
>
> Context you must internalise: five plausible findings have been tested on this
> codebase and **all five were retracted**. Two survived out-of-sample checks
> before dying. The most recent — a position-sizing signal — passed three of four
> statistical tests on 11,676 trades across symbols reserved specifically to test
> it, and was still wrong: it turned out to be a long/short classifier riding a
> 55.7% up-drift base rate. It stopped separating the instant direction was held
> fixed.
>
> So: your job is not to find something that works. It is to run controls strong
> enough that you would notice if it did not. Specifically —
>
> - Measure `edge` (accuracy minus what a coin with the same long/short mix scores
>   on the same bars), never raw directional accuracy. Raw accuracy correlates
>   0.991 with long-share and −0.940 with edge. It is a readout of vote mix.
> - Any directional claim must beat a same-direction, same-exposure control.
> - Any cross-sectional claim must beat a cross-sectionally demeaned control.
> - Report the out-of-sample effect size, not the in-sample one.
> - If a finding fails, say so plainly and delete the code it justified.
>
> Start by running `npm run factor-audit --workspace=backend` and telling me what
> the `edge` column says. Then pick one item from "Where to take it" in
> `AGENTS.md` and work it end to end: baseline, one change, re-measure, report.

---

## The one metric that matters

`edge` = a factor's accuracy **minus what a coin flipping with that factor's own
long/short mix would have scored on the same bars**.

Why: equities rose in **55.7%** of 20-bar windows in this sample. A permanently
bullish signal therefore scores ~56% raw accuracy and a permanently bearish one
~44%, both while knowing nothing. Measured across the registered factor set:

```
correlation(long-share, raw accuracy) = +0.991
correlation(long-share, edge)         = −0.940
```

Raw accuracy is a readout of the vote mix. **Every metric derived from it
inherits that flaw** — that is how the sizing signal passed three tests while
being a direction proxy.

`npm run factor-audit --workspace=backend` prints `acc`, `accAdj` (against
cross-sectionally demeaned forward returns) and `edge` side by side. Use `edge`.

---

## Recipes

### 1. Does a change to the engine help?

```bash
cd ~/Git/handofmidas
U="AAPL,MSFT,NVDA,JPM,XOM,WMT,PFE,CAT,DIS,KO,MU,GE,BA,T,INTC"

# baseline FIRST, keyed to this exact universe and period
SYMS=$U STEP=8 SAVE_BASELINE=1 DUMP=/tmp/before.jsonl \
  npm run backtest --workspace=backend

# ... make exactly one change ...

SYMS=$U STEP=8 DUMP=/tmp/after.jsonl npm run backtest --workspace=backend
```

Baselines only compare on an exact universe+period match; an unmatched run says
so rather than inventing a comparison. Change one thing at a time or you cannot
attribute the result.

### 2. Is a difference real?

Three tests. A finding needs to survive all three, or be reported as unproven.

```python
import json, statistics as st, math, random
from collections import defaultdict

def load(p):
    T=[json.loads(l) for l in open(p) if l.strip()]
    return sorted([t for t in T if t.get('realizedR') is not None
                   and t['outcome']!='AMBIGUOUS'], key=lambda t:t['asOf'])

def maxdd(rows,k='realizedR'):
    peak=cum=worst=0
    for r in rows:
        cum+=r[k]; peak=max(peak,cum); worst=max(worst,peak-cum)
    return worst

A,B = load('/tmp/before.jsonl'), load('/tmp/after.jsonl')
a=[t['realizedR'] for t in A]; b=[t['realizedR'] for t in B]

# 1) two-sample t on expectancy
se=math.sqrt(st.pstdev(a)**2/len(a)+st.pstdev(b)**2/len(b))
print(f"expectancy diff {st.mean(b)-st.mean(a):+.4f}R  t={(st.mean(b)-st.mean(a))/se:.2f}")

# 2) paired sign test ACROSS YEARS (pair by period; the two arms trade
#    different plans, so pairing by trade is not available)
ya,yb=defaultdict(list),defaultdict(list)
for t in A: ya[t['asOf'][:4]].append(t['realizedR'])
for t in B: yb[t['asOf'][:4]].append(t['realizedR'])
ys=sorted(set(ya)&set(yb))
w=sum(1 for y in ys if st.mean(yb[y])>st.mean(ya[y]))
z=(w-len(ys)/2)/math.sqrt(len(ys)/4)
print(f"sign test {w}/{len(ys)} years  p={math.erfc(abs(z)/math.sqrt(2)):.4f}")

# 3) block bootstrap on return-per-drawdown (blocks preserve path order —
#    max drawdown is one extreme statistic and easy to get lucky on)
def boot(T, iters=3000, block=50):
    rng=random.Random(7); out=[]
    for _ in range(iters):
        seq=[]
        for _ in range(max(1,len(T)//block)):
            i=rng.randrange(0,max(1,len(T)-block)); seq.extend(T[i:i+block])
        d=maxdd(seq)
        if d>0: out.append(sum(r['realizedR'] for r in seq)/d)
    return out
da,db=boot(A),boot(B)
diff=sorted(y-x for x,y in zip(da,db))
print(f"R/DD 95% CI [{diff[len(diff)//40]:+.2f}, {diff[-len(diff)//40]:+.2f}]")
```

Then the free fourth check: **does the effect scale monotonically as you apply it
harder?** Noise does not.

### 3. Does a signal survive its own control?

This is the step that has killed every finding here. Whatever you have found,
identify what it could be a proxy for, then hold that fixed.

```python
# Example: a "quality" score must still separate WITHIN one direction,
# or it is just a direction classifier.
def sep(rows, label):
    rows=sorted(rows,key=lambda t:t['score']); q=len(rows)//4
    lo=[r['realizedR'] for r in rows[:q]]; hi=[r['realizedR'] for r in rows[3*q:]]
    se=math.sqrt(st.pstdev(lo)**2/len(lo)+st.pstdev(hi)**2/len(hi))
    print(f"{label}: {st.mean(hi)-st.mean(lo):+.3f}R  t={(st.mean(hi)-st.mean(lo))/se:.2f}")

sep(T, 'all')
sep([t for t in T if t['bias']=='LONG'],  'LONG only')   # must still separate
sep([t for t in T if t['bias']=='SHORT'], 'SHORT only')  # must still separate
```

Also print the composition of each bucket. If the top bucket is 97% long and the
bottom is 3% long, the score is direction, whatever you named it.

### 4. Searching for a new indicator

```bash
npm run indicator-lab      --workspace=backend   # rank the candidate pool
npm run invent-indicators  --workspace=backend   # evolve new ones
POP=60 GENS=12 SEED=7 npm run invent-indicators --workspace=backend
```

Both already run the right protocol: symbols split by hash into discovery (~60%)
and holdout (~40%), time split at a fixed date, candidates ranked on
discovery×early only, then reported across all four cells. `invent-indicators`
additionally runs a **null search** on forward returns shuffled within each date
— survivors must beat what the same search extracts from noise. Do not remove
that step; without it a generative search is a machine for producing confident
nonsense.

### 5. Adding or changing a factor

Factors live in `backend/src/services/factors/`, registered in
`factorRegistry.ts`. A factor returns a `bias`, an optional `weight`, optional
`buyTarget`/`sellTarget`, and optional `levels` (multiple price levels — this is
what relieved zone-candidate starvation).

Set `directional: false` if the factor provides levels or regime only and should
not cast a vote. `ATR Dynamic Volatility` and `Swing Structure` do this — they
appear in `factor-audit` with `·` and no accuracy, which is correct, not a bug.

After changing one: `npm run factor-audit` for its edge, then recipe 1 and 2 for
its effect on the engine.

---

## Reporting

State, in this order: **what you changed**, **the control you used**, **the
out-of-sample effect size**, **which tests passed and which did not**, and **what
you removed if it failed**. A result without its control is not a result.

Commit messages here record negative results deliberately. Write the retraction
down so the next agent does not re-run the same dead end.
