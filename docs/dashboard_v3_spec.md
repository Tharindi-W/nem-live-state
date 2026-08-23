# AEMO Live Dashboard — v3 Build Spec

Target: one file, `aemo_dashboard_v3.html`. Zero dependencies, zero build step, hand-rolled SVG,
opens from `file://` (degraded) and from `http://` (full). ~2,300 lines.

The v2 explorer answers *"what do these feeds return?"*. That question is finished. v3 answers
*"is the official forecast any good, and when does it break?"* — which is the falsifiable benchmark
the world-models report argues for, and the only thing in this repo that no public site already shows.

---

## 0. Three findings from the existing archive that drive this design

I ran the joins against `data/` before writing this. Three results are load-bearing.

### 0.1 The forecast-vs-actual join works, and it already says something

Joining `nem_predispatch_forecast.csv` (24,055 rows, 70 vintages) to `nem_dispatch.csv`
(72 intervals) produced **2,305 matched forecast/actual pairs**. Scored against a persistence
baseline (the actual price at the forecast's cut-off time), skill = `1 − MAE_aemo / MAE_persist`:

| horizon | NSW1 | QLD1 | SA1 | TAS1 | VIC1 |
|---|---|---|---|---|---|
| 0–30 m | **−1.84** | −0.84 | −1.35 | −0.64 | −0.84 |
| 30–60 m | −0.34 | +0.16 | −0.26 | +0.12 | +0.01 |
| 1–2 h | +0.35 | +0.63 | +0.40 | +0.24 | +0.23 |
| 2–4 h | +0.45 | **+0.81** | +0.69 | +0.49 | +0.52 |
| 4–8 h | +0.68 | +0.88 | +0.30 | +0.53 | +0.56 |
| 12–24 h | −0.01 | −0.41 | −1.19 | +0.13 | +0.69 |
| 24 h+ | −0.77 | +0.08 | +0.21 | −0.60 | −0.54 |

Two publishable facts fall straight out: **skill is negative inside the first hour** (persistence
beats the official forecast — partly a real effect, partly the trading-interval-averaging artefact
in §2.3, and the UI must let a user tell those apart), and **bias at 24 h+ is +$71 to +$81 in every
region simultaneously** — a systematic long-horizon over-forecast. A chart that shows those two
things is the whole product.

The calibration path (§2.3 `calibrate()`) also runs today, fit on the oldest 70% of pairs and
evaluated out-of-sample on the remaining 692:

```
nominal   0.1   0.2   0.3   0.4   0.5   0.6   0.7   0.8   0.9
achieved  0.07  0.18  0.35  0.42  0.44  0.47  0.60  0.68  0.76
```

Monotone and **below the diagonal almost everywhere** — the empirical intervals are too narrow, and
the PIT histogram comes out U-shaped. Overconfidence is exactly what the reliability diagram exists
to expose, and it is visible from three days of data.

### 0.2 The archive is 8.7% dense, and collect.js already holds the fix

`nem_dispatch.csv` covers a 68.8 h span but contains only **72 of a possible 826** 5-minute
intervals — the scheduled task has not run continuously. That caps the join at a 9.6% match rate.

But `collectPredispatch()` already receives the fix and throws it away. The `5MIN` feed returns
`n_actual: 1440` rows per call = **5 regions × 288 intervals = a full trailing day of 5-minute
actuals**. The collector filters them out (`rows.filter(r => r.PERIODTYPE === "ACTUAL")`) and only
uses them to derive `issue`.

97.8% of archived forecast rows have a target inside the dispatch span. **Archiving those ACTUAL
rows lifts the join match rate from 9.6% to ~98%** and makes every gap shorter than 24 h self-heal
on the next run. This is a ~25-line change to `collect.js` (§6.5) and it is a prerequisite for the
centrepiece view. Do it first.

### 0.3 The forecast revises as a staircase, not a curve

30-minute pre-dispatch is republished at 5-minute cadence, so consecutive vintages repeat. Measured:
31–58 vintages per target resolving to only 4–11 distinct values — **~5 repeats per revision step**.

One NSW1 target, 66 vintages, actual $105.19:

```
h=1825m  fc=206.60   h=1795m  fc=171.44   h=410m  fc=125.22   h=15m  fc=113.40
```

The fan chart must render **step lines**, not smoothed polylines. Smoothing would invent revisions
that never happened, and the flat plateaus are the honest signal: for ~25 minutes at a time, AEMO's
view of that interval did not move at all.

---

## 1. Information architecture

Seven views. Ordered by decision latency — how fast a returning user needs the answer.

| # | View | Hash | The one question it answers |
|---|---|---|---|
| 1 | **Now** | `#/now` | Is the market doing anything abnormal this instant? |
| 2 | **Region** | `#/region/SA1` | What is setting *this* region's price? |
| 3 | **Network** | `#/network` | Why are regional prices separating? |
| 4 | **Forecast skill** | `#/skill/SA1?h=2-4h` | How good is AEMO's forecast, and where does it break? |
| 5 | **Weather** | `#/weather` | What is coming that the market has not priced yet? |
| 6 | **WEM** | `#/wem` | Does any of this transfer to a differently-designed market? |
| 7 | **Feeds & archive** | `#/feeds` | What exactly am I looking at, and can I trust it? |

**Why this order.** Inverted pyramid. *Now* must be readable in two seconds without scrolling —
it is what a returning user opens 90% of the time. *Region* and *Network* are the two explanations
for anything odd on *Now*, in the order a trader would reach for them (own region first, then the
network state that couples regions). *Skill* is fourth, not first, because a scorecard is worthless
to a reader who does not yet trust the ground truth; by view 4 they have seen the actuals three
times. *Weather* is fifth because it is exogenous — it explains, it does not report. *WEM* is the
transfer test, interesting but never urgent. *Feeds* is reference material and belongs last.

**But the scorecard is the thesis**, so *Now* carries a one-line skill strip that deep-links in:

> `AEMO forecast skill vs persistence · 2–4 h: +0.45 · 24 h: −0.77 ↗ open scorecard`

That resolves the tension without demoting the two-second view.

### 1.1 Now

- **Status bar.** Interval timestamp; age since publish (turns amber >6 min, red >12 min);
  live/stale/offline dot. If any region has `PRICE_STATUS !== "FIRM"` or `APCFLAG` or
  `MARKETSUSPENDEDFLAG` set — a full-width red banner naming the region and the flag. These flags are
  the regime markers; they are the reason the archive keeps them and they must never be buried.
- **Five region cards.** Price (large, symlog-ramped background), Δ vs previous interval,
  operational demand, semi-scheduled share as a % bar, net interchange as a signed arrow.
- **Price strip**, last 3 h, five series, symlog y, zero rule, spike dots above $300.
- **Spread callout.** `max(price) − min(price)` across regions. Over $50 → "regions separating",
  linking to Network.
- **Fuel split**, stacked bars, scheduled vs semi-scheduled, with the behind-the-meter caveat (§1.8).
- **Skill strip** (above).

### 1.2 Region

Region picker persists to URL + localStorage.

- Price trajectory: archived actuals → current pre-dispatch forecast, symlog, step-rendered forecast.
- Residual demand (§5.4) alongside operational demand.
- **Price duration curve** — archive prices sorted descending, rank on x, symlog price on y. This is
  the chart that makes the 0.1%/29% concentration visible instead of averaging it away.
- **Concentration KPI**: `sum(top ceil(0.001·n) prices) / sum(all prices)`, rendered as
  *"0.1% of intervals produced 29% of the average price"*.
- **Negative-price clock**: 7 × 24 heatmap, cell = share of intervals below $0 by weekday × hour.
  For SA1 this draws the daytime solar trough directly.
- **Spike register**: every archived interval ≥ $300, descending, click-to-locate — clicking scrolls
  the trajectory chart to that timestamp and pins a marker. This is the "make rare intervals
  findable" requirement, implemented as navigation rather than as a chart.
- This region's interconnector position.

### 1.3 Network

- **Schematic, not a map.** Five nodes, six edges. Node fill = price via the symlog ramp; edge width
  = `|MWFLOW|`; edge colour = utilisation; arrowhead = direction. Hand-positioned coordinates —
  the NEM is a 5-node graph and a geographic basemap would need external tiles, which breaks both
  zero-dependency and `file://`.
- **Utilisation bars**, per link: flow drawn against `EXPORTLIMIT` (positive) and `IMPORTLIMIT`
  (negative) as a bipolar gauge; a "binding" tick at 95%.
  `util = flow >= 0 ? flow/EXPORTLIMIT : flow/IMPORTLIMIT` (both limits are signed in the feed —
  `IMPORTLIMIT` is negative, so this ratio is positive in both directions).
- **Headroom timeline** over the archive window, one lane per link.
- **Separation vs utilisation scatter**: x = utilisation on the link, y = `|price_A − price_B|` for
  its two regions (symlog). The causal story of regional price separation in one chart.

> **Dedupe warning for the reader of `nem_interconnectors.csv`:** each link is archived once per
> adjacent region, so all 6 links appear as 12 rows per interval (`NSW1-QLD1` under both `NSW1` and
> `QLD1`). Key on `INTERCONNECTORID`, not on `(REGIONID, INTERCONNECTORID)`.

### 1.4 Forecast skill — see §2.

### 1.5 Weather — see §5.

### 1.6 WEM

Keep v2's content; three changes. Symlog price axis. Read `data/wem_prices.csv` for history rather
than re-parsing a 3.8 MB CSV in the browser on every visit. **Delete the in-browser 19 MB facility
SCADA fetch** — `collectSCADA()` already `Range`-fetches it server-side into
`data/wem_facility_scada.csv`; the browser reads that, and shows a "run `node collect.js --scada`"
hint when the file is absent.

### 1.7 Feeds & archive

v2's `aboutBlock` glossaries for every feed (this content is good — keep it verbatim), plus an
**archive health panel** that must show, honestly:

- rows and time span per file;
- **coverage density** — intervals present / intervals possible over the span. Today that is 8.7%,
  and the dashboard should say so rather than quietly scoring a forecast against a sparse archive;
- gap timeline: a one-pixel-per-interval strip, present/absent;
- last collector run, from `_state.json` mtime and the tail of `collect.log`;
- truth-quality mix from the join (`full` / `partial` / `instant`, §2.3).

### 1.8 The one labelling rule that applies everywhere

`TOTALDEMAND` is **operational demand**. It is net of roughly 26 GW of behind-the-meter rooftop PV
that no feed here observes. Every axis, KPI and tooltip says *"operational demand"*, never
*"demand"*; every demand chart carries the footnote *"excludes behind-the-meter rooftop PV
(~26 GW installed, not observable in these feeds)"*. Do **not** print an estimated rooftop figure —
none of these feeds measures it, and a fabricated number is worse than an honest gap.

---

## 2. The forecast-skill view

The centrepiece. Everything else on this dashboard exists on other websites.

### 2.1 Controls

Region (one or All) · metric (MAE / bias / RMSE / p90 AE) · **truth quality** (full 30-min average
only ▸ allow partial ▸ allow instantaneous) · price regime (all / normal < $300 / spike ≥ $300 /
negative < $0) · date window. All serialise to the hash.

The truth-quality control is not a nicety. It is how a reader distinguishes a real forecast failure
from an artefact of a sparse archive.

### 2.2 The eight charts

**(1) Error vs horizon.** x = horizon bucket, y = MAE $/MWh (log). One solid line per region; one
dashed grey line for the persistence baseline. Shaded p50→p90 absolute-error band on the selected
region. Bucket labels carry `n`; any bucket with `n < 30` renders at 35% opacity with the count
called out. *Answers: how far ahead is this forecast worth anything?*

**(2) Skill vs horizon.** x = horizon, y = `1 − MAE_fc / MAE_persist`, hard zero rule, region below
zero tinted coral and labelled **"worse than assuming no change"**. Clamp the axis to [−1, 1] and
render out-of-range points as edge chevrons with the true value in the tooltip — otherwise the
−1.84 at 0–30 m squashes everything else flat. *The single most legible chart in the dashboard.*

**(3) Vintage fan.** x = target time, y = price (symlog). One **step** polyline per vintage,
`stroke-opacity` ramped by horizon (pale = issued long ago, saturated = fresh), plus a heavy
`--ink` line for actuals. Cap at ~60 rendered vintages by striding. Shows successive revisions
converging on truth — and shows the staircase plateaus from §0.3.

**(4) Revision walk.** One target interval. x = **time-to-target, axis reversed** so the target sits
at the right edge; y = forecast value. Step line, with a horizontal `--ink` rule at the eventual
actual and the gap shaded. Target chosen by clicking the fan, or from the Region spike register —
which is what makes "why did AEMO miss that spike?" a two-click question.

**(5) Reliability / coverage.** Pre-dispatch is a point forecast, so manufacture the distribution
honestly: fit empirical error quantiles per (region, horizon bucket) on the first 70% of history,
apply them to the held-out 30%, then plot nominal coverage (10…90%) on x against achieved coverage
on y with the 45° reference. Below the diagonal = overconfident. **Label it "empirical, out-of-sample
on the last 30% of the archive"** — this is a derived interval, not something AEMO publishes.

**(6) PIT histogram.** Where truth fell inside that predictive distribution, 10 bins. U-shaped =
intervals too narrow; humped = too wide; flat = calibrated.

**(7) Spike contingency by horizon.** 2 × 2 on (`forecast ≥ thr`) × (`actual ≥ thr`) per bucket →
POD `a/(a+c)`, FAR `b/(a+b)`, CSI `a/(a+b+c)`. Plus a blunt bar: spikes forecast at all vs missed
entirely.

**The threshold control must be adaptive, and this panel needs a real empty state.** Running the
contingency over the current archive: at **$300 there are zero events** in three days
(`hit=0 miss=0 falseAlarm=4`, every rate undefined) while at **$100 it is well populated**
(`hit=295 falseAlarm=170 miss=14` → POD 0.95, FAR 0.37, CSI 0.62). That is not a bug — quiet weeks
are the normal case, which is the whole reason extremes are hard. So:

- default the threshold to **auto**: the highest preset from `[$5,000, $1,000, $300, $100]` that
  yields ≥ 10 events in the loaded window, falling back to $100;
- when a manually chosen threshold yields no events, render *"No intervals above $300 in the loaded
  archive window (69 h). This is normal — spikes are ~0.1% of intervals. Widen the window or lower
  the threshold."* — never a grid of `n/a`;
- show `a/b/c/d` counts next to every rate, always. A POD of 1.00 from two events is not a result.

**(8) Bias heatmap.** x = hour of day (0–23), y = horizon bucket, cell = mean **signed** error on a
diverging ramp centred at zero. This is where the +$77 at 24 h+ and the −$19 at 0–30 m become a
shape rather than two numbers.

### 2.3 The join — verified code

The subtlety that makes this correct: a pre-dispatch target `T` is a **30-minute trading interval
ending at T**, whose true RRP is the mean of six 5-minute dispatch prices. Comparing it to the
single instantaneous price at `T` is a different quantity and injects bias. So truth is computed
three ways, ranked, and the mode is carried on every pair so the UI can filter on it.

```js
const MIN = 60000;

/* Archive timestamps are naive NEM time. Parse them consistently — never with the
   browser's local zone, or every horizon shifts by the UTC offset. */
const T = s => Date.parse(s + (/[Z+]|[+-]\d\d:\d\d$/.test(s) ? "" : "Z"));

/* actualIdx: Map "REGIONID|epochMs" -> price, built from nem_dispatch.csv
   (and, after the §6.5 collector change, from nem_actual_5min.csv). */
function buildActualIndex(dispatchRows){
  const m = new Map();
  for (const r of dispatchRows) m.set(r.REGIONID + "|" + T(r.SETTLEMENTDATE), +r.PRICE);
  return m;
}

/* Truth for the 30-min trading interval ENDING at t. */
function truthAt(actualIdx, region, t, minParts = 4){
  let sum = 0, n = 0;
  for (let k = 5; k >= 0; k--){                       // t-25 .. t, six 5-min intervals
    const v = actualIdx.get(region + "|" + (t - k * 5 * MIN));
    if (v != null && !isNaN(v)) { sum += v; n++; }
  }
  if (n === 6)         return { price: sum / n, parts: 6, mode: "full"    };
  if (n >= minParts)   return { price: sum / n, parts: n, mode: "partial" };
  const inst = actualIdx.get(region + "|" + t);
  if (inst != null && !isNaN(inst)) return { price: inst, parts: 1, mode: "instant" };
  return null;                                        // unresolvable — drop the pair
}

/* Join forecast vintages to truth. forecastRows = nem_predispatch_forecast.csv objects.
   Persistence baseline = the actual price at the vintage's cut-off (issue) time —
   the strongest trivial forecast, and what AEMO must beat to be worth publishing. */
function pairForecasts(forecastRows, actualIdx, opts = {}){
  const allow = opts.truthModes || ["full", "partial", "instant"];
  const out = [];
  for (const r of forecastRows){
    const region = r.REGIONID, t = T(r.SETTLEMENTDATE), iss = T(r.issue);
    const tr = truthAt(actualIdx, region, t);
    if (!tr || !allow.includes(tr.mode)) continue;
    const persist = actualIdx.get(region + "|" + iss);
    out.push({
      region, issue: iss, target: t,
      horizonMin: (t - iss) / MIN,
      fcast: +r.RRP, actual: tr.price,
      mode: tr.mode, parts: tr.parts,
      err: +r.RRP - tr.price,
      persist: persist == null ? null : persist,
      persistErr: persist == null ? null : persist - tr.price,
      fcDemand: +r.TOTALDEMAND, fcSemi: +r.SEMISCHEDULEDGENERATION
    });
  }
  return out;
}
```

Horizon bucketing and aggregation:

```js
const BUCKETS = [[0,30,"0-30m"],[30,60,"30-60m"],[60,120,"1-2h"],[120,240,"2-4h"],
                 [240,480,"4-8h"],[480,720,"8-12h"],[720,1440,"12-24h"],[1440,Infinity,"24h+"]];
const bucketOf = h => (BUCKETS.find(b => h >= b[0] && h < b[1]) || BUCKETS[BUCKETS.length-1])[2];

function quantile(sorted, p){
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

function agg(rows){
  const n = rows.length; if (!n) return null;
  const ae  = rows.map(r => Math.abs(r.err)).sort((a,b) => a-b);
  const pae = rows.filter(r => r.persistErr != null)
                  .map(r => Math.abs(r.persistErr)).sort((a,b) => a-b);
  const mae  = ae.reduce((a,b) => a+b, 0) / n;
  const pmae = pae.length ? pae.reduce((a,b) => a+b, 0) / pae.length : null;
  return {
    n, mae,
    bias: rows.reduce((a,r) => a + r.err, 0) / n,
    rmse: Math.sqrt(rows.reduce((a,r) => a + r.err*r.err, 0) / n),
    p50: quantile(ae, 0.5), p90: quantile(ae, 0.9),
    persistMae: pmae,
    skill: pmae ? 1 - mae / pmae : null,       // >0 beats persistence, <0 is worse than nothing
    lowN: n < 30                                // UI: fade and annotate
  };
}
```

Coverage / PIT, out-of-sample:

```js
/* Empirical predictive intervals from past errors. Fit on the oldest `frac` of pairs
   (by issue time), evaluate on the rest, so the calibration claim is honest. */
function calibrate(pairs, frac = 0.7, levels = [.1,.2,.3,.4,.5,.6,.7,.8,.9]){
  const s = pairs.slice().sort((a,b) => a.issue - b.issue);
  const cut = Math.floor(s.length * frac);
  const fitErrs = {};                                        // bucket -> sorted errors
  for (const p of s.slice(0, cut))
    (fitErrs[bucketOf(p.horizonMin)] ||= []).push(p.err);
  for (const k in fitErrs) fitErrs[k].sort((a,b) => a-b);

  const cov = levels.map(L => {
    const lo = (1-L)/2, hi = 1-lo;
    let inside = 0, total = 0;
    for (const p of s.slice(cut)){
      const e = fitErrs[bucketOf(p.horizonMin)]; if (!e || e.length < 30) continue;
      const band = [p.fcast - quantile(e, hi), p.fcast - quantile(e, lo)];
      total++; if (p.actual >= band[0] && p.actual <= band[1]) inside++;
    }
    return { nominal: L, achieved: total ? inside/total : null, n: total };
  });

  const pit = new Array(10).fill(0); let pitN = 0;
  for (const p of s.slice(cut)){
    const e = fitErrs[bucketOf(p.horizonMin)]; if (!e || e.length < 30) continue;
    let below = 0; for (const x of e) if (x <= p.fcast - p.actual) below++;
    pit[Math.min(9, Math.floor(below / e.length * 10))]++; pitN++;
  }
  return { cov, pit, pitN, fitN: cut, evalN: s.length - cut };
}

function contingency(pairs, thr = 300){
  let a=0,b=0,c=0,d=0;
  for (const p of pairs){
    const f = p.fcast >= thr, o = p.actual >= thr;
    if (f && o) a++; else if (f && !o) b++; else if (!f && o) c++; else d++;
  }
  return { a,b,c,d,
    pod: (a+c) ? a/(a+c) : null,      // probability of detection
    far: (a+b) ? b/(a+b) : null,      // false alarm ratio
    csi: (a+b+c) ? a/(a+b+c) : null };
}
```

### 2.4 Designed-in, not built: the model leaderboard

The join above does not care where a forecast came from. Define the schema now so a model can plug
in later without touching the dashboard:

```
data/forecast_ledger.csv
model,issue,SETTLEMENTDATE,REGIONID,RRP,RRP_p10,RRP_p90
```

`pairForecasts()` runs unchanged over it; every skill chart gains one line per `model`, with AEMO
pre-dispatch and persistence as the two reference lines. That is the "continuously running
leaderboard where nobody can rewrite history" milestone from the report — reachable as a CSV append,
with no dashboard changes. **Do not build the model itself (§9).**

---

## 3. Chart primitive upgrades

### 3.1 The responsive fix: make the viewBox equal the measured pixel width

v2's bug is `W = 520` with `font-size="12"`, stretched to fit by `svg{width:100%}`. On a 1040 px
container every font renders at 24 effective px; on a phone at 8. `preserveAspectRatio` cannot fix
this — the only clean fix is to stop scaling: **measure the container, draw at that width, redraw on
resize.** Then one viewBox unit is one CSS pixel and `font-size="12"` means 12 px everywhere.

```js
/* One observer for every chart on the page. rAF-batched so a resize storm
   coalesces into a single redraw pass and never re-enters the observer. */
const _pending = new Set(); let _raf = 0;
const _ro = new ResizeObserver(entries => {
  for (const e of entries) _pending.add(e.target);
  if (_raf) return;
  _raf = requestAnimationFrame(() => {
    _raf = 0;
    for (const el of _pending) { const f = el.__redraw; if (f) f(); }
    _pending.clear();
  });
});

/* draw(el, W) must render an <svg viewBox="0 0 W H"> with style width:100%;height:auto. */
function responsive(el, draw, model){
  el.__model = model;
  el.__redraw = () => {
    const W = Math.max(260, Math.round(el.clientWidth || el.parentNode.clientWidth || 520));
    if (W === el.__W && el.__sig === el.__lastSig) return;      // nothing changed
    el.__W = W; el.__lastSig = el.__sig;
    draw(el, W, el.__model);
  };
  if (!el.__observed) { _ro.observe(el); el.__observed = true; }
  el.__redraw();
}
function updateChart(el, model){          // re-model without re-observing
  const sig = JSON.stringify(model);
  if (el.__sig === sig) return;           // identical model — skip the serialise+parse entirely
  el.__sig = sig; el.__model = model; el.__W = -1; el.__redraw();
}
```

Height stays a function of width and content — `H = clamp(160, W * 0.42, 340)` for time series,
`H = pad*2 + rows*rowH` for bar charts (already correct in v2).

### 3.2 Symlog scale — tested, invertible, monotonic

A linear axis over −$1,000 to $23,200 renders every ordinary price as the same pixel. A plain log
axis cannot represent the 31% of SA1 intervals that are negative. Symlog is the only option.

This is the matplotlib `SymLogNorm` formulation rather than d3's `symlog`, because the explicit
`linthresh` / `linscale` pair makes tick placement trivial and lets the reader control exactly how
much of the axis the ordinary-price band gets.

```js
/* Linear inside ±linthresh; log10 outside. The linear band occupies `linscale`
   decades of visual space, so linscale is the "how much room do normal prices get" dial. */
function symlog({ linthresh = 100, linscale = 1 } = {}){
  const L = linthresh, S = linscale;
  const fwd = v => {
    if (v == null || isNaN(v)) return NaN;
    const s = v < 0 ? -1 : 1, a = Math.abs(v);
    return a <= L ? s * (a / L) * S : s * (S + Math.log10(a / L));
  };
  const inv = u => {
    const s = u < 0 ? -1 : 1, a = Math.abs(u);
    return a <= S ? s * (a / S) * L : s * L * Math.pow(10, a - S);
  };
  return { fwd, inv, linthresh: L, linscale: S, kind: "symlog" };
}
function linear(){
  return { fwd: v => v, inv: u => u, kind: "linear" };
}

/* 1–3–10 ticks, mirrored through zero, always including 0 and the domain ends. */
function symlogTicks(sc, lo, hi){
  const out = new Set([0]);
  const push = v => { if (v >= lo && v <= hi) out.add(v); };
  push(sc.linthresh / 2); push(-sc.linthresh / 2);
  const reach = Math.max(Math.abs(lo), Math.abs(hi));
  for (let e = 0; e < 7; e++){
    const d = sc.linthresh * Math.pow(10, e);
    for (const m of [1, 3]) { push(m * d); push(-m * d); }
    if (d > reach * 3) break;
  }
  push(lo); push(hi);
  return [...out].sort((a, b) => a - b);
}
```

Verified against `linthresh=100, linscale=1`: `fwd(0) === 0` exactly; `fwd(-x) === -fwd(x)`;
`inv(fwd(v)) === v` to 1e-6 across `[-1000, 23200]`; strictly monotonic across the same range.
Over the full market domain the axis allocates 37.3% below zero, 12.6% to the ordinary $50–150 band,
and 35.2% to the ≥$300 spike zone — a spike is visible without erasing normal trading.

**Domain policy.** Default to the padded data extent, not the market range — most days never leave
±$200 and a permanently cap-to-floor axis wastes 70% of the plot. Offer a **"full market range"**
toggle (−$1,000 … $23,200) that pins the axis, so a reader can see how small today actually is.
`linthresh` defaults to 100 and is exposed in the chart footer as `$50 / $100 / $300`.

### 3.3 Axis rendering, zero line, and theme-aware colour

Two v2 bugs fixed here: no zero reference on line charts, and hardcoded hex (`#eef3f9`, `#4a5f7e`)
that cannot follow a theme. **SVG inherits CSS custom properties**, so `stroke="var(--grid)"` works
with zero JS.

```js
function yAxis(sc, lo, hi, W, plot, fmtD = 0){
  const { l, t, ph } = plot;
  const f0 = sc.fwd(lo), f1 = sc.fwd(hi);
  const Y = v => t + ph - (sc.fwd(v) - f0) / (f1 - f0) * ph;
  const ticks = sc.kind === "symlog" ? symlogTicks(sc, lo, hi) : niceTicks(lo, hi, 5);
  let s = "";
  for (const v of ticks){
    const y = Y(v), zero = v === 0;
    s += `<line x1="${l}" y1="${y.toFixed(1)}" x2="${W - plot.r}" y2="${y.toFixed(1)}"
          stroke="var(${zero ? "--zero" : "--grid"})" stroke-width="${zero ? 1.5 : 1}"/>`;
    s += `<text x="${l - 6}" y="${(y + 4).toFixed(1)}" font-size="11" text-anchor="end"
          fill="var(--axis)"${zero ? ' font-weight="700"' : ""}>${fmt(v, fmtD)}</text>`;
  }
  return { svg: s, Y };
}
```

**Zero is always in the domain for any price or flow chart** — `lo = Math.min(0, dataLo)`,
`hi = Math.max(0, dataHi)`. Without that, a window of all-negative SA prices renders as a line
floating in space with no indication it is below zero, which is the single most misleading thing
this dashboard could do.

Also extend v2's `esc()`, which misses quotes and breaks the moment a label is interpolated into an
SVG attribute:

```js
const esc = s => String(s).replace(/[&<>"']/g,
  c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
```

### 3.4 Spike-aware price chart

A 5-minute spike is one sample. Drawn as a plain polyline on a 3-hour axis it is a 1-px sliver that
antialiases away — the exact failure mode that averages the 0.1% of intervals out of existence.

```js
function priceChart(el, W, { series, scale, lo, hi, xLabels, spikeThr = 300,
                             negShade = true, nowX = null }){
  const H = Math.round(Math.min(340, Math.max(180, W * 0.42)));
  const plot = { l: 54, r: 14, t: 14, b: 30 };
  plot.pw = W - plot.l - plot.r; plot.ph = H - plot.t - plot.b;
  const ax = yAxis(scale, lo, hi, W, plot, 0), Y = ax.Y;
  const X = i => plot.l + (series[0].points.length < 2 ? 0.5
                        : i / (series[0].points.length - 1)) * plot.pw;

  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" style="width:100%;height:auto">`;

  // 1. Shade the sub-zero band so negative prices read as a *region*, not a dip.
  if (negShade && lo < 0)
    s += `<rect x="${plot.l}" y="${Y(0)}" width="${plot.pw}"
           height="${(Y(lo) - Y(0)).toFixed(1)}" fill="var(--neg-band)"/>`;
  // 2. Shade the spike band above the threshold.
  if (hi > spikeThr)
    s += `<rect x="${plot.l}" y="${Y(hi)}" width="${plot.pw}"
           height="${(Y(spikeThr) - Y(hi)).toFixed(1)}" fill="var(--spike-band)"/>`;
  s += ax.svg;
  if (nowX != null)
    s += `<line x1="${X(nowX)}" y1="${plot.t}" x2="${X(nowX)}" y2="${plot.t + plot.ph}"
           stroke="var(--gold)" stroke-dasharray="4 3"/>`;

  for (const se of series){
    // 3. Step rendering for forecast series — never invent revisions that did not happen.
    let d = "", prev = null;
    se.points.forEach((p, i) => {
      if (p.y == null || isNaN(p.y)) { prev = null; return; }
      const x = X(i), y = Y(p.y);
      if (prev === null) d += `M${x.toFixed(1)} ${y.toFixed(1)}`;
      else if (se.step)  d += `H${x.toFixed(1)}V${y.toFixed(1)}`;
      else               d += `L${x.toFixed(1)} ${y.toFixed(1)}`;
      prev = p;
    });
    s += `<path d="${d}" fill="none" stroke="${se.color}" stroke-width="${se.w || 2}"
           stroke-linejoin="round"${se.dash ? ` stroke-dasharray="${se.dash}"` : ""}
           ${se.opacity ? ` stroke-opacity="${se.opacity}"` : ""}/>`;

    // 4. Every point above the threshold gets an explicit dot + hover value.
    //    This is what makes a single 5-min extreme survive at any zoom level.
    if (se.markSpikes !== false)
      se.points.forEach((p, i) => {
        if (p.y == null || p.y < spikeThr) return;
        s += `<circle cx="${X(i)}" cy="${Y(p.y)}" r="3.5" fill="var(--coral)"
               stroke="var(--paper)" stroke-width="1.2">
               <title>${esc(p.label || "")} $${fmt(p.y, 2)}/MWh</title></circle>`;
      });
  }
  s += xTicks(xLabels, X, H, plot) + `</svg>`;
  el.innerHTML = s;
}
```

### 3.5 New primitives to add

| Primitive | Used by | ~lines |
|---|---|---|
| `stepChart` (fan, revision walk) | Skill 3, 4 | 55 |
| `scatter` (log/symlog either axis) | Network, Weather | 60 |
| `heatmap` (2-D categorical, diverging or sequential ramp) | Region clock, Skill 8 | 55 |
| `durationCurve` (sorted rank vs symlog value) | Region | 35 |
| `bipolarGauge` (flow against signed export/import limits) | Network | 40 |
| `schematic` (5 fixed nodes, 6 edges) | Network | 70 |
| `fanBand` (p10–p90 ribbon + median) | Weather, Skill 1 | 40 |
| `reliability` (45° reference + points) | Skill 5 | 35 |

Keep `barChart` and `stackedBars` — port them to `(el, W, model)` and swap hardcoded hex for
`var(--…)`.

---

## 4. Rendering architecture

### 4.1 The problem

v2 does `$("#panel").innerHTML = about + kpis + charts + rawBlock(...)` on every load. Every 60 s
this destroys scroll position, closes every `<details>`, drops focus, and discards the region
sub-selection. There is also a `cache` object written to and never read (v2 line 460, 471) —
delete it.

### 4.2 The rule

**Structure mounts once per view. Values are patched in place. Nothing that holds user state is ever
re-created.**

About 45 lines, no framework, no virtual DOM, no keys-and-hooks ceremony.

```js
/* Mount a view's skeleton exactly once. `key` changes only when the *shape* changes
   (view id, region count) — never on a data tick. Returns true on a fresh mount. */
