# Cross-Domain Data Sources — Verification Report

**Verified:** 2026-08-24 (AEST). Method: `curl -sS -m 25`, CORS probed with `-H "Origin: https://example.com"` (a real origin, not `null` — some CDNs reflect the origin verbatim, so `null` is ambiguous).

**Carried forward as already settled (not re-tested this pass):** AEMO `visualisations.aemo.com.au/aemo/apps/api/report/ELEC_NEM_SUMMARY` and `/5MIN` (CORS open); WEM `data.wa.aemo.com.au` CSVs (CORS open); Open-Meteo forecast/ensemble/archive (CORS `*`); `nemweb.com.au` sends no CORS header at all; BoM products free but not licensed for commercial use.

---

## Verification table

| Source | URL | CORS | Key needed | Cadence | Licence | Signal 1-5 | Verdict |
|---|---|---|---|---|---|---|---|
| Rooftop PV ACTUAL (satellite + measurement) | `https://nemweb.com.au/Reports/CURRENT/ROOFTOP_PV/ACTUAL/` | none | no | 30 min | AEMO terms (UNVERIFIED text) | **5** | **TIER 2** — collect.js |
| Rooftop PV FORECAST | `https://nemweb.com.au/Reports/CURRENT/ROOFTOP_PV/FORECAST/` | none | no | 30 min, ~7.8 d horizon | AEMO terms (UNVERIFIED text) | **5** | **TIER 2** — collect.js |
| Market Notices | `https://nemweb.com.au/Reports/CURRENT/Market_Notice/` | none | no | event-driven, ~9-10/day | AEMO terms (UNVERIFIED text) | 4 | **TIER 2** — collect.js |
| NEM Registration & Exemption List | `https://aemo.com.au/-/media/files/electricity/nem/participant_information/nem-registration-and-exemption-list.xls` | **reflects origin** | no (but **UA-gated**) | ~weekly-ish (last-mod 2026-08-18) | AEMO terms (UNVERIFIED text) | 5 (reference) | **TIER 3** — static, refresh monthly |
| Gas Bulletin Board | `https://nemweb.com.au/Reports/CURRENT/GBB/` | none | no | daily (gas day) | AEMO terms (UNVERIFIED text) | 3 | **TIER 2** — collect.js |
| DEA Hotspots WFS | `https://hotspots.dea.ga.gov.au/geoserver/public/wfs` | **reflects origin** | no | ~10 min (Himawari AHI) | CC BY 4.0 (GA-wide, confirmed; per-product page not readable) | 2 | **TIER 1** — browser-fetchable |
| APVI live rooftop PV | `https://pv-map.apvi.org.au/api/v2/2-digit/<date>.json` | n/a | **YES — 401** | unknown | unknown | — | **BLOCKED** |
| OpenNEM facility geo registry | `https://data.opennem.org.au/v3/geo/au_facilities.json` | none | no | static-ish | CC BY 4.0 claimed by OpenNEM (UNVERIFIED this pass) | 5 (reference) | **TIER 3** — download once |

---

## TIER 1 — browser-fetchable right now (CORS OK)

### DEA Hotspots (Digital Earth Australia / Geoscience Australia)

GeoServer WFS, CORS header reflects the requesting origin and sets `Access-Control-Allow-Credentials: true`, so a plain `fetch()` from the dashboard works.

- **GetCapabilities:** `https://hotspots.dea.ga.gov.au/geoserver/public/wfs?service=WFS&version=1.0.0&request=GetCapabilities` → HTTP 200, `application/xml`, 21,124 bytes.
- **Feature types available:** `public:hotspots`, `public:hotspots_three_days`, `public:multi_station_satellite_pass_last_hotspot`, `public:multi_station_satellite_pass_next_hotspot`, `public:satellite_pass_last_hotspot`, `public:satellite_pass_next_hotspot`.
- **GeoJSON query that works:**
  ```
  https://hotspots.dea.ga.gov.au/geoserver/public/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=public:hotspots_three_days&outputFormat=application/json&count=2
  ```
  → HTTP 200, `application/json;charset=utf-8`, `Access-Control-Allow-Origin: https://example.com`.
