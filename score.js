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
 * Two things make this correct rather than approximately correct:
 *
 *  1. A pre-dispatch target is a 30-minute TRADING interval ending at
 *     the stamped time, and its true price is the mean of the six
 *     5-minute dispatch prices inside it. Comparing against the single
 *     instantaneous price at that timestamp scores a different quantity
 *     and injects bias, so truth is averaged and the number of parts
 *     found is carried through and reported.
 *
 *  2. Absolute error alone cannot tell you whether a forecast is any
 *     good, only whether the market was calm. Every horizon is also
 *     scored against persistence -- the price at the moment the
 *     forecast was cut. Skill = 1 - MAE_aemo/MAE_persist. Below zero
 *     means AEMO did worse than assuming nothing changes.
 *
 *   node score.js            # price (RRP)
 *   node score.js demand     # demand instead
 */
"use strict";
const fs = require("fs");
const path = require("path");
const DATA = path.join(__dirname, "data");
const MIN = 60000;

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
// NEM timestamps are AEST (UTC+10, no DST) and carry no zone. Appending Z parses
// them consistently; every comparison here is between two such values.
const T = s => Date.parse(String(s).replace(" ", "T") + "Z");

const BUCKETS = [
  [0, 30, "0-30 min"], [30, 60, "30-60 min"], [60, 120, "1-2 h"],
  [120, 240, "2-4 h"], [240, 480, "4-8 h"], [480, 720, "8-12 h"],
  [720, 1440, "12-24 h"], [1440, Infinity, "24 h+"],
];
const bucketOf = m => (BUCKETS.find(b => m >= b[0] && m < b[1]) || BUCKETS[BUCKETS.length - 1])[2];

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/* Truth for the 30-min trading interval ENDING at t: the mean of the six
   5-minute dispatch prices inside it. Falls back to a partial average, then to
   the instantaneous value, and reports which so a thin archive cannot be
   mistaken for a confident result. */
function truthAt(idx, region, t, minParts = 4) {
  let sum = 0, n = 0;
  for (let k = 5; k >= 0; k--) {
    const v = idx.get(region + "|" + (t - k * 5 * MIN));
    if (v != null) { sum += v; n++; }
  }
  if (n === 6) return { price: sum / n, parts: 6, mode: "full" };
  if (n >= minParts) return { price: sum / n, parts: n, mode: "partial" };
  const inst = idx.get(region + "|" + t);
  if (inst != null) return { price: inst, parts: 1, mode: "instant" };
  return null;
}

function main() {
  const isDemand = (process.argv[2] || "").toLowerCase().startsWith("d");
  const fcCol = isDemand ? "TOTALDEMAND" : "RRP";
  const unit = isDemand ? "MW" : "$/MWh";

  const fcFile = path.join(DATA, "nem_predispatch_forecast.csv");
  if (!fs.existsSync(fcFile)) { console.error("no forecast archive - run collect.js first"); process.exit(1); }

  // Prefer the dense backfilled actuals; fold in nem_dispatch.csv on top, which
  // is authoritative for the fields the 5MIN feed does not carry.
  const idx = new Map();
  let nAct = 0;
  const a5 = path.join(DATA, "nem_actual_5min.csv");
  if (fs.existsSync(a5)) {
    for (const r of readCSV(a5)) {
      const v = num(isDemand ? r.TOTALDEMAND : r.RRP);
      if (v != null) { idx.set(r.REGIONID + "|" + T(r.SETTLEMENTDATE), v); nAct++; }
    }
  }
  const dsp = path.join(DATA, "nem_dispatch.csv");
  if (fs.existsSync(dsp)) {
    for (const r of readCSV(dsp)) {
      const v = num(isDemand ? r.TOTALDEMAND : r.PRICE);
      if (v != null) { idx.set(r.REGIONID + "|" + T(r.SETTLEMENTDATE), v); nAct++; }
    }
  }

  const pairs = [];
  const modes = { full: 0, partial: 0, instant: 0 };
  let unresolved = 0;
  for (const f of readCSV(fcFile)) {
    const p = num(f[fcCol]);
    if (p == null) continue;
    const t = T(f.SETTLEMENTDATE), iss = T(f.issue);
    const mins = (t - iss) / MIN;
    if (!isFinite(mins) || mins < 0) continue;
    const tr = truthAt(idx, f.REGIONID, t);
    if (!tr) { unresolved++; continue; }
    modes[tr.mode]++;
    const persist = idx.get(f.REGIONID + "|" + iss);
    pairs.push({
      region: f.REGIONID, mins, err: p - tr.price, abs: Math.abs(p - tr.price),
      persistAbs: persist == null ? null : Math.abs(persist - tr.price),
    });
  }

  console.log(`\nAEMO pre-dispatch forecast skill - ${isDemand ? "demand" : "price"} (${unit})`);
  console.log(`actual intervals indexed ${nAct}, forecast rows matched ${pairs.length}, unresolved ${unresolved}`);
  console.log(`truth quality: ${modes.full} full 30-min averages, ${modes.partial} partial, ${modes.instant} instantaneous`);
  if (!pairs.length) { console.log("\nNothing to score yet.\n"); return; }

  const header = () => console.log(
    "\n" + "".padEnd(12) + "n".padStart(7) + "meanAE".padStart(10) + "medAE".padStart(10) +
    "p90AE".padStart(10) + "mean/med".padStart(9) + "bias".padStart(10) +
    "persist".padStart(10) + "skill".padStart(9));

  const report = (label, subset) => {
    if (!subset.length) return;
    const abs = subset.map(r => r.abs).sort((a, b) => a - b);
    const mean = abs.reduce((s, v) => s + v, 0) / abs.length;
    const med = quantile(abs, 0.5), p90 = quantile(abs, 0.9);
    const bias = subset.reduce((s, r) => s + r.err, 0) / subset.length;
    const pa = subset.filter(r => r.persistAbs != null).map(r => r.persistAbs);
    const pmae = pa.length ? pa.reduce((s, v) => s + v, 0) / pa.length : null;
    const skill = pmae ? 1 - mean / pmae : null;
    console.log(
      label.padEnd(12) + String(subset.length).padStart(7) +
      mean.toFixed(1).padStart(10) + med.toFixed(1).padStart(10) + p90.toFixed(1).padStart(10) +
      (med > 0 ? (mean / med).toFixed(1) + "x" : "-").padStart(9) +
      bias.toFixed(1).padStart(10) +
      (pmae == null ? "-" : pmae.toFixed(1)).padStart(10) +
      (skill == null ? "-" : skill.toFixed(2)).padStart(9) +
      (subset.length < 30 ? "  (thin)" : ""));
  };

  console.log("\n-- by horizon --"); header();
  for (const [, , name] of BUCKETS) report(name, pairs.filter(r => bucketOf(r.mins) === name));

  console.log("\n-- by region --"); header();
  for (const reg of [...new Set(pairs.map(r => r.region))].sort()) {
    report(reg, pairs.filter(r => r.region === reg));
  }

  console.log("\n-- all --"); header(); report("all", pairs);

  console.log("\nskill  = 1 - MAE_aemo/MAE_persistence. Below zero means the official");
  console.log("         forecast did worse than assuming the price does not change.");
  console.log("mean/med = the tail signature. The higher it is, the more the error lives");
  console.log("         in rare intervals, and the more a distributional forecast is worth.\n");
}
main();
