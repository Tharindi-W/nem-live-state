# NEM Live State

Live Australian electricity market data, an always-on archiver, and a scorer that
measures how good AEMO's own forecast actually is.

This is step 0 of a forecasting product: understand the feeds, archive them, and
establish the baseline **before** building any model.

## What's here

| File | What it does |
|---|---|
| `index.html` | Single-file, zero-dependency dashboard. Opens from disk, over http, or on Pages. |
| `collect.js` | Zero-dependency archiver. Appends new, de-duplicated rows to `data/`. |
| `score.js` | Joins archived forecast vintages to actuals and scores AEMO against persistence. |
| `serve.js` | Minimal static server with Range support, for local viewing. |
| `docs/` | Source register, licensing, and the dashboard build spec. |
| `data/` | The archive. Append-only CSV. |

## Quick start

```bash
node collect.js        # pull every feed once
node score.js          # how good is AEMO's forecast?
node serve.js          # then open http://localhost:4173
```

The dashboard also works by double-clicking `index.html` — every live feed it
uses sends `Access-Control-Allow-Origin: *`. Serving it over http additionally
unlocks the local archive views.

## The feeds

**Fetched in the browser** (CORS-open, no key):

- NEM dispatch summary — 5-min regional price, demand, generation, interconnector flows with limits
- NEM pre-dispatch — AEMO's forward price/demand trajectory, reissued every 5 min
- WEM market clearing prices — Western Australia, 5-min
- Weather — Open-Meteo, ECMWF IFS, sampled at wind-farm and solar-farm coordinates

**Fetched server-side by `collect.js`** (NEMWeb sends no CORS header):

- Rooftop PV actual — both the SATELLITE estimate and the MEASUREMENT stream
- Rooftop PV forecast — with POE low/50/high bands and a vintage timestamp

See [`docs/cross_domain_sources.md`](docs/cross_domain_sources.md) for the full
verified register, including what was checked and rejected.

## Three things worth knowing

**The archive is a latency advantage, not a history advantage.** AEMO's MMSDM
archive publishes everything here — including vintaged forecast solutions — back
to 2009, free. Collecting from today buys freshness, not exclusivity. Backfilling
MMSDM is the clear next step.

**`TOTALDEMAND` is operational demand.** It excludes roughly 26 GW of
behind-the-meter rooftop PV that no feed here observes. Every label in the
dashboard says so. Rooftop PV is collected separately, and AEMO's own
satellite-vs-measured pair is a free estimate-vs-truth label.

**Bureau of Meteorology data is not licensed for commercial use.** It is free to
read, but a commercial product needs a licence. The weather query pins ECMWF
rather than BoM ACCESS-G for exactly this reason.

## Always-on collection

The Windows scheduled task only runs when the machine is awake, which left a
26-hour hole in the archive. [`.github/workflows/collect.yml`](.github/workflows/collect.yml)
runs the collector on GitHub's cron instead and commits new rows, so collection
and hosting are the same system. GitHub's cron is best-effort — treat the cadence
as "roughly every 10 minutes", not a guarantee.

## Licensing

AEMO material is generally reusable with attribution; verify current terms before
commercial use. Weather data is Open-Meteo (CC BY 4.0). Generator coordinates are
from OpenNEM. None of this is legal advice.