- **Volume:** `totalFeatures = 160334` in the three-day layer. Always paginate with `count` / `startIndex`, and add a `bbox` or CQL filter — never fetch unbounded.
- **Sample feature (truncated):**
  ```json
  {"type":"Point","coordinates":[147.4199,-19.6572]}
  {"id":120510739,"satellite":"HIMAWARI-9","sensor":"AHI","start_dt":"2026-08-22T17:50:00Z",
   "datetime":"2026-08-22T17:57:29Z","latitude":-19.6572,"longitude":147.4199,
   "temp_kelvin":298,"power":13.2,"confidence":50,"australian_state":"QLD",
   "hours_since_hotspot":29.62,"accuracy":"± 2km"}
  ```
  `power` is fire radiative power (MW); `confidence` 0-100; `accuracy` ±2 km for AHI.
- **Cadence:** Himawari-9 AHI delivers ~10-minutely; polar orbiters (VIIRS/MODIS) land per overpass.
- **Dead end noted:** `https://hotspots.dea.ga.gov.au/data/all-sensors/all-satellites.json` returns HTTP 200 but `Content-Type: text/html`, 4,726 bytes — that is the SPA shell, not data. Do not use it.

---

## TIER 2 — server-side only (no CORS; must go through collect.js)

### 1. Rooftop PV ACTUAL — highest-value item

`https://nemweb.com.au/Reports/CURRENT/ROOFTOP_PV/ACTUAL/`

Two independent product streams live in the same directory:

- `PUBLIC_ROOFTOP_PV_ACTUAL_SATELLITE_<yyyymmddHHMMSS>_<17-digit-id>.zip`
- `PUBLIC_ROOFTOP_PV_ACTUAL_MEASUREMENT_<yyyymmddHHMMSS>_<17-digit-id>.zip`

**Size:** zip 474 bytes → single CSV 663 bytes, 8 lines total (5 data rows). This is trivially cheap to poll.

**Verified CSV, SATELLITE variant** (`PUBLIC_ROOFTOP_PV_ACTUAL_SATELLITE_20260824090000_0000000534185099.zip`):

```
C,NEMP.WORLD,ROOFTOP_PV_ACTUAL_SATELLITE,AEMO,PUBLIC,2026/08/24,09:00:05,0000000534185099,DEMAND,0000000534185097
I,ROOFTOP,ACTUAL,2,INTERVAL_DATETIME,REGIONID,POWER,QI,TYPE,LASTCHANGED
D,ROOFTOP,ACTUAL,2,"2026/08/24 08:30:00",NSW1,2200.909,0.6,SATELLITE,"2026/08/24 08:50:19"
D,ROOFTOP,ACTUAL,2,"2026/08/24 08:30:00",QLD1,1551.764,0.6,SATELLITE,"2026/08/24 08:50:19"
D,ROOFTOP,ACTUAL,2,"2026/08/24 08:30:00",SA1,111.261,0.6,SATELLITE,"2026/08/24 08:50:19"
D,ROOFTOP,ACTUAL,2,"2026/08/24 08:30:00",TAS1,43.58,0.6,SATELLITE,"2026/08/24 08:50:19"
D,ROOFTOP,ACTUAL,2,"2026/08/24 08:30:00",VIC1,740.524,0.6,SATELLITE,"2026/08/24 08:50:19"
C,"END OF REPORT",8
```

**Verified CSV, MEASUREMENT variant** (`...MEASUREMENT_20260824093000_...zip`, 483 bytes zip / 670 bytes CSV, same 10-column schema):

```
D,ROOFTOP,ACTUAL,2,"2026/08/24 09:00:00",NSW1,2689.374,1,MEASUREMENT,"2026/08/24 09:19:05"
D,ROOFTOP,ACTUAL,2,"2026/08/24 09:00:00",QLD1,1774.013,0.7,MEASUREMENT,"2026/08/24 09:19:05"
```

