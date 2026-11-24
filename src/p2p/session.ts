// P2P battle: the battle's match is hosted by the room leader. The room flow
// (create / join / ready / start / RESPAWN / DEATH / TIMERSYNC / ENDBATTLE) stays on Server.Game; only the datagrams
// MatchLink sends change transport. Leader: the Server.Match port in a Worker of its tab + one RTCPeerConnection per
// guest, answering on the server's /signal. Guest: one RTCPeerConnection to the leader.
import type { MatchTransport } from "../net/matchTransport.ts";
import type { MatchSession } from "../net/matchUdpLink.ts";
import type { RoomClient } from "../net/roomClient.ts";
import type { MatchData } from "../host/matchCore.ts";
import { KNUCKLE_STAGE } from "../game/respawnSelect.ts";
import { HostBridge, type BridgeOptions } from "../host/bridge.ts";
import { LocalHost, type WorkerLike } from "../host/local.ts";
import { RtcHost } from "../host/rtc.ts";
import { RtcGuestTransport } from "./guest.ts";
import { iceConfig } from "./ice.ts";
import { WebSignaling, signalRoomKey } from "./signaling.ts";
import { HANDOFF_VERSION, receiveHandoff, sendHandoff, type HandoffEnvelope } from "./handoff.ts";

// ---- join speed ----
let dataP: Promise<MatchData> | null = null;
const loadData = (): Promise<MatchData> => (dataP ??= import("../host/data/matchData.json").then((m) => m.default as unknown as MatchData));
/** Call when the player enters a room (leader or not: the leader can change): the match data chunk is then already loaded
 * when this tab has to host, instead of being fetched after PRESTARTBATTLE. */
export function preloadP2P(): void { void loadData().catch(() => { dataP = null; }); }

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Escalating timeouts: a lost offer / ICE packet costs 7 s, not the whole join. Each attempt has its own sid. */
const GUEST_ATTEMPT_MS = [7000, 10000, 15000];

async function connectWithRetry(sig: WebSignaling, ice: RTCConfiguration, o: P2POptions, log: (l: string) => void): Promise<RtcGuestTransport> {
  let last: unknown = new Error("p2p: signaling closed");
  for (let i = 0; i < GUEST_ATTEMPT_MS.length; i++) {
    if (sig.isClosed) break;
    try {
      return await RtcGuestTransport.connect(sig, ice, { RTCPeerConnection: o.RTCPeerConnection, timeoutMs: GUEST_ATTEMPT_MS[i] });
    } catch (e) {
      last = e;
      log(`guest link attempt ${i + 1}/${GUEST_ATTEMPT_MS.length} failed: ${(e as Error).message}`);
      await sleep(250 * (i + 1));
    }
  }
  throw last;
}

export interface P2POptions {
  session: MatchSession;
  serverUrl: string;
  /** the leader's / guest's Server.Game room session (null in offline tests) */
  room: RoomClient | null;
  /** host the match (default: room.isLeader) */
  leader?: boolean;
  /** TURN only */
  relayOnly?: boolean;
  RTCPeerConnection?: typeof RTCPeerConnection;
  /** guest: how long to wait for the host to show up on /signal (default 30 s) */
  hostWaitMs?: number;
  /** the match Worker (default: the browser Worker of src/host/worker.ts) */
  worker?: () => WorkerLike;
  /** Server.Match's static data (default: src/host/data/matchData.json, pb-extract-tools match-data.mjs) */
  data?: MatchData;
  bridge?: BridgeOptions;
  /** host takeover with a handoff: the old host's snapshot; the core restores before /signal opens */
  restore?: HandoffEnvelope;
  log?: (line: string) => void;
}

export interface P2PHandle {
  transport: MatchTransport;
  leader: boolean;
  host?: {
    local: LocalHost; rtc: RtcHost; bridge: HostBridge | null;
    /** Voluntary leader change: snapshot the core, drop the guests, stop the Worker and send the snapshot to the new leader
     * (`to`) over /signal. Resolves when the sends are done; the handle is stopped after it. Rejects if the core does not
     * answer: nothing was dropped yet, the caller may stop() normally (the new leader then falls back to a fresh core). */
    handoff(to: number): Promise<void>;
  };
  stop(): void;
}

/** The new leader, before it hosts: listens for the old host's snapshot on /signal (as a guest of its own slot; the host
 * role is only taken afterwards). null when none arrives in `ms` or /signal is not reachable: then it is the fresh-core takeover. */
export async function awaitHandoff(o: { serverUrl: string; session: MatchSession; ms?: number; log?: (line: string) => void }): Promise<HandoffEnvelope | null> {
  const log = o.log ?? ((l: string) => console.log(`[p2p] ${l}`));
  let sig: WebSignaling | null = null;
  try {
    sig = new WebSignaling(o.serverUrl, signalRoomKey(o.session.uniqueRoomId, o.session.roomSeed), "guest", o.session.slot, o.session.signalTicket);
    sig.onError = () => {}; // NO_HOST etc.: nothing to offer, only listening
    const wait = o.ms ?? 1500; // ends as soon as the snapshot is complete; the timeout only matters when the old host is gone
    const got = await Promise.race([sig.ready.then(() => receiveHandoff(sig!, wait)), new Promise<null>((r) => setTimeout(() => r(null), wait + 1000))]);
    log(got ? `handoff from slot ${got.from}: ${got.core.rooms.length} room(s) restored` : "no handoff snapshot: fresh match core");
    return got;
  } catch (e) {
    log(`handoff listen failed (${(e as Error).message}): fresh match core`);
    return null;
  } finally {
    sig?.close();
  }
}

