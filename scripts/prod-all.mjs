// Supervises the production stack: npm start (from the repo root).
// Same layout as dev-all.mjs, but no vite and no file watching:
//   server -> node server/src/main.ts   (web :8090, auth ws :39290, game ws :39291-39293), restarted if it crashes
//   web    -> scripts/serve-prod.mjs    (static dist on :8000, no vite)
//
// Flags:
//   --build    always rebuild dist first (tsc --noEmit + vite build --mode prod). Without it, dist is only
//              built when it does not exist yet.
//   --docker   start postgres via docker compose (default: assume postgres is already running on :5433)
//   --assets   serve /assets/* from public/assets (build:prod leaves them out of dist). Automatic when dist has no
//              asset-map preload (VITE_ASSET_BASE / R2 not used) and public/assets exists; PB_PUBLIC_ASSETS=1 also works.
//   --status   show which process holds each port, then exit (npm run start:status)
// Env: PB_WEB_PORT (default 8000) = port of the static frontend.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  belongsToRepo, color, cwdOf, ensurePortFree, killTree, pidOnPort, prefixedPipe,
} from './lib/procs.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptsDir, '..');
const repoKey = root.replace(/\\/g, '/').toLowerCase();
const dbDir = resolve(root, 'db');
const serverDir = resolve(root, 'server');
const distIndex = resolve(root, process.env.PB_DIST || 'dist', 'index.html');

const POSTGRES_PORT = 5433;
const WEB_PORT = Number(process.env.PB_WEB_PORT) || 8000;

// Production env: no dev-ops flag (dev-all sets PB_DEV_OPS=1), NODE_ENV=production unless already set.
const baseEnv = { ...process.env };
delete baseEnv.PB_DEV_OPS;
baseEnv.NODE_ENV ??= 'production';
baseEnv.PB_LOG_QUIET ??= '1'; // quiet server log (server/src/logFilter.ts); PB_LOG_QUIET=0 brings the full log back

const SERVICES = [
  {
    name: 'server', ports: [8090, 39290, 39291, 39292, 39293], cwd: serverDir,
    cmd: process.execPath, args: ['src/main.ts'], restart: true,
    env: baseEnv,
  },
  {
    name: 'web', ports: [WEB_PORT], cwd: root,
    cmd: process.execPath, args: [resolve(scriptsDir, 'serve-prod.mjs')], restart: true,
    // PORT only for the static server; the game server keeps its own env untouched.
    env: { ...baseEnv, PORT: String(WEB_PORT) },
  },
];

function bin(dir, rel) {
  return resolve(dir, 'node_modules', rel);
}

async function statusCmd() {
  const useDocker = process.argv.includes('--docker');
  console.log('port    service    pid     command');
  const pgPid = pidOnPort(POSTGRES_PORT);
  console.log(`${String(POSTGRES_PORT).padEnd(6)} ${'postgres'.padEnd(10)} ${pgPid === null ? '-      (free)' : `${String(pgPid).padEnd(6)} ${useDocker ? 'docker' : 'local'}`}`);
  for (const s of SERVICES) {
    for (const port of s.ports) {
      const pid = pidOnPort(port);
      if (pid === null) { console.log(`${String(port).padEnd(6)} ${s.name.padEnd(10)} -      (free)`); continue; }
      const inRepo = belongsToRepo(pid, repoKey);
      const desc = `cwd: ${cwdOf(pid) || '?'}`;
      console.log(`${String(port).padEnd(6)} ${s.name.padEnd(10)} ${String(pid).padEnd(6)} ${inRepo ? desc : `${desc}  [NOT this repo]`}`);
    }
  }
}

function pgReady() {
  try {
    execFileSync('docker', ['compose', '-p', 'pbwebport', '-f', 'docker-compose.yml', 'exec', '-T', 'postgres', 'pg_isready', '-h', '127.0.0.1', '-U', process.env.PB_DB_USER || 'postgres', '-d', process.env.PB_DB_NAME || 'pb'], { cwd: dbDir, stdio: 'ignore' });
    return true;
  } catch { return false; }
}