- **Regions:** NSW1, QLD1, SA1, TAS1, VIC1 — exactly 5 rows per file. **No WA/SWIS here** (WEM rooftop comes from `data.wa.aemo.com.au`).
- **Units:** `POWER` is MW.
- **`QI`** is the quality indicator, 0.0-1.0 — the fraction of the estimate backed by real data. Note SATELLITE reported QI 0.6 while MEASUREMENT reported 1.0 (NSW1) / 0.7 (QLD1) for a later interval. **Use QI as a model feature or a sample weight — do not discard it.**
- **Interval:** 30 minutes, `INTERVAL_DATETIME` is the interval *ending* label in NEM time (AEST, no DST).
- **Publish lag:** ~30 min. The 08:30 interval was published at 09:00:05 with `LASTCHANGED` 08:50:19. Budget a 30-40 min lag for the freshest actual.
- **Cadence:** new file every 30 minutes per variant.
- **Retention in CURRENT:** directory listing yielded 1,345 anchor hrefs, and the IIS-style listing emits each filename twice, so ≈672 files ≈ 336 per variant ≈ **7 days**. Archive beyond that lives under `Reports/ARCHIVE/`.

**Why this matters:** rooftop PV is behind the meter and therefore invisible in operational demand. SATELLITE vs MEASUREMENT for the same interval is a free, self-labelling estimate-vs-truth pair — that difference is directly the error term you are trying to forecast.

### 2. Rooftop PV FORECAST

`https://nemweb.com.au/Reports/CURRENT/ROOFTOP_PV/FORECAST/`

`PUBLIC_ROOFTOP_PV_FORECAST_<yyyymmddHHMMSS>_<17-digit-id>.zip` — only one variant.

**Size:** zip 22,948 bytes → CSV 210,241 bytes, 1,873 lines. ~50x the actuals file; still cheap.

```
C,NEMP.WORLD,ROOFTOP_PV_FORECAST,AEMO,PUBLIC,2026/08/24,09:00:01,0000000534185095,DEMAND,0000000534185095
I,ROOFTOP,FORECAST,1,VERSION_DATETIME,REGIONID,INTERVAL_DATETIME,POWERMEAN,POWERPOE50,POWERPOELOW,POWERPOEHIGH,LASTCHANGED
D,ROOFTOP,FORECAST,1,"2026/08/24 09:00:00",NSW1,"2026/08/24 09:30:00",3317.569,3334.102,3207.563,3409.528,"2026/08/24 08:51:58"
D,ROOFTOP,FORECAST,1,"2026/08/24 09:00:00",NSW1,"2026/08/24 10:00:00",3858.693,3882.477,3557.279,4056.241,"2026/08/24 08:51:58"
D,ROOFTOP,FORECAST,1,"2026/08/24 09:00:00",NSW1,"2026/08/24 10:30:00",4252.452,4266.094,3843.135,4491.874,"2026/08/24 08:51:58"
```

- **Shape:** 374 distinct `INTERVAL_DATETIME` values x 5 regions = 1,870 data rows.
- **Horizon:** first `2026/08/24 09:30:00`, last `2026/09/01 04:00:00` — **~7.8 days at 30-min resolution**.
- **Note the two clocks:** `VERSION_DATETIME` (forecast run time, constant within a file) and `INTERVAL_DATETIME` (target). Key on both to build a proper vintaged panel and avoid leakage.
- **Probabilistic:** `POWERMEAN`, `POWERPOE50`, `POWERPOELOW`, `POWERPOEHIGH` give a free uncertainty band. `POWERLOW`/`POWERHIGH` bracket width is itself a strong feature for demand-forecast-error variance.
- **Cadence:** every 30 minutes. Retention ≈336 files ≈ 7 days.

### 3. Market Notices

`https://nemweb.com.au/Reports/CURRENT/Market_Notice/`

- **Filenames carry no extension:** `NEMITWEB1_MKTNOTICE_<YYYYMMDD>.R<noticeid>`, e.g. `.../NEMITWEB1_MKTNOTICE_20260823.R144914`. Plain text, a few KB each.
- **Volume:** 575 anchor hrefs in the CURRENT listing; date stamps run **20260625 → 20260823**, so ~60 days retained. Notice IDs are a monotonic global counter (R144910…R144914 were consecutive), which makes gap-detection and incremental sync trivial — just track the highest ID seen.
- **Verified structure** (one notice, fetched in full):

