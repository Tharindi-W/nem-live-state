#!/usr/bin/env node
/* Minimal static server for local development.
 * Supports Range requests, because the dashboard tail-fetches the CSV archives
 * the same way collect.js does and a server without Range would break that. */
"use strict";
const http = require("http"), fs = require("fs"), path = require("path");
const PORT = +(process.argv[2] || 4173), ROOT = __dirname;
const TYPES = {".html":"text/html;charset=utf-8",".js":"text/javascript",".json":"application/json",
  ".csv":"text/csv",".css":"text/css",".md":"text/markdown;charset=utf-8",".pdf":"application/pdf"};

http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  // strip leading separators before joining, so a crafted path cannot escape ROOT
  let rel = path.normalize(p);
  while (rel.length && (rel[0] === "/" || rel[0] === "\\")) rel = rel.slice(1);
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end("forbidden"); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end("not found"); return; }
    const type = TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m[1] ? +m[1] : 0, end = m[2] ? +m[2] : st.size - 1;
      if (end >= st.size) end = st.size - 1;
      res.writeHead(206, {"content-type":type,"accept-ranges":"bytes",
        "content-range":`bytes ${start}-${end}/${st.size}`,"content-length":end-start+1});
      fs.createReadStream(file,{start,end}).pipe(res);
    } else {
      res.writeHead(200,{"content-type":type,"accept-ranges":"bytes","content-length":st.size});
      fs.createReadStream(file).pipe(res);
    }
  });
}).listen(PORT, () => console.log("serving " + ROOT + " on http://localhost:" + PORT));
