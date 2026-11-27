// Server frontend produksi: menyajikan hasil `npm run build:prod` (folder dist) tanpa Vite sama sekali.
// Tanpa dependensi, cukup Node 18+. Biasanya dijalankan oleh scripts/prod-all.mjs (bersama server game);
// sendiri: `npm run start:web`.
//
// Env (semua opsional):
//   PORT=8000             port (default 8000)
//   HOST=0.0.0.0          alamat bind
//   PB_DIST=dist          folder hasil build
//   PB_PUBLIC_ASSETS=1    sajikan /assets/* dari public/assets bila tidak ada di dist
//                         (build:prod tidak menyalin public/assets; di produksi biasanya dari R2 via VITE_ASSET_BASE)
//   PB_API_HOST=127.0.0.1  server game/web (scripts/prod-all.mjs "server"): /api, /signal, /tcp (http + WebSocket)
//   PB_API_PORT=8090       diteruskan (reverse proxy) ke sini, jadi klien cukup memakai origin yang sama

import { createServer, request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import { createReadStream, existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompress, gzip, constants } from "node:zlib";
import { promisify } from "node:util";

const brotli = promisify(brotliCompress);
const gz = promisify(gzip);

const PORT = Number(process.env.PORT) || 8000;
const HOST = process.env.HOST || "0.0.0.0";
// Folder dihitung dari root repo (bukan dari cwd), jadi aman dijalankan dari mana saja / lewat scripts/prod-all.mjs.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = resolve(ROOT, process.env.PB_DIST || "dist");
const PUBLIC = resolve(ROOT, "public");
const SERVE_PUBLIC_ASSETS = process.env.PB_PUBLIC_ASSETS === "1";
const API_HOST = process.env.PB_API_HOST || "127.0.0.1";
const API_PORT = Number(process.env.PB_API_PORT) || 8090;

/** path yang diteruskan ke server game/web: /api (http), /signal dan /tcp (http / WebSocket) */
const isProxied = (url) => /^\/(api|signal|tcp)(?:[/?]|$)/.test(url || "");

function proxyHttp(req, res) {
  const up = httpRequest({
    host: API_HOST, port: API_PORT, method: req.method, path: req.url,
    headers: { ...req.headers, "x-forwarded-for": req.socket.remoteAddress || "", "x-forwarded-host": req.headers.host || "" },
  }, (r) => {
    res.writeHead(r.statusCode || 502, r.headers);
    r.pipe(res);
  });
  up.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("Bad Gateway");
  });
  res.on("close", () => up.destroy());
  req.pipe(up);
}