/** Holds a Web Lock while the match runs: a background tab that holds one is not frozen / discarded by the browser's
 * memory saver, which is what silently killed a host that went AFK behind other tabs. */
function keepAlive(): () => void {
  let release: (() => void) | null = null;
  try {
    void navigator.locks?.request("pbweb-p2p", () => new Promise<void>((r) => { release = r; })).catch(() => {});
  } catch { /* no Web Locks (Node tests) */ }
  return () => release?.();
}

export async function openP2P(o: P2POptions): Promise<P2PHandle> {
  const { session } = o;
  const leader = o.leader ?? !!o.room?.isLeader;
  const key = signalRoomKey(session.uniqueRoomId, session.roomSeed);
  const log = o.log ?? ((l: string) => console.log(`[p2p] ${l}`));
  if (!leader) {
    const sig = new WebSignaling(o.serverUrl, key, "guest", session.slot, session.signalTicket);
    const ice = iceConfig(await sig.ready, o.relayOnly);
    await sig.hostReady(o.hostWaitMs);
    log(`room ${key}: host online, connecting slot ${session.slot}`);
    let transport: RtcGuestTransport;
    try {
      transport = await connectWithRetry(sig, ice, o, log);
    } catch (e) {
      sig.close();
      throw e;
    }
    sig.close(); // the link is up: no more signaling for this battle
    const unlock = keepAlive();
    return { transport, leader, stop: () => { unlock(); transport.close(); } };
  }

  // /signal and the match Worker boot in parallel (before: data -> Worker -> /signal, one after the other). Offers that reach
  // the host before the Worker is ready wait in WebSignaling's backlog and are flushed by RtcHost's constructor.
  const sig = new WebSignaling(o.serverUrl, key, "host", session.slot, session.signalTicket);
  // Clube da Luta: the host only lets the bare fist hit (matchCore loadoutOf); the room's stage is the only place it shows
  const knuckle = o.room?.room?.stage === KNUCKLE_STAGE ? { config: { barefistOnly: true } } : {};
  let localP: Promise<LocalHost>;
  try {
    const data = o.data ?? (await loadData());
    localP = LocalHost.start((o.worker ?? LocalHost.browserWorker)(), { uniqueRoomId: session.uniqueRoomId, roomSeed: session.roomSeed, data, ...knuckle, ...(o.restore ? { restore: o.restore.core } : {}) });
  } catch (e) {
    sig.close();
    throw e;
  }
  let local: LocalHost, ice: RTCConfiguration;
  try {
    const [l, servers] = await Promise.all([localP, sig.ready]);
    local = l;
    ice = iceConfig(servers, o.relayOnly);
  } catch (e) {
    sig.close();
    localP.then((l) => l.stop()).catch(() => {});
    throw e;
  }
  const room = o.room;
  const rtc = new RtcHost(local, sig, ice, {
    RTCPeerConnection: o.RTCPeerConnection,
    // /signal already proved (ticket + the server's signalGate) that this account sits in this slot of this battle. The old
    // extra check against the leader's own SLOTINFO list raced with joins: a guest whose SLOTINFO had not reached the leader
    // yet was refused and the join failed.
    allowSlot: (slot) => slot !== session.slot && slot >= 0 && slot < 18,
    log,
  });
  const bridge = room ? new HostBridge(room, local, session, { ...o.bridge, ...(o.restore ? { spawned: o.restore.bridge.spawned } : {}) }) : null;
  rtc.onGuest = (slot, up) => { if (up) bridge?.replaySlot(slot); };
  log(`room ${key}: hosting the match (slot ${session.slot}) — guests connect over WebRTC`);
  const transport = local.peer("leader");
  const unlock = keepAlive();
  let stopped = false;
  const handoff = async (to: number): Promise<void> => {
    if (stopped) return;
    const core = await local.snapshot();
    stopped = true;
    unlock();
    const env: HandoffEnvelope = { v: HANDOFF_VERSION, from: session.slot, core, bridge: bridge?.exportState() ?? { spawned: [] } };
    // from here the core must not serve: what it did after the snapshot is not in it
    bridge?.dispose();
    rtc.dropGuests("host handoff");
    local.stop();
    try { await sendHandoff(sig, to, env); } finally { rtc.close(); }
    log(`handoff to slot ${to} sent`);
  };
  return {
    transport, leader, host: { local, rtc, bridge, handoff },
    stop: () => {
      if (stopped) return;
      stopped = true;
      unlock();
      bridge?.dispose();
      // no local.end here: it closes the peers with 1001, and the guests must read the host leaving as a
      // dropped link (BattleNet.failover elects the room's new leader), not as the end of the match; ENDBATTLE already
      // sent the real 1001 through the bridge
      setTimeout(() => { rtc.close(); local.stop(); }, 700);
    },
  };
}