```
-------------------------------------------------------------------
                           MARKET NOTICE
-------------------------------------------------------------------
From :              AEMO
To   :              NEMITWEB1
Creation Date :     23/08/2026     13:23:42
-------------------------------------------------------------------
Notice ID               :         144914
Notice Type ID          :         NON-CONFORMANCE
Notice Type Description :         Details of Non-conformance/Conformance
Issue Date              :         23/08/2026
External Reference      :         NON-CONFORMANCE VIC Region - 23/08/2026
-------------------------------------------------------------------
Reason :

AEMO ELECTRICITY MARKET NOTICE
AEMO has declared the following unit as non-conforming under clause 3.8.23 ...
Unit:         NUMURSF1
Duration:  1230 HRS 23/08/2026 to 1315 HRS 23/08/2026
Constraint: NC-V_NUMURSF1
Manager NEM Real Time Operations
```

- **Parsing:** fixed-label plain text. `^(Notice ID|Notice Type ID|Notice Type Description|Issue Date|External Reference)\s*:\s*(.*)$` gets the structured header; everything after `Reason :` is free text.
- **High-value extractables:** DUIDs appear verbatim in the body (`NUMURSF1`), as do constraint IDs (`NC-V_NUMURSF1`), region names, and explicit start/end timestamps. This is a genuine NLP feature source — join notice text to DUID via the registration list below.
- **UNVERIFIED:** only the `NON-CONFORMANCE` type was inspected. Other types (reserve/LOR notices, market intervention, price-subject-to-review, inter-regional transfer limits) are widely reported to use the same envelope but I did not sample one. Do not hardcode a type whitelist until you have counted the real distribution.

### 4. Gas Bulletin Board

`https://nemweb.com.au/Reports/CURRENT/GBB/` — flat directory, 74 anchor hrefs, ~60 distinct reports plus 4 subdirectories (`CURRENT/`, `DUPLICATE/`, `ForecastUtilisation/`, `GBB_PIPELINE_CONNECTION_FLOW/`). Plain CSV and zip, **no API key, no CORS**. There is no JSON API here — the CSVs *are* the machine-readable interface.

**Three verified as the highest-value subset:**

| File | Bytes | Header |
|---|---|---|
| `GasBBActualFlowStorageLast31.CSV` | 605,569 | `GasDate,FacilityName,FacilityId,FacilityType,Demand,Supply,TransferIn,TransferOut,HeldInStorage,CushionGasStorage,State,LocationName,LocationId,LastUpdated` |
| `GasBBNominationAndForecastNext7.CSV` | 84,814 | `Gasdate,FacilityId,FacilityName,FacilityType,LocationId,LocationName,State,Demand,Supply,TransferIn,TransferOut,LastUpdated` |
| `GasBBFacilities.CSV` | 16,757 | `FacilityName,FacilityShortName,FacilityId,FacilityType,FacilityTypeDescription,OperatingState,OperatingStateDate,OperatorName,OperatorId,OperatorChangeDate` |

Samples:
```
2026/07/25,Adelaide Brighton,555091,BBLARGE,9.803,0.000,0.000,0.000,,,SA,Adelaide,550016,2026/08/21 13:00:08
2026/08/24,580010,AGP,PIPE,580001,Darwin,NT,24.800,0.000,15.000,10.000,2026/08/24 06:13:29
```

**Cadence:** the gas day is the atom — one row per facility per `GasDate`. Observed `LastUpdated` of `2026/08/24 06:13:29` on the forward nomination file (same-day) vs `2026/08/21 13:00:08` on a `2026/07/25` actual row, i.e. **actuals settle with a multi-day revision tail; nominations refresh daily.** Poll daily and treat actuals as revisable, not final.

**`NominationAndForecastNext7` is the leading indicator you want** — it is a forward 7-day view of gas demand/supply per facility, published before the electricity market resolves. Gas-fired peakers set the NEM price in tight intervals, so gas nominations for a GPG facility are a same-horizon covariate for the price spike you are forecasting.

