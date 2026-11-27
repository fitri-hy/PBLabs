// PB TypeScript server entry. Runs beside the .NET servers until F6:
//   node src/main.ts            -> Auth on PB_TS_AUTH_PORT (39290), Game servers on PB_TS_GAME_PORT_BASE+id (39291..),
//                                  web front (ws /tcp /signal, http /api) on PB_WEB_PORT (8090)
// Multi-VPS: one Postgres, several processes. PB_GAME_SERVER_IDS picks the system_servers rows this process hosts,
// PB_TICKET_SECRET makes the enter ticket valid on every node, system_servers.gateway tells the client where a row
// lives (GET /api/nodes). Without those env vars this file behaves exactly as the single-node server always has.
import "./logFilter.ts"; // first import: PB_LOG_QUIET=1 hides the log lines that repeat on every login
import { startAuthServer, accept as acceptAuth } from "./auth/authServer.ts";
import { startGameServers, acceptGame } from "./game/gameServer.ts";
import { startWebServer, ensureAccountSchema, type Acceptors } from "./web/webServer.ts";
import { pool, ensureServerNodeSchema } from "./db.ts";
import { config } from "./config.ts";
import { loadStaticData } from "./shared/data.ts";
import { loadShop } from "./shared/shop.ts";
import { startBugRetention } from "./game/bugReports.ts";

await loadStaticData();
await loadShop();
// system_servers.gateway is read by every server list below: add the column before the first SELECT (idempotent).
await ensureServerNodeSchema();
const gameServers = await startGameServers();
const servers = [await startAuthServer(), ...gameServers.map((g) => g.server)];
const acceptors: Acceptors = { auth: acceptAuth };
// keyed by the real system_servers id, not the array index: an add-on node hosts a subset, so the two can differ
for (const g of gameServers) acceptors[`game${g.id}`] = (sock) => acceptGame(g.id, sock);
await ensureAccountSchema();
servers.push(await startWebServer(acceptors));
startBugRetention();
console.log(`[server] up${config.nodeId ? ` (node ${config.nodeId})` : ""}: targets ${Object.keys(acceptors).join(", ")}${config.nodeGateway ? `, gateway ${config.nodeGateway}` : ""}`);
// a stray exception / rejection in a timer or a DB call must not take every session down with the process
process.on("uncaughtException", (e) => console.error("[server] uncaughtException:", e));
process.on("unhandledRejection", (e) => console.error("[server] unhandledRejection:", e));
const stop = () => { for (const s of servers) s.close(); void pool.end().finally(() => process.exit(0)); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);