function mount(host, key, buildHTML){
  if (host.dataset.mounted === key) return false;
  host.innerHTML = buildHTML();
  host.dataset.mounted = key;
  return true;
}

/* Value patches. Each caches its last value on the node, so a tick that changes
   nothing touches no DOM at all and triggers no layout. */
function setText(el, v){ if (!el || el.__v === v) return; el.__v = v; el.textContent = v; }
function setHTML(el, v){ if (!el || el.__v === v) return; el.__v = v; el.innerHTML  = v; }
function setAttr(el, k, v){ if (!el || el["__a" + k] === v) return; el["__a" + k] = v; el.setAttribute(k, v); }
function setClass(el, c, on){ if (el) el.classList.toggle(c, !!on); }

/* Keyed list reconciler for collections whose membership changes:
   region rows, interconnector rows, spike register entries. */
function keyedList(parent, items, keyOf, create, update){
  const map = parent.__keyed || (parent.__keyed = new Map());   // key -> node, no DOM querying
  const seen = new Set();
  let cursor = parent.firstElementChild;
  for (const item of items){
    const k = String(keyOf(item)); seen.add(k);
    let node = map.get(k);
    if (!node){ node = create(item); node.dataset.k = k; map.set(k, node); }
    update(node, item);
    if (node !== cursor) parent.insertBefore(node, cursor);     // moves in place if already mounted
    else cursor = cursor.nextElementSibling;
  }
  for (const [k, n] of map) if (!seen.has(k)) { n.remove(); map.delete(k); }
}
```

### 4.3 How a view uses it

```js
const VIEWS = {
  now: {
    tab: "Now", sub: "all regions · 5-min",
    /* skeleton(): static HTML with data-slot hooks. Runs once. */
    skeleton(){
      return `<div class="statusbar">
                <span data-slot="interval"></span><span data-slot="age" class="chip"></span>
              </div>
              <div class="banner" data-slot="flags" hidden></div>
              <div class="cards" data-slot="cards"></div>
              <div class="chart wide"><h4>Regional price · last 3 h</h4>
                <div data-slot="strip"></div></div>`;
    },
    /* patch(): runs every tick. Touches values only. */
    patch(host, data){
      setText(host.querySelector('[data-slot="interval"]'), fmtInterval(data.settlementDate));
      const age = host.querySelector('[data-slot="age"]');
      setText(age, minsAgo(data.settlementDate) + " min ago");
      setClass(age, "warn", minsAgo(data.settlementDate) > 6);

      const flags = data.rows.filter(r => r.PRICE_STATUS !== "FIRM" || +r.APCFLAG || +r.MARKETSUSPENDEDFLAG);
      setHTML(host.querySelector('[data-slot="flags"]'), flagBanner(flags));
      host.querySelector('[data-slot="flags"]').hidden = !flags.length;

      keyedList(host.querySelector('[data-slot="cards"]'), data.rows,
                r => r.REGIONID, () => el(`<div class="card"><b></b><s></s></div>`),
                (node, r) => { setText(node.querySelector("b"), r.REGIONID);
                               setText(node.querySelector("s"), "$" + fmt(+r.PRICE, 2)); });

      updateChart(host.querySelector('[data-slot="strip"]'), priceStripModel(data));
    }
  }
};
```

The router calls `mount(...)` then `patch(...)`; the scheduler calls `patch(...)` alone. `<details>`
stay open, scroll stays put, and a tick where nothing changed performs zero DOM writes.

### 4.4 Refresh scheduling

v2 polls every 60 s against a 5-minute feed — four wasted requests in five, and the one that matters
lands at a random offset. Align to the publication cadence instead:

```js
const PERIOD = 5 * 60 * 1000;
let backoff = 0, retries = 0, timer = null;