**Other reports worth knowing (names confirmed present, contents not inspected):** `GasBBLinepackCapacityAdequacyFullList.zip` and `...Future.CSV` (pipeline linepack adequacy — the direct "can gas physically get there" constraint), `GasBBShortTermCapacityOutlook.CSV`, `GasBBMediumTermCapacityOutlook.csv`, `GasBBUncontractedCapacityOutlookFuture.csv`, `GasBBNameplateRatingCurrent.csv`, `GasBBShortTermTransactions{NSW,VIC,QLD,SA,TAS,NT}.CSV` and matching `...SwapTransactions...` (traded gas prices by state), `GasBBLNGShipments.CSV`, `GasBBGSHGasTrades.CSV`, `GasBBNodesAndConnectionPointsFull.CSV`, `GasBBLocationsList.CSV`, `GasBBBasins.csv`, `GasBBReservesAndResources.csv`, `GasBBPipelineConnectionFlowLast31.CSV`, plus history zips `GasBBPipelineConnectionFlow_2018_2023.zip` and `_2023_2028.zip`.

---

## TIER 3 — static reference data (fetch once, refresh on a slow schedule)

### NEM Registration and Exemption List — the DUID registry

**Working URL (found; the AEMO page link moves but this media path resolves):**
```
https://aemo.com.au/-/media/files/electricity/nem/participant_information/nem-registration-and-exemption-list.xls
```

- **HTTP 200 — but only with a browser `User-Agent`.** With curl's default UA it returns **403 Forbidden**. `collect.js` must send a realistic UA or this silently breaks.
- **Format gotcha:** the extension is `.xls` but the `Content-Type` is `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` — it is **really an XLSX**. Parse with an xlsx reader (openpyxl / SheetJS), not an xls reader.
- **Size:** 782,950 bytes. `Last-Modified: Tue, 18 Aug 2026 01:39:30 GMT` (6 days before verification → refresh monthly, or weekly if you want new DUIDs promptly).
- **CORS: `access-control-allow-origin` reflects the request origin** (verified: sending `Origin: https://example.com` returned that exact value). So a browser *can* fetch it directly — but it is 780 KB of spreadsheet, so cache it server-side anyway.
- **13 sheets:** `Overview`, `Registered Participants`, `Applications Received `, `Ceasing Registration`, `Suspended Participants`, **`PU and Scheduled Loads`**, `Exemption - small gen or IRS`, `Exemption - Intermediary`, `Exemption - Central Dispatch`, `Ancillary Services`, `Wholesale Demand Response Units`, `Metering Coordinators`, `Dedicated Connection Asset`.
- **`PU and Scheduled Loads` is the DUID registry** — 579 data rows, 21 columns:

  `Participant`, `Station Name`, `Region`, `Dispatch Type`, `Category`, `Classification`, `Fuel Source - Primary`, `Fuel Source - Descriptor`, `Technology Type - Primary`, `Technology Type - Descriptor`, `Units`, `Aggregation`, **`DUID`**, `Reg Cap generation (MW)`, `Max Cap generation (MW)`, `Max ROC/Min generation`, `Reg Cap consumption (MW)`, `Max Cap consumption (MW)`, `Max ROC/Min consumption`, `Maximum storage capacity `, `Comments`

  Sample rows:
  ```
  South Australian Water | Adelaide Desalination | SA1 | Bidirectional Unit | Market | Scheduled | Battery Storage | Grid | Storage | Battery and Inverter | 1,2-3 | Y | ADPBA1 | 7.76 | 6.15 | 4 | 7 | 6 | 4 | 6
  South Australian Water | Adelaide Desalination | SA1 | Generating Unit   | Market | Non-Scheduled | Hydro | Water | Renewable | Run of River | 1-2 | Y | ADPMH1 | 1.44 | 1 | - | None | None | None | None
  ```

- **It has NO latitude/longitude** — confirmed by scanning all 21 headers. Everything else you asked for (unit name, region, fuel type, registered capacity) is there, but for geography you must join to a separate source. That is what the next item is for.
- Note trailing spaces in two header strings (`'Applications Received '`, `'Maximum storage capacity '`) — strip headers on ingest.

### OpenNEM facility geo registry — the lat/long join

```
https://data.opennem.org.au/v3/geo/au_facilities.json
```

