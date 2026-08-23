#!/usr/bin/env node
/**
 * AEMO real-time collector
 * ------------------------------------------------------------------
 * Pulls the three live AEMO feeds and appends NEW, de-duplicated rows
 * to CSV archives under ./data. Designed to be run repeatedly (every
 * ~5 min via Windows Task Scheduler) — re-runs never duplicate data.
 *
 * Usage:
 *   node collect.js                 # collect all sources
 *   node collect.js dispatch wem    # collect only named sources
 *   node collect.js --scada         # also pull WEM facility generation (heavy)
 *
 * Sources: dispatch | predispatch | wem   (+ optional scada)
 * No external dependencies. Node 18+ (uses global fetch).
 */
"use strict";
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const STATE_FILE = path.join(DATA_DIR, "_state.json");
const LOG_FILE = path.join(DATA_DIR, "collect.log");
const LATEST_FILE = path.join(DATA_DIR, "latest.json");
const TIMEOUT_MS = 30000;
const WEM_SEED_MAX = 288;          // on first run, seed at most this many WEM intervals
const REGIONS = ["NSW1", "QLD1", "SA1", "TAS1", "VIC1"];

/* ----------------------------- utilities ----------------------------- */
function ensureDir() { fs.mkdirSync(DATA_DIR, { recursive: true }); }
function nowISO() { return new Date().toISOString(); }
function log(msg) {
  const line = `[${nowISO()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch (e) {}
}
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch (e) { return {}; }
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

async function getJSON(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}
async function getText(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!r.ok && r.status !== 206) throw new Error("HTTP " + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}
// minimal CSV parser (handles quoted fields)
function parseCSV(text) {
  const rows = []; let i = 0, f = "", row = [], q = false;
  while (i < text.length) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else {
      if (c === '"') q = true;
      else if (c === ",") { row.push(f); f = ""; }
      else if (c === "\n") { row.push(f); rows.push(row); f = ""; row = []; }
      else if (c !== "\r") f += c;
    }
    i++;
  }
  if (f.length || row.length) { row.push(f); rows.push(row); }
  return rows;
}
function csvCell(v) {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
// append rows (array of arrays) to a CSV, writing the header only when the file is new
function appendRows(file, header, rows) {
  if (!rows.length) return 0;
  const fresh = !fs.existsSync(file);
  // If the file already exists its header must match. Appending a widened schema
  // under an old header silently misaligns every column from that point on, and
  // the damage stays invisible until someone tries to model the data later.
  if (!fresh) {
    const nl = String.fromCharCode(10);
    const existing = fs.readFileSync(file, "utf8").split(nl, 1)[0].trim();
    const want = header.map(csvCell).join(",");
    if (existing !== want) {
      throw new Error("schema drift in " + path.basename(file) +
        ": file header is" + nl + "  " + existing + nl + "but collector wants" + nl + "  " + want +
        nl + "Migrate the file (or move it aside) before collecting.");
    }
  }
  let out = fresh ? header.map(csvCell).join(",") + "\n" : "";
  out += rows.map(r => r.map(csvCell).join(",")).join("\n") + "\n";
  fs.appendFileSync(file, out);
  return rows.length;
}

/* ----------------------------- sources ----------------------------- */

// 1) NEM Dispatch — 5-min regional actuals
async function collectDispatch(state, latest) {
  const j = await getJSON(
    "https://visualisations.aemo.com.au/aemo/apps/api/report/ELEC_NEM_SUMMARY",
    { headers: { accept: "application/json" } }
  );
  const rows = j.ELEC_NEM_SUMMARY || [];
  latest.dispatch = { fetched_at: nowISO(), rows };
  const sd = rows[0] && rows[0].SETTLEMENTDATE;
  const st = state.dispatch || {};
  if (sd && sd === st.lastSD) { log(`dispatch: no new interval (${sd})`); return 0; }
  // PRICE_STATUS / APCFLAG / MARKETSUSPENDEDFLAG are the regime markers (firm vs
  // administered pricing, market suspension). They are what separates a normal
  // interval from the rare ones a forecast has to stay calibrated through, so
  // they are archived even though they are constant almost all of the time.
  const header = ["fetched_at", "SETTLEMENTDATE", "REGIONID", "PRICE", "PRICE_STATUS",
    "APCFLAG", "MARKETSUSPENDEDFLAG", "TOTALDEMAND",
    "SCHEDULEDGENERATION", "SEMISCHEDULEDGENERATION", "NETINTERCHANGE"];
  const at = nowISO();
  const out = rows.map(r => [at, r.SETTLEMENTDATE, r.REGIONID, r.PRICE, r.PRICE_STATUS,
    r.APCFLAG, r.MARKETSUSPENDEDFLAG, r.TOTALDEMAND,
    r.SCHEDULEDGENERATION, r.SEMISCHEDULEDGENERATION, r.NETINTERCHANGE]);
  const n = appendRows(path.join(DATA_DIR, "nem_dispatch.csv"), header, out);

  // INTERCONNECTORFLOWS arrives as a JSON *string* nested inside each region row,
  // one record per link with the flow and both directional limits. Flow against
  // limit is constraint-binding proximity — the network state the price depends
  // on — so it goes to its own long-format file rather than being discarded.
  const icHeader = ["fetched_at", "SETTLEMENTDATE", "REGIONID", "INTERCONNECTORID",
    "MWFLOW", "EXPORTLIMIT", "IMPORTLIMIT"];
  const icRows = [];
  for (const r of rows) {
    let links = [];
    try { links = JSON.parse(r.INTERCONNECTORFLOWS || "[]"); } catch (e) { continue; }
    for (const l of links) {
      icRows.push([at, r.SETTLEMENTDATE, r.REGIONID, l.name, l.value, l.exportlimit, l.importlimit]);
    }
  }
  const ni = appendRows(path.join(DATA_DIR, "nem_interconnectors.csv"), icHeader, icRows);

  state.dispatch = { lastSD: sd };
  log(`dispatch: +${n} rows, +${ni} interconnector rows @ ${sd}`);
  return n + ni;
}

// 2) NEM Pre-dispatch — capture each new FORECAST vintage (tagged with issue time)
async function collectPredispatch(state, latest) {
  const j = await getJSON(
    "https://visualisations.aemo.com.au/aemo/apps/api/report/5MIN",
    { method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ timeScale: ["30MIN"] }) }
  );
  const rows = j["5MIN"] || [];
  const actuals = rows.filter(r => r.PERIODTYPE === "ACTUAL");
  const forecasts = rows.filter(r => r.PERIODTYPE === "FORECAST");
  // "issue" = the most recent ACTUAL timestamp = the boundary the forecast was cut from
  const issue = actuals.reduce((m, r) => r.SETTLEMENTDATE > m ? r.SETTLEMENTDATE : m, "");
  latest.predispatch = { fetched_at: nowISO(), issue, n_actual: actuals.length, n_forecast: forecasts.length,
    forecast: forecasts };
  const st = state.predispatch || {};
  if (issue && issue === st.lastIssue) { log(`predispatch: no new vintage (${issue})`); return 0; }
  const header = ["issue", "fetched_at", "SETTLEMENTDATE", "REGIONID", "RRP", "TOTALDEMAND",
    "NETINTERCHANGE", "SCHEDULEDGENERATION", "SEMISCHEDULEDGENERATION"];
  const at = nowISO();
  const out = forecasts.map(r => [issue, at, r.SETTLEMENTDATE, r.REGIONID, r.RRP, r.TOTALDEMAND,
    r.NETINTERCHANGE, r.SCHEDULEDGENERATION, r.SEMISCHEDULEDGENERATION]);
  const n = appendRows(path.join(DATA_DIR, "nem_predispatch_forecast.csv"), header, out);
  state.predispatch = { lastIssue: issue };
  log(`predispatch: +${n} forecast rows, vintage ${issue}`);
  return n;
}

// 3) WEM — 5-min energy + ancillary clearing prices (newest-first CSV, Range-fetched)
async function collectWEM(state, latest) {
  const yr = new Date().getFullYear();
  const base = "https://data.wa.aemo.com.au/public/public-data/datafiles/market-clearing-prices-csv/";
  let text;
  try { text = await getText(base + `MarketClearingPrices-${yr}.csv`, { headers: { Range: "bytes=0-300000" } }); }
  catch (e) { text = await getText(base + `MarketClearingPrices-${yr - 1}.csv`, { headers: { Range: "bytes=0-300000" } }); }
  const rows = parseCSV(text);
  const head = rows[0].map(h => h.trim());
  const idx = {}; head.forEach((h, i) => idx[h] = i);
  // drop a possibly-truncated final line from the range fetch
  const body = rows.slice(1).filter(r => r.length >= head.length && r[idx["Dispatch Interval"]]);
  const st = state.wem || {};
  const last = st.lastInterval || "";
  // rows are newest-first; keep those strictly newer than last seen
  let fresh = [];
  for (const r of body) {
    const di = r[idx["Dispatch Interval"]];
    if (di === last) break;
    fresh.push(r);
  }
  if (!last) fresh = fresh.slice(0, WEM_SEED_MAX);   // seed cap on first run
  latest.wem = { fetched_at: nowISO(), latest: body[0] ? Object.fromEntries(head.map((h, i) => [h, body[0][i]])) : null };
  if (!fresh.length) { log(`wem: no new interval (${body[0] && body[0][idx["Dispatch Interval"]]})`); return 0; }
  const cols = ["Dispatch Interval", "Energy Clearing Price", "Regulation Raise Clearing Price",
    "Regulation Lower Clearing Price", "Contingency Raise Clearing Price", "Contingency Lower Clearing Price",
    "RoCoF Clearing Price"];
  const header = ["fetched_at", ...cols];
  const at = nowISO();
  // append oldest-first so the archive reads chronologically
  const out = fresh.reverse().map(r => [at, ...cols.map(c => r[idx[c]])]);
  const n = appendRows(path.join(DATA_DIR, "wem_prices.csv"), header, out);
  state.wem = { lastInterval: body[0][idx["Dispatch Interval"]] };
  log(`wem: +${n} rows, newest ${state.wem.lastInterval}`);
  return n;
}

// optional) WEM facility generation snapshot (heavy ~19MB; --scada only)
async function collectSCADA(state, latest) {
  const d = new Date(), mm = String(d.getMonth() + 1).padStart(2, "0");
  const url = `https://data.wa.aemo.com.au/public/public-data/datafiles/facility-scada-csv/FacilityScada-${d.getFullYear()}-${mm}.csv`;
  const text = await getText(url, { headers: { Range: "bytes=0-600000" } }); // newest-first
  const rows = parseCSV(text);
  const head = rows[0].map(h => h.trim());
  const iT = head.indexOf("Dispatch Interval"), iF = head.indexOf("Facility Code"), iM = head.indexOf("Average MWh");
  const body = rows.slice(1).filter(r => r.length >= 3 && r[iT]);
  const latestT = body[0] && body[0][iT];
  const st = state.scada || {};
  if (!latestT || latestT === st.lastInterval) { log(`scada: no new interval (${latestT})`); return 0; }
  const snap = body.filter(r => r[iT] === latestT);
  const header = ["fetched_at", "Dispatch Interval", "Facility Code", "Average MWh"];
  const at = nowISO();
  const out = snap.map(r => [at, r[iT], r[iF], r[iM]]);
  const n = appendRows(path.join(DATA_DIR, "wem_facility_scada.csv"), header, out);
  state.scada = { lastInterval: latestT };
  log(`scada: +${n} facility rows @ ${latestT}`);
  return n;
}

/* ----------------------------- main ----------------------------- */
const ALL = { dispatch: collectDispatch, predispatch: collectPredispatch, wem: collectWEM };

(async function main() {
  ensureDir();
  const args = process.argv.slice(2);
  const wantScada = args.includes("--scada");
  const named = args.filter(a => !a.startsWith("--"));
  const jobs = named.length ? named.filter(k => ALL[k]) : Object.keys(ALL);
  if (wantScada) jobs.push("scada");

  const state = loadState();
  const latest = fs.existsSync(LATEST_FILE) ? JSON.parse(fs.readFileSync(LATEST_FILE, "utf8")) : {};
  let total = 0;
  for (const job of jobs) {
    const fn = job === "scada" ? collectSCADA : ALL[job];
    try { total += await fn(state, latest); }
    catch (e) { log(`${job}: ERROR ${e.message}`); }
  }
  latest._collected_at = nowISO();
  fs.writeFileSync(LATEST_FILE, JSON.stringify(latest, null, 2));
  saveState(state);
  log(`run complete: ${total} new rows across [${jobs.join(", ")}]`);
})();