function scheduleNext(lastSD){
  clearTimeout(timer);
  if (document.hidden) return;                       // no polling in a background tab
  let wait;
  if (backoff)               wait = Math.min(PERIOD, 15000 * Math.pow(3, backoff - 1));
  else if (retries)          wait = 30000;           // published late — nudge, up to 3 times
  else {
    const now = Date.now();
    wait = Math.ceil(now / PERIOD) * PERIOD + 25000 + Math.random() * 15000 - now;
    if (wait < 5000) wait += PERIOD;                 // AEMO publishes ~20–40 s past the boundary
  }
  timer = setTimeout(tick, wait);
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) tick();                      // catch up instantly on return
  else clearTimeout(timer);
});
```

`tick()` sets `backoff = 0; retries = 0` on a fresh `SETTLEMENTDATE`, `retries++` (max 3) when the
fetch succeeded but the interval has not advanced, and `backoff++` (max 5) on a network error.

---

## 5. Weather integration

### 5.1 The point to land

**Wind at the turbines drives price. Wind at the city does not.** Adelaide is 180 km from the
Mid-North wind farms and often has the opposite wind regime. A dashboard that plots "Adelaide wind
speed" next to "SA price" and implies a relationship is teaching the reader something false. Every
weather panel here is sited at generation clusters, and city sites appear only in the panel built to
prove they are the wrong thing to look at.

### 5.2 Sites

Two classes, tagged, never mixed on one axis.

**Load centres** — drive demand via temperature, and rooftop PV via cloud.

| Site | Region | Lat, lon |
|---|---|---|
| Sydney | NSW1 | −33.87, 151.21 |
| Melbourne | VIC1 | −37.81, 144.96 |
| Brisbane | QLD1 | −27.47, 153.03 |
| Adelaide | SA1 | −34.93, 138.60 |
| Hobart | TAS1 | −42.88, 147.33 |
| Perth | WEM | −31.95, 115.86 |

**Generation clusters** — drive supply. Approximate REZ / wind-farm centroids.

| Cluster | Region | Type | Lat, lon |
|---|---|---|---|
| Mid North (Hornsdale / Snowtown) | SA1 | wind | −33.10, 138.30 |
| Eyre Peninsula | SA1 | wind | −34.40, 135.90 |
| Western District (Macarthur) | VIC1 | wind | −38.05, 142.00 |
| Gippsland (Bald Hills) | VIC1 | wind | −38.70, 145.90 |
| Central-West Orana REZ | NSW1 | wind + solar | −32.25, 148.60 |
| New England REZ | NSW1 | wind + solar | −29.70, 151.70 |
| Darling Downs REZ | QLD1 | solar | −26.75, 150.60 |
| Coopers Gap | QLD1 | wind | −26.75, 151.40 |
| NW Tasmania (Woolnorth / Musselroe) | TAS1 | wind | −40.70, 144.70 |

These are approximations of a REZ centroid, and the UI says so. They are not a generator registry.

### 5.3 Variables and requests

Open-Meteo accepts comma-separated coordinates, so **all 15 sites are one request**.

```js
const FORECAST_VARS = [
  "temperature_2m", "apparent_temperature", "relative_humidity_2m",
  "cloud_cover", "shortwave_radiation", "direct_normal_irradiance",
  "wind_speed_10m", "wind_speed_100m", "wind_gusts_10m", "precipitation"
].join(",");

