#!/usr/bin/env node
/**
 * Forecast skill scorer
 * ------------------------------------------------------------------
 * Joins archived AEMO pre-dispatch forecast *vintages* against what
 * actually happened, and reports AEMO's own error by horizon.
 *
 * This is the measurement the whole project rests on: until you know
 * how good the free public forecast is, "we beat AEMO" is not a claim,
 * it is a hope. Every model built later is scored against this table.
 *
 * The headline number to watch is mean AE vs median AE. On price they
 * should differ by roughly an order of magnitude, because the error
 * distribution is dominated by a handful of spike intervals. If they
 * come out close, the join or the horizon alignment is wrong.
 *
 *   node score.js            # price (RRP)
 *   node score.js demand     # demand instead
 */
"use strict";
const fs = require("fs");
const path = require("path");
const DATA = path.join(__dirname, "data");

function readCSV(file) {
  const text = fs.readFileSync(file, "utf8").trim();
  const [head, ...lines] = text.split("\n");
  const cols = head.split(",");
  return lines.filter(Boolean).map(l => {
    const f = l.split(",");
    const o = {};
    cols.forEach((c, i) => o[c] = f[i]);
    return o;
  });
}
const num = v => { const n = parseFloat(v); return isNaN(n) ? null : n; };

// horizon buckets in minutes; pre-dispatch is 30-min resolution so these
// are the natural groupings rather than the 5/15/30/60 the report asks for
const BUCKETS = [
  [0, 30, "0-30 min"], [30, 60, "30-60 min"], [60, 120, "1-2 h"],
  [120, 240, "2-4 h"], [240, 480, "4-8 h"], [480, 1440, "8-24 h"],
  [1440, 1e9, "24 h+"],
];
const bucketFor = m => (BUCKETS.find(b => m >= b[0] && m < b[1]) || BUCKETS[BUCKETS.length - 1])[2];

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

function main() {
  const target = (process.argv[2] || "price").toLowerCase();
  const isDemand = target.startsWith("d");
  const fcCol = isDemand ? "TOTALDEMAND" : "RRP";
  const acCol = isDemand ? "TOTALDEMAND" : "PRICE";
  const unit = isDemand ? "MW" : "$/MWh";

  const fcFile = path.join(DATA, "nem_predispatch_forecast.csv");
  const acFile = path.join(DATA, "nem_dispatch.csv");
  for (const f of [fcFile, acFile]) {
    if (!fs.existsSync(f)) { console.error(`missing ${f} — run collect.js first`); process.exit(1); }
  }

  // actuals keyed by settlement interval + region
  const actual = new Map();
  for (const r of readCSV(acFile)) {
    const v = num(r[acCol]);
    if (v != null) actual.set(r.SETTLEMENTDATE + "|" + r.REGIONID, v);
  }

  const forecasts = readCSV(fcFile);
  const rows = [];   // {region, horizon, err}
  let matched = 0, unmatched = 0;
  for (const f of forecasts) {
    const a = actual.get(f.SETTLEMENTDATE + "|" + f.REGIONID);
    if (a == null) { unmatched++; continue; }
    const p = num(f[fcCol]);
    if (p == null) continue;
    // both timestamps are NEM time (UTC+10, no DST) so a plain parse is a
    // like-for-like comparison even though the values are not really UTC
    const mins = (Date.parse(f.SETTLEMENTDATE + "Z") - Date.parse(f.issue + "Z")) / 60000;
    if (!isFinite(mins) || mins < 0) continue;
    matched++;
    rows.push({ region: f.REGIONID, mins, err: p - a, abs: Math.abs(p - a) });
  }

  console.log(`\nAEMO pre-dispatch forecast skill — ${isDemand ? "demand" : "price"} (${unit})`);
  console.log(`forecast rows ${forecasts.length}, matched to an actual ${matched}, no actual yet ${unmatched}`);
  if (!matched) {
    console.log("\nNothing to score yet. The archive needs forecasts whose target interval has since arrived.");
    return;
  }

  const report = (label, subset) => {
    if (!subset.length) return;
    const abs = subset.map(r => r.abs).sort((a, b) => a - b);
    const bias = subset.reduce((s, r) => s + r.err, 0) / subset.length;
    const mean = abs.reduce((s, v) => s + v, 0) / abs.length;
    const med = quantile(abs, 0.5);
    const p90 = quantile(abs, 0.9);
    const ratio = med > 0 ? (mean / med).toFixed(1) + "x" : "–";
    console.log(
      label.padEnd(12) +
      String(subset.length).padStart(7) +
      mean.toFixed(2).padStart(11) +
      med.toFixed(2).padStart(11) +
      p90.toFixed(2).padStart(11) +
      ratio.padStart(9) +
      bias.toFixed(2).padStart(11)
    );
  };
  const header = () => console.log(
    "\n" + "".padEnd(12) + "n".padStart(7) + "meanAE".padStart(11) +
    "medAE".padStart(11) + "p90AE".padStart(11) + "mean/med".padStart(9) + "bias".padStart(11)
  );

  console.log("\n── by horizon ──"); header();
  for (const [, , name] of BUCKETS) report(name, rows.filter(r => bucketFor(r.mins) === name));

  console.log("\n── by region ──"); header();
  for (const reg of [...new Set(rows.map(r => r.region))].sort()) {
    report(reg, rows.filter(r => r.region === reg));
  }

  console.log("\n── all ──"); header(); report("all", rows);
  console.log("\nmean/med is the tail signature: the higher it is, the more the error\n" +
    "lives in rare intervals, and the more a distributional forecast is worth.\n");
}
main();