- HTTP 200, `application/json`, **383,638 bytes**, **481 features**. **No CORS header** → server-side fetch, commit the result as a static asset.
- GeoJSON-style `features[]` with `geometry.coordinates` = `[lon, lat]`.
- Properties: `station_id`, `station_code`, `facility_id`, `network`, `network_country`, `state`, `postcode`, `name`, `capacity_registered`, `duid_data[]` — where each `duid_data` entry carries `duid`, `fuel_tech`, `fuel_tech_label`, `fuel_tech_renewable`, `commissioned_date`, `decommissioned_date`, `status`, `status_label`.
- **`duid_data[].duid` is the join key to the AEMO registration list**, and `station_code` matches AEMO station codes. This pair — AEMO for authoritative capacity/fuel, OpenNEM for coordinates — is the complete generator reference layer.
- **Licence: UNVERIFIED this pass.** OpenNEM publishes under CC BY 4.0 by its own statement, but I did not fetch and read the licence page. Confirm before shipping commercially.

---

## Generator coordinates — ready-to-paste

All 8 requested clusters resolved from the OpenNEM dataset above (not hand-collected). `capacity_registered` in MW is included because you will want it for capacity-factor normalisation. Coordinates are the station centroid — good to ~1 km, which is well inside a weather-model grid cell.

Note the ones that genuinely split: **Hornsdale 1/2/3 share a single centroid** (one wind farm, three registered stages) while the co-located **Hornsdale Power Reserve battery sits ~3 km away**; **White Rock has a separate solar farm and wind farm ~7 km apart**; **Snowtown North and South are ~19 km apart and materially different wind regimes** — sample them separately, not as one point.

```js
// NEM/WEM generation clusters — lat/lon from OpenNEM au_facilities.json
// (https://data.opennem.org.au/v3/geo/au_facilities.json, retrieved 2026-08-24)
// duid = AEMO dispatchable unit id; join to the NEM Registration & Exemption List
// sheet "PU and Scheduled Loads" for authoritative capacity + fuel.
export const GEN_SITES = [
  { name: "Hornsdale",               region: "SA1",  fuel: "wind",    duid: "HORNSDAL",          capacityMW: 102, lat: -33.05982, lon: 138.53767 },
  { name: "Hornsdale 2",             region: "SA1",  fuel: "wind",    duid: "HORNSDAL2",         capacityMW: 102, lat: -33.05982, lon: 138.53767 },
  { name: "Hornsdale 3",             region: "SA1",  fuel: "wind",    duid: "HORNSDAL3",         capacityMW: 112, lat: -33.05982, lon: 138.53767 },
  { name: "Hornsdale Power Reserve", region: "SA1",  fuel: "battery", duid: "HORNSDPR",          capacityMW: 300, lat: -33.08552, lon: 138.52191 },
  { name: "Snowtown",                region: "SA1",  fuel: "wind",    duid: "SNOWTOWN",          capacityMW:  99, lat: -33.69160, lon: 138.16602 },
  { name: "Snowtown North",          region: "SA1",  fuel: "wind",    duid: "SNOWNTH",           capacityMW: 144, lat: -33.75648, lon: 138.14304 },
  { name: "Snowtown South",          region: "SA1",  fuel: "wind",    duid: "SNOWSTH",           capacityMW: 126, lat: -33.86262, lon: 138.13037 },
  { name: "Macarthur",               region: "VIC1", fuel: "wind",    duid: "MACARTH",           capacityMW: 420, lat: -38.04348, lon: 142.17908 },
  { name: "Sapphire",                region: "NSW1", fuel: "wind",    duid: "SAPHWF1",           capacityMW: 270, lat: -29.71027, lon: 151.44558 },
  { name: "White Rock Wind",         region: "NSW1", fuel: "wind",    duid: "WRWF1",             capacityMW: 175, lat: -29.82918, lon: 151.54539 },
  { name: "White Rock Solar",        region: "NSW1", fuel: "solar",   duid: "WRSF1",             capacityMW:  22, lat: -29.76329, lon: 151.55021 },
  { name: "Coopers Gap",             region: "QLD1", fuel: "wind",    duid: "COOPGWF",           capacityMW: 452, lat: -26.71700, lon: 151.44918 },
  { name: "Musselroe",               region: "TAS1", fuel: "wind",    duid: "MUSSELRO",          capacityMW: 168, lat: -40.77711, lon: 148.00631 },
  { name: "Collgar",                 region: "WEM",  fuel: "wind",    duid: "INVESTEC_COLLGAR",  capacityMW: 206, lat: -31.59751, lon: 118.49060 },
];
```