const url = "https://api.open-meteo.com/v1/forecast"
  + "?latitude="  + SITES.map(s => s.lat).join(",")
  + "&longitude=" + SITES.map(s => s.lon).join(",")
  + "&hourly=" + FORECAST_VARS
  + "&models=ecmwf_ifs025,gfs_seamless,icon_seamless,bom_access_global"
  + "&forecast_days=3&timezone=Australia%2FSydney";
```

`wind_speed_100m` is the load-bearing variable and `wind_speed_10m` is the decoy — 100 m is near
modern hub height, 10 m is the standard met-station height, and the ratio between them varies with
stability. `wind_gusts_10m` matters for cut-out. For solar: `direct_normal_irradiance` for trackers,
`shortwave_radiation` for fixed tilt, `temperature_2m` for panel derating,
`cloud_cover` at load centres as the rooftop-PV proxy.

Multi-model comparison at the same site is its own small panel: **four national models disagreeing
about tomorrow's hub-height wind is the market's actual uncertainty**, made visible.

### 5.4 Connecting weather to price — the causal chain

Four links, and every one is computable from data already in this repo:

```
hub-height wind  →  power curve  →  semi-scheduled generation
                                 →  residual demand  →  price
```

**Residual demand** is the quantity dispatchable plant must serve, and it is what actually sets the
price:

```js
const residual = r => +r.TOTALDEMAND - +r.SEMISCHEDULEDGENERATION;
```

Available on both the dispatch feed (actual) and the pre-dispatch feed (forecast), so residual
demand can be plotted as actual→forecast just like price. The panel:

- **Residual demand vs price scatter** (x = residual demand MW, y = price symlog, colour = hour of
  day). This draws the region's supply curve from observed data — and its knee is exactly where
  spikes live.
- **Power curve overlay.** A generic turbine curve turns a wind forecast into a generation
  expectation and shows *why* 4 → 8 m/s is enormous and 14 → 18 m/s is nothing:

```js
/* Generic modern onshore turbine: cut-in 3, rated 12, cut-out 25 m/s.
   Cubic between cut-in and rated, flat to cut-out, zero beyond. */
