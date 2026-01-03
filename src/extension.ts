import * as vscode from "vscode";
import express from "express";
import http from "http";
import type { Server } from "http";
import chokidar from "chokidar";
import path from "path";

const ssi = require("ssi-middleware");

let server: Server | undefined;
let watcher: chokidar.FSWatcher | undefined;
let pingTimer: NodeJS.Timeout | undefined;
let reloadTimer: NodeJS.Timeout | undefined;
const clients = new Set<express.Response>();
let boundHost: string | undefined;
let boundPort: number | undefined;

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand("localSsiServer.start", async () => {
      const ws = vscode.workspace.workspaceFolders?.[0];
      if (!ws) {
        vscode.window.showErrorMessage("Open a folder first.");
        return;
      }

      const cfg = vscode.workspace.getConfiguration("localSsiServer");
      const entry = normalizeEntry(cfg.get<string>("entry", "index.html"));
      const openIn = cfg.get<string>("openIn", "vscode");
      const host = cfg.get<string>("host", "127.0.0.1");
      const liveReload = cfg.get<boolean>("liveReload", true);
      const liveReloadDelay = cfg.get<number>("liveReloadDelay", 150);

      if (server && boundPort && boundHost) {
        await openUrl(makeUrl(boundHost, boundPort, entry), openIn);
        return;
      }

      const root = ws.uri.fsPath;
      const port = await getFreePort(host);

      const app = express();

      if (liveReload) {
        app.get("/__local_ssi_server__/events", (req, res) => {
          res.status(200);
          res.setHeader("Content-Type", "text/event-stream");
          res.setHeader("Cache-Control", "no-cache, no-transform");
          res.setHeader("Connection", "keep-alive");
          (res as any).flushHeaders?.();
          res.write("retry: 1000\n\n");
          clients.add(res);
          req.on("close", () => {
            clients.delete(res);
          });
        });

        app.use(createHtmlInjectionMiddleware());
      }

      app.use(
        ssi({
          baseDir: root,
          baseUrl: `http://${host}:${port}`,
          request: { strictSSL: false }
        })
      );

      app.use(express.static(root));

      server = app.listen(port, host, async () => {
        boundHost = host;
        boundPort = port;
        if (liveReload) startWatching(root, liveReloadDelay);
        vscode.window.showInformationMessage(`Local SSI Server running at http://${host}:${port}`);
        await openUrl(makeUrl(host, port, entry), openIn);
      });

      context.subscriptions.push({ dispose: stopServer });
    }),

    vscode.commands.registerCommand("localSsiServer.stop", async () => {
      stopServer();
      vscode.window.showInformationMessage("Local SSI Server stopped.");
    })
  );
}

export function deactivate() {
  stopServer();
}

function stopServer() {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = undefined;

  if (pingTimer) clearInterval(pingTimer);
  pingTimer = undefined;

  if (watcher) watcher.close();
  watcher = undefined;

  for (const res of clients) {
    try {
      res.end();
    } catch {}
  }
  clients.clear();

  if (server) server.close();
  server = undefined;
  boundHost = undefined;
  boundPort = undefined;
}

function normalizeEntry(entry: string) {
  const trimmed = entry.trim().replace(/^\/+/, "");
  return trimmed.length ? trimmed : "index.html";
}

function makeUrl(host: string, port: number, entry: string) {
  return `http://${host}:${port}/${entry}`;
}

async function openUrl(url: string, openIn: string) {
  if (openIn === "external") {
    await vscode.env.openExternal(vscode.Uri.parse(url));
    return;
  }

  try {
    await vscode.commands.executeCommand("simpleBrowser.show", url);
  } catch {
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }
}

function getFreePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, host, () => {
      const addr = s.address();
      s.close(() => {
        if (addr && typeof addr === "object") resolve(addr.port);
        else reject(new Error("No free port"));
      });
    });
    s.on("error", reject);
  });
}

function startWatching(root: string, delayMs: number) {
  if (watcher) return;

  watcher = chokidar.watch(root, {
    ignoreInitial: true,
    ignored: [
      /[\\/]node_modules[\\/]/,
      /[\\/]\.git[\\/]/,
      /[\\/]out[\\/]/,
      /[\\/]\.vscode[\\/]/
    ]
  });

  watcher.on("all", () => scheduleReload(delayMs));

  pingTimer = setInterval(() => {
    for (const res of clients) {
      try {
        res.write(":ping\n\n");
      } catch {}
    }
  }, 25000);
}

function scheduleReload(delayMs: number) {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    for (const res of clients) {
      try {
        res.write("data: reload\n\n");
      } catch {}
    }
  }, Math.max(0, delayMs));
}

function createHtmlInjectionMiddleware(): express.RequestHandler {
  return (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (req.path.startsWith("/__local_ssi_server__/")) return next();

    const ext = path.extname(req.path).toLowerCase();
    const wantsHtml =
      ext === ".html" ||
      ext === ".htm" ||
      ext === ".shtml" ||
      ext === "" ||
      String(req.headers.accept || "").includes("text/html");

    if (!wantsHtml) return next();

    const chunks: Buffer[] = [];
    const origEnd = res.end.bind(res);

    (res as any).write = (chunk: any, encoding?: any, cb?: any) => {
      if (chunk !== undefined && chunk !== null) {
        const enc = typeof encoding === "string" ? encoding : "utf8";
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), enc));
      }
      if (typeof cb === "function") cb();
      return true;
    };

    res.end = ((chunk?: any, encoding?: any, cb?: any) => {
      if (chunk !== undefined && chunk !== null) {
        const enc = typeof encoding === "string" ? encoding : "utf8";
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), enc));
      }

      const body = Buffer.concat(chunks);
      const text = body.toString("utf8");
      const ct = String(res.getHeader("Content-Type") || "");
      const isHtml = ct.includes("text/html") || looksLikeHtml(text);

      if (!isHtml) {
        res.removeHeader("Content-Length");
        return origEnd(body, cb);
      }

      const out = injectLiveReload(text);
      if (!ct) res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.removeHeader("Content-Length");
      return origEnd(out, "utf8", cb);
    }) as any;

    next();
  };
}

function looksLikeHtml(text: string) {
  const t = text.toLowerCase();
  return t.includes("<!doctype html") || t.includes("<html") || t.includes("<body");
}

function injectLiveReload(html: string) {
  const marker = "data-local-ssi-server-livereload";
  if (html.includes(marker)) return html;

  const snippet =
    `<script ${marker}>(function(){try{var es=new EventSource('/__local_ssi_server__/events');es.onmessage=function(){location.reload();};}catch(e){}})();</script>`;

  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, snippet + "</body>");
  if (/<\/html>/i.test(html)) return html.replace(/<\/html>/i, snippet + "</html>");
  return html + snippet;
}