if (!existsSync(join(DIST, "index.html"))) {
  console.error(`[serve-prod] ${join(DIST, "index.html")} tidak ditemukan. Jalankan dulu: npm run build:prod`);
  process.exit(1);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".cur": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

const COMPRESSIBLE = new Set([".html", ".js", ".mjs", ".css", ".json", ".webmanifest", ".txt", ".svg"]);
const zCache = new Map(); // `${file}|${enc}|${mtimeMs}` -> Buffer

/** Cari file nyata di salah satu root; aman dari path traversal. */
function findFile(pathname, roots) {
  let p;
  try {
    p = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (p.includes("\0")) return null;
  for (const root of roots) {
    const full = normalize(join(root, p));
    if (full !== root && !full.startsWith(root + sep)) continue;
    try {
      if (statSync(full).isFile()) return full;
    } catch {
      /* lanjut ke root berikutnya */
    }
  }
  return null;
}

function cacheControl(pathname, ext) {
  if (pathname.startsWith("/bundle/")) return "public, max-age=31536000, immutable"; // nama file ber-hash
  // index.html, service worker (sw.js) dan manifest tidak ber-hash: harus selalu dicek ulang agar deploy baru langsung terpakai
  if (ext === ".html" || ext === ".webmanifest" || pathname === "/sw.js") return "no-cache";
  if (pathname.startsWith("/assets/")) return "public, max-age=86400";
  return "public, max-age=3600";
}

async function send(req, res, file, pathname) {
  const st = statSync(file);
  const ext = extname(file).toLowerCase();
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const headers = {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Cache-Control": cacheControl(pathname, ext),
    ETag: etag,
    "Last-Modified": st.mtime.toUTCString(),
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
  };

  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }

  // Kompresi (br/gzip) untuk file teks; hasilnya di-cache di memori.
  if (COMPRESSIBLE.has(ext) && st.size > 1024 && !req.headers.range) {
    headers.Vary = "Accept-Encoding";
    const accept = String(req.headers["accept-encoding"] || "");
    const enc = /\bbr\b/.test(accept) ? "br" : /\bgzip\b/.test(accept) ? "gzip" : null;
    if (enc) {
      const key = `${file}|${enc}|${st.mtimeMs}`;
      let buf = zCache.get(key);
      if (!buf) {
        const raw = await readFile(file);
        buf = enc === "br"
          ? await brotli(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } })
          : await gz(raw, { level: 6 });
        zCache.set(key, buf);
      }
      headers["Content-Encoding"] = enc;
      headers["Content-Length"] = buf.length;
      res.writeHead(200, headers);
      return res.end(req.method === "HEAD" ? undefined : buf);
    }
  }

  // Range (audio/video/aset besar).
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ""));
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : st.size - Number(m[2]);
    let end = m[1] && m[2] ? Number(m[2]) : st.size - 1;
    end = Math.min(end, st.size - 1);
    if (start < 0 || start > end) {
      res.writeHead(416, { "Content-Range": `bytes */${st.size}` });
      return res.end();
    }
    headers["Content-Range"] = `bytes ${start}-${end}/${st.size}`;
    headers["Content-Length"] = end - start + 1;
    res.writeHead(206, headers);
    if (req.method === "HEAD") return res.end();
    return createReadStream(file, { start, end }).pipe(res);
  }

  headers["Content-Length"] = st.size;
  res.writeHead(200, headers);
  if (req.method === "HEAD") return res.end();
  createReadStream(file).pipe(res);
}

const server = createServer(async (req, res) => {
  try {
    if (isProxied(req.url)) return proxyHttp(req, res);

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" });
      return res.end();
    }

    const pathname = new URL(req.url || "/", "http://x").pathname;

    if (pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("ok");
    }

    // /assets/*: file ada di dist atau (opsional) public; kalau tidak ada = 404 asli, bukan index.html.
    if (pathname.startsWith("/assets/")) {
      const f = findFile(pathname, SERVE_PUBLIC_ASSETS ? [DIST, PUBLIC] : [DIST]);
      if (!f) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        return res.end("Not Found");
      }
      return await send(req, res, f, pathname);
    }

    const file = findFile(pathname, [DIST]);
    if (file) return await send(req, res, file, pathname);

    // Path berekstensi yang tidak ada = 404; selain itu fallback SPA ke index.html.
    if (extname(pathname)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Not Found");
    }
    return await send(req, res, join(DIST, "index.html"), "/index.html");
  } catch (err) {
    console.error("[serve-prod]", err);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Internal Server Error");
  }
});

// WebSocket (/tcp, /signal): sambungkan soket klien langsung ke server game/web.
server.on("upgrade", (req, socket, head) => {
  if (!isProxied(req.url)) return socket.destroy();
  const up = netConnect(API_PORT, API_HOST, () => {
    let raw = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    up.write(raw + "\r\n");
    if (head.length) up.write(head);
    socket.pipe(up).pipe(socket);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
  socket.on("close", () => up.destroy());
  up.on("close", () => socket.destroy());
});

server.listen(PORT, HOST, () => {
  console.log(`[serve-prod] ${DIST} -> http://${HOST}:${PORT}${SERVE_PUBLIC_ASSETS ? " (+ public/assets)" : ""}  | /api /signal /tcp -> ${API_HOST}:${API_PORT}`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}