function powerCurve(v, { cutIn = 3, rated = 12, cutOut = 25 } = {}){
  if (v == null || isNaN(v) || v < cutIn || v >= cutOut) return 0;
  if (v >= rated) return 1;
  return Math.pow((v - cutIn) / (rated - cutIn), 3);
}
```

  Plot the curve with the current ensemble's p10/p50/p90 hub wind marked on the x axis and their
  images on y. When the ensemble straddles the steep section, the generation spread is huge; when it
  sits above rated, a 10 m/s spread means nothing. **That is the real reason wind forecast
  uncertainty maps non-linearly to price uncertainty**, and it is one small chart.

- **The headline panel: "Wind at the city vs wind at the turbines."** Four stacked, time-aligned
  strips sharing one x axis:

  1. Adelaide `wind_speed_10m`
  2. Mid North + Eyre Peninsula `wind_speed_100m`
  3. SA1 `SEMISCHEDULEDGENERATION` (archive)
  4. SA1 price (symlog, archive)

  Strips 2, 3 and 4 move together. Strip 1 does not. Print the lagged correlation of each wind
  series against strip 3 beneath the chart and let the numbers make the argument.

### 5.5 Ensemble spread

```js
const eurl = "https://ensemble-api.open-meteo.com/v1/ensemble"
  + "?latitude=-33.10&longitude=138.30"
  + "&hourly=wind_speed_100m&models=icon_seamless&forecast_days=3";