Feed these straight into Open-Meteo — it accepts comma-separated `latitude=`/`longitude=` for multi-point requests in one call, so all 14 sites cost one round trip. For wind sites request `wind_speed_100m`, `wind_direction_100m`, `wind_gusts_10m`, `temperature_2m`, `surface_pressure` (hub height is ~100 m, not 10 m — using `wind_speed_10m` will systematically understate output). For solar request `shortwave_radiation`, `direct_normal_irradiance`, `diffuse_radiation`, `cloud_cover`, `temperature_2m`.

---

## Blocked

### APVI live rooftop PV — needs a token

- `https://pv-map.apvi.org.au/api/v2/2-digit/2026-08-23.json` → **HTTP 401**, `application/json`, body:
  `{"error":"unauthorized","error_description":"You are not authorized. Please provide an access token"}`
- `https://pv-map.apvi.org.au/data/postcode/monthly/2026-08.json` → HTTP 500.
- `https://pv-map.apvi.org.au/live` → HTTP 200 but 1,036,249 bytes of HTML with no discoverable API path in it; `https://pv-map.apvi.org.au/about` → 404.
- **No keyless public JSON API found.** I did not create an account or request a token, per instructions. If you want APVI as an independent cross-check on AEMO's satellite estimate, someone will need to apply to APVI for API access as a deliberate, human decision — note that APVI data is generally non-commercial-friendly by default, so check the terms attached to any key before building on it.
- **Practical alternative:** the SATELLITE-vs-MEASUREMENT pair already inside AEMO's own ROOFTOP_PV/ACTUAL feed gives you a free internal cross-check, plus the `QI` field. That covers most of what APVI was wanted for.

---

## What I could not verify — read this before relying on the table

- **AEMO licence terms — UNVERIFIED for every AEMO source above.** I confirmed technical access to nemweb and the registration list, not the terms of use. AEMO market data is generally reusable with attribution, but I did not fetch and read AEMO's terms page this pass. **Do this before commercial launch** — it applies to rooftop PV, market notices, GBB, and the registration list alike, i.e. to most of Tier 2.
- **OpenNEM licence — UNVERIFIED.** CC BY 4.0 is OpenNEM's stated position but I did not read the licence page. It is the source of every coordinate in the JS array above, so confirm it.
- **DEA Hotspots CC BY 4.0 — PARTIALLY verified.** `https://www.ga.gov.au/copyright` explicitly states Geoscience Australia material is under "Creative Commons Attribution 4.0 International Licence" / "CC BY 4.0", and hotspots.dea.ga.gov.au is a GA property. But the hotspots site's own `/about` and `/copyright` pages are client-rendered and returned no readable licence text to curl, so I could not confirm a *product-specific* statement. Treat as CC BY 4.0 with attribution, but have someone open the site in a real browser to confirm.
- **Market notice type distribution — UNVERIFIED.** Only one notice (`NON-CONFORMANCE`) was parsed end to end. The header envelope is presumably identical across types but I have not proven it. Sample 50 notices across the 60-day window before writing the parser's type handling.
- **Exact file counts are approximate.** The nemweb IIS listing repeats each filename in its HTML, so my href counts (1,345 ACTUAL / 673 FORECAST / 575 Market_Notice / 74 GBB) are roughly 2x the true file count for the report directories. Retention estimates (~7 days rooftop, ~60 days notices) follow from that halving plus the observed date stamps, and are consistent, but I did not enumerate precisely.
- **GBB cadence inferred, not observed over time.** I saw one snapshot of `LastUpdated` values, not a time series of them. "Daily with a multi-day revision tail for actuals" is a reasonable read of those timestamps but should be confirmed by logging the files for a week.
- **`Reports/Current/Generic_Reports/` does not exist** — HTTP 404. The registration list is not there; use the `aemo.com.au/-/media/...` path documented above.
- **The AEMO Generation Information workbook was not located.** `https://www.aemo.com.au/-/media/files/electricity/nem/planning_and_forecasting/generation_information/2026/generation-information-file.xlsx` → 404. It moves per-release and I stopped rather than burn the call budget guessing paths. It is the one AEMO product that *does* carry coordinates plus committed-project pipeline data, so it is worth a manual look at the AEMO Generation Information page — but OpenNEM already covers the coordinate need for operating plant.