async function waitPgReady(timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (!pgReady()) {
    if (Date.now() > deadline) throw new Error(`postgres not ready after ${timeoutMs / 1000}s (see: docker compose -p pbwebport logs postgres)`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function startPostgres() {
  console.log(color('sup', '[sup] starting postgres (docker compose -p pbwebport up -d postgres)...'));
  try {
    execFileSync('docker', ['compose', '-p', 'pbwebport', '-f', 'docker-compose.yml', 'up', '-d', 'postgres'], {
      cwd: dbDir, stdio: 'inherit',
    });
  } catch (e) {
    console.error(color('sup', `[sup] docker compose failed: ${e.message}`));
    process.exit(1);
  }
  console.log(color('sup', `[sup] waiting for postgres on :${POSTGRES_PORT}...`));
  try {
    await waitPgReady();
  } catch (e) {
    console.error(color('sup', `[sup] ${e.message}`));
    process.exit(1);
  }
  console.log(color('sup', '[sup] postgres up'));
}

function buildFrontend() {
  console.log(color('sup', '[sup] building frontend (tsc --noEmit + vite build --mode prod)...'));
  try {
    execFileSync(process.execPath, [bin(root, 'typescript/bin/tsc'), '--noEmit'], { cwd: root, stdio: 'inherit' });
    execFileSync(process.execPath, [bin(root, 'vite/bin/vite.js'), 'build', '--mode', 'prod'], { cwd: root, stdio: 'inherit' });
  } catch {
    console.error(color('sup', '[sup] frontend build failed, not starting'));
    process.exit(1);
  }
  console.log(color('sup', '[sup] frontend build done'));
}

function startService(svc) {
  const child = spawn(svc.cmd, svc.args, {
    cwd: svc.cwd,
    env: svc.env,
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  return child;
}

async function main() {
  if (process.argv.includes('--status')) return statusCmd();

  if (process.argv.includes('--docker')) {
    await startPostgres();
  } else {
    console.log(color('sup', `[sup] skipping docker (default), assuming postgres is running on port ${POSTGRES_PORT}...`));
  }

  // Fail fast with a clear message instead of an endless restart loop when a file is missing.
  for (const svc of SERVICES) {
    const entry = isAbsolute(svc.args[0]) ? svc.args[0] : resolve(svc.cwd, svc.args[0]);
    if (!existsSync(entry)) {
      console.error(color('sup', `[sup] ${svc.name}: file not found: ${entry}`));
      process.exit(1);
    }
  }

  if (process.argv.includes('--build') || !existsSync(distIndex)) buildFrontend();

  for (const svc of SERVICES) for (const port of svc.ports) await ensurePortFree(svc.name, port, repoKey);

  // /assets/*: from R2 when the build used VITE_ASSET_BASE (index.html preloads the asset map), otherwise from public/assets.
  let r2 = false;
  try { r2 = readFileSync(distIndex, 'utf8').includes('rel="preload" as="fetch" crossorigin'); } catch { /* no dist yet */ }
  const localAssets = process.argv.includes('--assets') || process.env.PB_PUBLIC_ASSETS === '1' || (!r2 && existsSync(resolve(root, 'public/assets')));
  if (localAssets) {
    SERVICES.find((s) => s.name === 'web').env.PB_PUBLIC_ASSETS = '1';
    console.log(color('sup', '[sup] /assets/* served from public/assets'));
  }

  console.log(color('sup', '[sup] starting production services...'));
  console.log(color('sup', `[sup]    game:    http://localhost:${WEB_PORT}/   (static dist, no vite)`));
  console.log(color('sup', '[sup]    web:     ws://localhost:8090/  (/tcp /signal, http /api)'));
  console.log(color('sup', `[sup]    auth ws:  :39290    game ws: :39291-39293    postgres: :${POSTGRES_PORT}`));

  let shuttingDown = false;
  const procs = new Map();

  function launch(svc, attempt = 0) {
    if (shuttingDown) return;
    const startedAt = Date.now();
    const child = startService(svc);
    procs.set(svc.name, child);
    child.on('exit', (code, signal) => {
      if (shuttingDown) return;
      console.log(color('sup', `[sup] ${svc.name} exited (code=${code} signal=${signal})`));
      if (!svc.restart) return;
      // A service that stayed up for 30s+ resets the backoff, so a one-off crash restarts fast.
      const nextAttempt = Date.now() - startedAt > 30000 ? 0 : attempt + 1;
      const delay = Math.min(5000, 300 * 2 ** Math.min(nextAttempt, 5));
      console.log(color('sup', `[sup] ${svc.name} restarting in ${delay}ms`));
      setTimeout(() => launch(svc, nextAttempt), delay);
    });
  }

  for (const svc of SERVICES) launch(svc);

  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(color('sup', '\n[sup] shutting down...'));
    for (const child of procs.values()) if (child.pid) killTree(child.pid);
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();