```

Returns `wind_speed_100m_member01 … memberNN`. Render as a `fanBand`: p10–p90 ribbon, p25–p75
darker ribbon, median line, and optionally 8 thin member spaghetti lines behind. Push the same
members through `powerCurve()` to get a **generation** fan — which is the version the market cares
about, and which is dramatically more skewed than the wind fan because the power curve is non-linear.
Showing both, side by side, is the whole lesson.

Ensembles are a **manual-load panel**, not part of the 5-minute tick. Weather at hourly resolution
does not need polling faster than every 30 minutes.

---

## 6. State, offline, and the archive

### 6.1 Hash routing

`#/<view>[/<region>][?k=v&…]` — e.g. `#/skill/SA1?h=2-4h&metric=mae&truth=full`.

```js
function readHash(){
  const raw = location.hash.replace(/^#\/?/, "");
  const [path, qs] = raw.split("?");
  const [view, region] = path.split("/");
  const q = Object.fromEntries(new URLSearchParams(qs || ""));
  return { view: VIEWS[view] ? view : "now", region: REGIONS.includes(region) ? region : null, q };
}
function writeHash(state, { replace = false } = {}){
  const qs = new URLSearchParams(clean(state.q)).toString();
  const h = "#/" + state.view + (state.region ? "/" + state.region : "") + (qs ? "?" + qs : "");
  if (h === location.hash) return;
  replace ? history.replaceState(null, "", h) : history.pushState(null, "", h);
}
window.addEventListener("hashchange", route);
window.addEventListener("popstate", route);
```

**Tab and region changes `pushState`** (the back button should undo navigation); **control tweaks
`replaceState`** (the back button should not have to walk through nine metric toggles).

### 6.2 Preferences

```js
const PREFS_KEY = "aemo.v3.prefs";   // {theme,refreshMs,lastView,region,priceScale,linthresh,fullRange,spikeThr}
const prefs = { ...DEFAULTS, ...safeParse(localStorage.getItem(PREFS_KEY)) };
const savePrefs = debounce(() => {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) {}   // private mode throws
}, 400);
```

**Precedence: hash > localStorage > defaults.** A shared link must render what the sender saw, not
what the recipient last looked at.

### 6.3 Offline and `file://` degradation

Three tiers, and the UI always names which one it is in:

| Tier | Condition | Behaviour |
|---|---|---|
| **Live** | fetch to AEMO succeeds | normal; green dot |
| **Archive** | live fetch fails, `data/latest.json` reachable | render from `latest.json`; amber dot; header reads *"Archive — collected 14 min ago"*, and every timestamp shows archive age |
| **Cold** | both fail | keep the last successfully rendered view; grey dot; *"No connection. Showing data from HH:MM."* Never blank the panel. |

