// Live acceptance check of the country field of a player (IP -> flag), through the web front, no browser:
//   HTTP login -> Auth -> Game -> LOBBY_GET_ROOMLIST_ACK (Waiting List rows) -> ROOM_CREATE + ROOM_JOIN, checking the
//   country of the slot records both ways (3586 for the joiner, the pushed 3588 for the players already in the room).
//   node src/net/test/country.live.ts [--expect ID] [--expect-unknown] [--gw ws://127.0.0.1:8090] [--api http://127.0.0.1:8090]
// --expect X asserts every country is exactly X; --expect-unknown asserts they are all "" (local / loopback is unknown
// on purpose, so the UI shows the gray "?" flag); no flag = the field shape only (works against any server).
import { AuthClient, gameTargetForServer, type LoginResult } from "../authClient.ts";
import { GameClient } from "../gameClient.ts";
import { RoomClient } from "../roomClient.ts";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const GW = arg("--gw", "ws://127.0.0.1:8090");
const API = arg("--api", "http://127.0.0.1:8090");
/** null = only the shape is checked; "" (--expect-unknown) = every country must be unknown; else the exact code */
const EXPECT: string | null = process.argv.includes("--expect-unknown") ? "" : process.argv.includes("--expect") ? arg("--expect", "ID") : null;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function post(path: string, body: unknown): Promise<Uint8Array> {
  const res = await fetch(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = (await res.json()) as { token?: string; error?: string };
  if (!res.ok || !json.token) throw new Error(`${path}: ${res.status} ${json.error ?? ""}`);
  return Uint8Array.from(Buffer.from(json.token, "base64"));
}

/** HTTP account -> Auth -> Game -> channel -> lobby, i.e. a client sitting in the Waiting List. */
async function open(label: string, token: Uint8Array): Promise<{ game: GameClient; login: LoginResult }> {
  console.log(`open ${label}: auth connect`);
  const auth = new AuthClient(GW);
  const mac = crypto.getRandomValues(new Uint8Array(6));
  mac[0] = (mac[0] & 0xfe) | 2;
  const login = await auth.connectAndLogin({ token, mac });
  if (!login.ok) throw new Error(`${label}: auth login ${login.errorName}`);
  console.log(`open ${label}: auth ok as ${login.username}`);
  const servers = await auth.getServers();
  const server = servers.find((s) => s.index > 0);
  if (!server) throw new Error(`${label}: no server row`);
  await auth.leave();

  const game = new GameClient(gameTargetForServer(server), GW);
  await game.enter(login.username, login.playerId, server.index);
  await game.selectChannel(0);
  await game.enterLobby();
  console.log(`open ${label}: in lobby as ${login.username}`);
  return { game, login };
}

/** the country of `nick` in a room list page, "" when the field is missing */
function countryOf(page: { players: { nickname: string; country?: string }[] } | null, nick: string): string {
  return page?.players.find((p) => p.nickname === nick)?.country ?? "";
}

const check = (what: string, got: string): void => {
  if (EXPECT !== null && got !== EXPECT) throw new Error(`${what}: expected country ${JSON.stringify(EXPECT)}, got ${JSON.stringify(got)}`);
  if (got !== "" && !/^[A-Z]{2}$/.test(got)) throw new Error(`${what}: country is not an ISO code: ${JSON.stringify(got)}`);
  console.log(`  ok ${what}: country=${JSON.stringify(got)}`);
};

async function main(): Promise<void> {
  let tokenA: Uint8Array;
  try {
    tokenA = await post("/api/login", { username: "player1", password: "player1" });
  } catch {
    tokenA = await post("/api/register", { username: `w1ctry${Date.now() % 1e7}`, password: "w1-meta-pw1" });
  }
  const tokenB = await post("/api/register", { username: `w1ctryb${Date.now() % 1e7}`, password: "w1-meta-pw1" });

  const A = await open("A", tokenA);
  // the Auth server blocks a second login from the same IP within 1s (authServer handleLogin "duplicate login attempt")
  await sleep(1100);
  const B = await open("B", tokenB);

  // ---- Waiting List (2588): the lobby rows carry the country of every player in the channel
  await sleep(1200); // server drops the first room-list poll < 1s after the Account was created (gameServer.handleGetRoomList)
  const page = await A.game.getRoomList(4000) ?? (await sleep(1600).then(() => A.game.getRoomList(4000)));
  if (!page) throw new Error("no room list (LOBBY_GET_ROOMLIST_ACK timeout)");
  console.log(`lobby players: ${page.players.length}`);
  for (const p of page.players) console.log(`  - ${p.nickname} rank=${p.rank} country=${JSON.stringify(p.country)}`);
  if (!page.players.some((p) => p.nickname === A.login.username)) throw new Error(`self ${A.login.username} not in the lobby list`);
  check(`lobby ${A.login.username}`, countryOf(page, A.login.username));

  // ---- Room: the seat records of the ready room (3586 to the joiner, 3588 to the players already there)
  const roomA = new RoomClient(A.game);
  const info = await roomA.create({ name: "ctry" });
  // the server pushes this seat's record (3588) right after the create ack, so the creator learns its own country too
  let ownA = roomA.slots[roomA.mySlot]?.country;
  for (let i = 0; i < 20 && ownA === undefined; i++) { await sleep(250); ownA = roomA.slots[roomA.mySlot]?.country; }
  if (ownA === undefined) throw new Error("own seat record never arrived (3588 pushed on ROOM_CREATE)");
  check("room create (own seat <- 3588)", ownA);
  const roomB = new RoomClient(B.game);
  const slotB = await roomB.join(info.roomId);
  let onA = "";
  for (let i = 0; i < 20 && !onA; i++) { await sleep(250); onA = roomA.slots[slotB]?.country ?? ""; }
  check(`room join (${B.login.username} <- 3586)`, roomB.slots[slotB]?.country ?? "");
  check(`room push (${B.login.username} -> ${A.login.username} 3588)`, onA);

  await roomB.leave().catch(() => undefined);
  await roomA.leave().catch(() => undefined);
  console.log(`OK: country flows GeoIP -> bytes -> client in the lobby and in the room`);
  process.exit(0);
}
main().catch((e) => { console.error("FAIL", e); process.exit(1); });