Under `file://`, `fetch("data/latest.json")` is blocked by Chrome's opaque-origin rule, so tier 2 is
unavailable. Detect and say so once, with the fix:

```js
const OFFLINE_OK = location.protocol !== "file:";
if (!OFFLINE_OK) note("Opened from file:// — live feeds work, the local archive does not. "
                    + "Run `npx serve .` or `python -m http.server` in this folder for archive views.");
```

Archive-dependent views (Skill, and the history halves of Region/Network) show that message in place
of their charts rather than erroring. `file://` remains a first-class way to use the live views —
that is worth keeping.

### 6.4 Reading the local CSV archive over http

`nem_predispatch_forecast.csv` is 2.6 MB and grows ~1 MB/day. Refetching it whole on every visit is
wasteful and gets worse. Use the same `Range` trick `collect.js` uses on WEM — static servers
(`http-server`, `serve`, Python's `http.server`) all honour it.

```js
/* Fetch the header, then the last `bytes` of a chronologically-appended CSV.
   Drops the partial first line of the tail. Verified against the real 2.6 MB file:
   200 kB tail -> 1,828 rows, 0 malformed. */
async function tailCSV(url, bytes = 400000){
  const head = await fetch(url, { headers: { Range: "bytes=0-2047" } });
  if (!head.ok && head.status !== 206) throw new Error("HTTP " + head.status);
  const headerLine = (await head.text()).split("\n", 1)[0].trim();

  const len = +(head.headers.get("content-range") || "").split("/")[1] || 0;
  if (!len || len <= bytes) {                                   // small file — just take it whole
    const all = await (await fetch(url)).text();
    return csvObjects(all);
  }
  const r = await fetch(url, { headers: { Range: `bytes=${len - bytes}-${len - 1}` } });
  const tail = await r.text();
  const body = tail.slice(tail.indexOf("\n") + 1);              // drop the partial first line
  return csvObjects(headerLine + "\n" + body);
}

/* Incremental top-up: same file, only the bytes appended since last read. */
async function tailSince(url, lastLen){
  const h = await fetch(url, { method: "HEAD" });
  const len = +h.headers.get("content-length") || 0;
  if (len <= lastLen) return { len, rows: [] };
  const r = await fetch(url, { headers: { Range: `bytes=${lastLen}-${len - 1}` } });
  const t = await r.text();
  return { len, rows: t.slice(t.indexOf("\n") + 1) };           // caller re-attaches the header
}
```

Cache each parsed archive in a module-level `Map` keyed by URL with `{ len, rows, at }`; re-read on
a 60 s TTL or on explicit refresh. `wem_prices.csv` and `nem_dispatch.csv` are small enough to fetch
whole, but route them through the same helper so the behaviour is uniform as they grow.

### 6.5 The required `collect.js` change

Prerequisite for §2 (see §0.2). In `collectPredispatch()`, `actuals` is already computed and then
discarded — archive it instead:

```js
// after: const actuals = rows.filter(r => r.PERIODTYPE === "ACTUAL");

// The 5MIN feed returns a full trailing DAY of 5-minute actuals (5 regions x 288)
// on every call. Archiving them backfills any gap shorter than 24 h, which is what
// makes forecast-vs-actual scoring possible at better than a ~10% match rate.
const aHeader = ["SETTLEMENTDATE", "REGIONID", "RRP", "TOTALDEMAND",
                 "NETINTERCHANGE", "SCHEDULEDGENERATION", "SEMISCHEDULEDGENERATION"];
const aFile = path.join(DATA_DIR, "nem_actual_5min.csv");
const seen = new Set();
if (fs.existsSync(aFile)) {
  const ex = parseCSV(fs.readFileSync(aFile, "utf8"));
  for (const r of ex.slice(1)) if (r[0]) seen.add(r[0] + "|" + r[1]);
}
const aRows = actuals
  .filter(r => !seen.has(r.SETTLEMENTDATE + "|" + r.REGIONID))
  .sort((x, y) => x.SETTLEMENTDATE.localeCompare(y.SETTLEMENTDATE))
  .map(r => [r.SETTLEMENTDATE, r.REGIONID, r.RRP, r.TOTALDEMAND,
             r.NETINTERCHANGE, r.SCHEDULEDGENERATION, r.SEMISCHEDULEDGENERATION]);
const na = appendRows(aFile, aHeader, aRows);
log(`predispatch: +${na} backfilled 5-min actual rows`);
```

Deliberately **no `fetched_at` column** — these rows are backfill, so a collection timestamp would
be meaningless and the natural key `(SETTLEMENTDATE, REGIONID)` is what dedupes them. The set-based
dedupe reads the whole file each run; at ~1,440 rows/day that is fine for a year. Swap to a
`_state.json` high-water mark plus a rolling tail read if it ever becomes a problem.

The dashboard's actual index prefers `nem_actual_5min.csv` and overlays `nem_dispatch.csv` on top
(the latter is authoritative for `PRICE_STATUS` / `APCFLAG`, which the 5MIN feed does not carry).

---

## 7. Theming

`<meta name="color-scheme" content="light dark">`. Three states — `auto` (default, follows
`prefers-color-scheme`), `light`, `dark` — via `data-theme` on `<html>`, persisted in prefs.

```css
:root{ /* light */ }
@media (prefers-color-scheme: dark){ :root:not([data-theme="light"]){ /* dark */ } }
:root[data-theme="dark"]{ /* dark */ }
```

The dark block is written twice (media query + explicit attribute) so the manual toggle wins in both
directions. Define every token on bare `:root` first; a token whose only definition lives inside a
media query disappears for anyone on the other scheme.

### 7.1 Token table

| Token | Light | Dark | Role |
|---|---|---|---|
| `--bg` | `#f5fbff` | `#0e1520` | page ground |
| `--bg-grad` | `#fffdf8` | `#0b111a` | gradient stop |
| `--paper` | `#ffffff` | `#161f2d` | cards, panels |
| `--paper-2` | `#f8fbff` | `#1c2637` | nested / table header |
| `--ink` | `#24324a` | `#e4ecf7` | body text |
| `--ink-strong` | `#263b5f` | `#f3f7fd` | headings, KPI values |
| `--muted` | `#60708c` | `#93a3bb` | captions |
| `--line` | `#dce7f3` | `#2a3648` | borders |
| `--grid` | `#eef3f9` | `#243043` | chart gridlines |
| `--axis` | `#98a6ba` | `#7d8ca4` | axis labels |
| `--zero` | `#b9c8da` | `#4a5b74` | zero reference rule |
| `--blue` | `#2f74d0` | `#5b9bf0` | NSW1, primary |
| `--blue-soft` | `#eaf4ff` | `#16283f` | tint |
| `--cyan` | `#34a7b6` | `#4fc6d4` | demand |
| `--cyan-soft` | `#e8f8fa` | `#123135` | tint |
| `--coral` | `#e87a63` | `#ff9b83` | SA1, spikes, errors |
| `--coral-soft` | `#fff0ec` | `#3a2019` | tint |
| `--gold` | `#d9a227` | `#f0bc45` | QLD1, "now" marker |
| `--gold-soft` | `#fff7df` | `#33280c` | tint |
| `--green` | `#2b9a74` | `#4cc296` | TAS1, live, positive skill |
| `--green-soft` | `#e9f8f2` | `#12312a` | tint |
| `--violet` | `#7b72d8` | `#9d95f0` | VIC1 |
| `--violet-soft` | `#f0efff` | `#241f3f` | tint |
| `--neg-band` | `#eef4fb` | `#151f30` | sub-zero price shading |
| `--spike-band` | `#fff4f0` | `#2a1a17` | above-threshold shading |
| `--code-bg` | `#0f2340` | `#050a12` | endpoint / JSON blocks |
| `--code-ink` | `#cfe4ff` | `#a8c6ea` | code text |
| `--shadow` | `0 14px 40px rgba(70,104,142,.12)` | `0 14px 40px rgba(0,0,0,.45)` | elevation |
| `--radius` | `18px` | `18px` | corners |

Three rules that matter:

1. **Region colours keep their hue in dark, gain lightness and lose a little chroma.** Region
   identity must survive a theme switch — `SA1` is coral in both, or the reader relearns the legend.
2. **`--x-soft` inverts meaning between themes**: a pale tint in light, a dark tint in dark. Never
   reuse the light value in dark; the contrast collapses.
3. **`REGION_COLORS` becomes a token lookup**, not a hex literal:
   `{NSW1:"var(--blue)", QLD1:"var(--gold)", SA1:"var(--coral)", TAS1:"var(--green)", VIC1:"var(--violet)"}`.
   SVG inherits custom properties, so charts follow the theme with no JS and no redraw.

Where a colour must be a real value (canvas-free interpolation for heatmap ramps), read it once per
theme change via `getComputedStyle(document.documentElement).getPropertyValue("--coral")` and cache
it; invalidate the cache on the `prefers-color-scheme` media-query listener and on manual toggle.

Also set `body{background:var(--bg)}` explicitly. A transparent body inherits the host's ground and
produces a light page in a dark browser.

---

## 8. File layout

Single file, in this order. Sections are marked with the same `/* ===== name ===== */` banner style
v2 already uses.

| # | Section | Contents | ~lines |
|---|---|---|---|
| 1 | `<head>` | meta, `color-scheme: light dark`, title | 12 |
| 2 | `<style>` — tokens | light block, dark media block, dark attribute block | 80 |
| 3 | `<style>` — layout | shell, header, tabs, cards, KPIs, chart boxes, tables, banners, responsive breakpoints | 250 |
| 4 | Body shell | header, control bar, theme toggle, `#tabs`, `#view`, footer | 60 |
| 5 | `helpers` | `$`, `$$`, `esc`, `fmt`, `parseCSV`, `csvObjects`, date parsing (`T`, `parseWEMDate`, `timeHM`, `dayHM`), `debounce`, `safeParse`, `el` | 120 |
| 6 | `scales` | `linear`, `symlog`, `symlogTicks`, `niceTicks`, colour ramps, `REGION_COLORS` | 90 |
| 7 | `chart primitives` | `responsive`, `updateChart`, `yAxis`, `xTicks`, `barChart`, `stackedBars`, `priceChart`, `stepChart`, `scatter`, `heatmap`, `durationCurve`, `bipolarGauge`, `schematic`, `fanBand`, `reliability` | 520 |
| 8 | `render helpers` | `mount`, `setText`, `setHTML`, `setAttr`, `setClass`, `keyedList`, `kpi`, `chartBox`, `aboutBlock`, `tableFor`, `rawBlock`, `note`, `flagBanner` | 150 |
| 9 | `data layer` | live fetchers (dispatch, predispatch, WEM, weather), `tailCSV`, `tailSince`, archive cache + TTL, offline tiering, `store` | 230 |
| 10 | `analytics` | `truthAt`, `buildActualIndex`, `pairForecasts`, `BUCKETS`, `bucketOf`, `agg`, `quantile`, `calibrate`, `contingency`, `powerCurve`, `residual`, concentration, duration curve, negative-price clock | 220 |
| 11 | `VIEWS` registry | 7 views × `{tab, sub, needs, skeleton(), patch()}` | 400 |
| 12 | `app shell` | router, `readHash`/`writeHash`, tab builder, `scheduleNext`/`tick`, theme init + toggle, prefs, status, global error boundary, boot | 180 |
| | | **total** | **~2,310** |

Section 11 keeps v2's best idea intact: `VIEWS` is still `Object.entries()`-driven and the tab bar
still builds itself from it. The registry entry gains `needs: ["live"] | ["archive"] | ["live","archive"]`
so the router can grey out archive views under `file://` without each view checking.

**Section 7 is the one to write first and get right** — every view depends on it, and the primitives
are where all four hard problems (responsiveness, symlog, zero handling, spike visibility) are solved
once instead of eight times.

---

## 9. What not to build, and why

**A geographic map of the NEM.** The NEM is five nodes and six edges. A map needs external basemap
tiles, which breaks zero-dependency *and* `file://` *and* offline mode, in exchange for showing that
South Australia is west of Victoria. The §1.3 schematic carries strictly more information per pixel.

**Any charting library.** d3, Chart.js, Plotly, uPlot. The primitives in §3 are ~520 lines and give
exact control over symlog, step rendering, spike markers and CSS-variable theming — the four things
a general-purpose library would fight. Adding one also ends single-file distribution.

**A build step, npm, TypeScript, or a framework.** The file must stay openable by double-clicking it.
Anything that requires `npm install` before someone can look at a price chart has already lost.

**duckdb-wasm / sql.js for the archive.** Tempting for the join, and wrong. It is a multi-megabyte
WASM dependency to query files that currently total 2.8 MB, and §2.3 shows the join is 30 lines of
plain JS. Revisit only if the archive passes ~500 MB, which is roughly 18 months away.

**A price forecasting model inside the dashboard.** The dashboard's job is to **score** forecasts,
not make them. A model in the browser cannot be reproduced, cannot be versioned, and cannot be
prevented from peeking at the future. Ship the `forecast_ledger.csv` contract (§2.4) and let a
separate process compete on equal terms.

**NEMWeb ingestion in the browser.** No CORS header — it will never work client-side. Any richer NEM
data (constraints, bids, unit dispatch, five-minute settlements) belongs in `collect.js`.

**The 19 MB WEM facility SCADA fetch in the browser.** v2's `loadWEMgen()` downloads the whole
month's file to display fifteen rows. `collectSCADA()` already `Range`-fetches the first 600 kB
server-side. Delete the browser path.

**A service worker or PWA shell.** Offline is handled by tiering to `data/latest.json` (§6.3). A
service worker adds a cache-invalidation problem and a "why am I seeing yesterday's dashboard" class
of bug for no gain on a page that is meaningless without fresh data.

**60-second auto-refresh.** The feed updates every 5 minutes. §4.4 replaces polling with boundary
alignment; keep a manual refresh button and drop the interval checkbox.

**Animated chart transitions.** Interpolating between two prices draws values that never occurred.
On a symlog axis spanning four orders of magnitude the tween is also visually incoherent. Snap.

**A rooftop-PV estimate.** ~26 GW of behind-the-meter generation is invisible to every feed here.
Label the gap (§1.8); do not model it and present the model as an observation.

**Mobile-first redesign.** Responsive-adequate — cards stack, charts reflow via §3.1, tables scroll
horizontally. This is a two-monitor tool. Do not spend a week on a phone layout nobody will use to
read a reliability diagram.

**User accounts, server-side rendering, a database, alerting/notifications.** Every one of them
converts a file you can email into infrastructure you have to operate. If alerting is genuinely
wanted later, it belongs in `collect.js`, which already runs on a schedule and already knows when a
new interval arrives.

---

## 10. Build order

1. **`collect.js` §6.5 backfill change**, then let it run for a day. Everything downstream is
   starved without it — the join is at 9.6% today and ~98% after.
2. **Section 7 primitives** + the §7 token table, verified on a throwaway page against the known
   symlog checks in §3.2.
3. **Section 4 renderer** + app shell + router. Port the *Now* view.
4. **Region and Network.**
5. **Forecast skill** — the point of the exercise. Charts (1), (2) and (3) first; they carry most of
   the value. (5)–(8) after.
6. **Weather**, starting with the city-vs-turbines panel — the argument matters more than coverage.
7. **WEM and Feeds & archive**, mostly ported from v2.
