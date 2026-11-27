import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { lockPointer } from "./lockPointer.ts";
import { Game, type GameDeps } from "./game/game";
import { Input } from "./game/input";
import { createVirtualControls } from "./game/createVirtualControls";
import { buildTestLevel } from "./testLevel";
import { buildRealLevel } from "./realLevel";
import { setCompressedTextureSupport } from "./render/compressedTex";
import { assetExists } from "./assetProbe";
import { AssetPaths, CurrentMap, MAP_LABELS, setCurrentMap, type MapId } from "./config";
import type { LevelBuildResult } from "./testLevel";
import { setBattleProgress } from "./game/battleLoading";
import { configurePbRenderer, pbLighting } from "./render/pbLighting";
import { acquireRenderer, memSnap, releaseMatch, rendererStats } from "./render/sharedRenderer";
import { levelCacheStats } from "./levelCache";
import { brightnessFactor, getSettings, onSettings, pixelRatioFor, type GameSettings } from "./gameplay/settings";
import { preloadMatch, type MatchSet } from "./game/matchPreload";
import { warmScene } from "./render/warmup";
import { TEST_EQUIPPED } from "./game/testLoadout";
import { BOT_WEAPON } from "./game/weaponAdapter";

export interface StartGameOptions extends Pick<GameDeps, "net" | "localTeam" | "localName" | "localRank" | "match" | "onMatchEnd" | "respawnInventory" | "localChara" | "itemEffects" | "botCount" | "botSkill" | "botAllies" | "missions" | "missionPanel" | "clanMatch" | "stageType" | "room"> {
  map?: MapId;
  onLeave?: (reason?: "away") => void;
}

export interface GameHandle {
  game: Game;
  stop(): void;
}

const renderRatio = (r: THREE.WebGLRenderer, s: GameSettings): number => {
  const gl = r.getContext();
  return pixelRatioFor(
    s,
    window.devicePixelRatio,
    Math.max(window.innerWidth, window.innerHeight),
    gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number
  );
};

const DYN_STEPS = [0.7, 0.8, 0.9, 1];
const DYN_REFRESH = [30, 48, 60, 75, 90, 120, 144, 165, 240];

const PERF = typeof location !== "undefined" && new URLSearchParams(location.search).has("perf");
let perfN = 0, perfU = 0, perfS = 0, perfR = 0, perfAt = 0;

function perfTick(u: number, s: number, r: number): void {
  if (!PERF) return;

  perfN++;
  perfU += u;
  perfS += s;
  perfR += r;

  const now = performance.now();
  if (now - perfAt < 2000) return;

  const b = (globalThis as { __pbPerfBots?: Record<string, number> }).__pbPerfBots;
  const f = (x: number) => (x / perfN).toFixed(2);
  const parts = b
    ? Object.entries(b).map(([k, v]) => `${k} ${f(v)}`).join(" ")
    : "-";

  console.info(
    `[perf] ${perfN} frames: update ${f(perfU)} [${parts}] · step ${f(perfS)} · render ${f(perfR)} ms`
  );

  if (b) {
    for (const k of Object.keys(b)) b[k] = 0;
  }

  perfN = perfU = perfS = perfR = 0;
  perfAt = now;
}

interface Prepared {
  map: MapId;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  world: RAPIER.World;
  level: LevelBuildResult;
  levelName: string;
  debugGroup: THREE.Group;
}

let pending: { map: MapId; p: Promise<Prepared> } | null = null;

export function prepareGame(map: MapId, set: MatchSet, bots = false): Promise<void> {
  discardPrepared();

  const p = prepare(
    map,
    bots ? { ...set, weapons: [...set.weapons, BOT_WEAPON.id] } : set
  );

  pending = { map, p };
  return p.then(() => undefined);
}

export function discardPrepared(): void {
  const p = pending;
  pending = null;

  void p?.p.then(
    (x) => {
      releaseMatch(x.renderer, [x.scene, x.camera], "discarded prepare");
      x.world.free();
    },
    () => {}
  );
}

function localMatchSet(opts: StartGameOptions): MatchSet {
  const e = opts.respawnInventory?.equipped ?? TEST_EQUIPPED;

  const team =
    opts.localTeam ??
    (new URLSearchParams(location.search).get("team")?.toLowerCase().startsWith("b") ? 1 : 0);

  const weapons = [
    e.primary,
    e.secondary,
    e.melee,
    e.grenade,
    e.special
  ].filter((id) => id > 0);

  return {
    weapons: [...weapons, BOT_WEAPON.id],
    charas: [{ itemId: opts.localChara, team }],
    local: { chara: opts.localChara, team, weapons },
    bomb: opts.match?.mode === "BOMB"
  };
}

async function prepare(map: MapId | undefined, set: MatchSet): Promise<Prepared> {
  if (map) setCurrentMap(map);

  await RAPIER.init();

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111318);

  const camera = new THREE.PerspectiveCamera(
    75,
    window.innerWidth / window.innerHeight,
    0.05,
    500
  );

  const renderer = acquireRenderer();

  renderer.setPixelRatio(renderRatio(renderer, getSettings()));
  setCompressedTextureSupport(renderer);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const gravity = { x: 0.0, y: -9.81, z: 0.0 };
  const world = new RAPIER.World(gravity);

  setBattleProgress(0.05);

  const [hasVisual, hasCollision] = await Promise.all([
    assetExists(AssetPaths.visualGlb),
    assetExists(AssetPaths.collisionGlb)
  ]);

  let level: LevelBuildResult;
  let levelName: string;

  if (hasCollision) {
    try {
      level = await buildRealLevel(world, RAPIER, hasVisual);
      levelName = `${MAP_LABELS[CurrentMap]} (${hasVisual ? "real assets" : "collision only"})`;
    } catch (err) {
      console.error("Failed to load real level, falling back to test level", err);
      level = buildTestLevel(world, RAPIER);
      levelName = "Test level (fallback, load error)";
    }
  } else {
    level = buildTestLevel(world, RAPIER);
    levelName = "Test level (placeholder)";
  }

  setBattleProgress(0.6);

  level.visualGroup.matrixAutoUpdate = false;
  level.visualGroup.updateMatrix();
  scene.add(level.visualGroup);

  configurePbRenderer(renderer, scene);

  const camFar = pbLighting()?.camFar;
  if (camFar) {
    camera.far = camFar;
    camera.updateProjectionMatrix();
  }

  const debugGroup = new THREE.Group();
  debugGroup.visible = false;

  for (const mesh of level.colliderMeshes) {
    debugGroup.add(mesh);
  }

  scene.add(debugGroup);

  const warm = await preloadMatch(set).catch((e) => {
    console.warn("[preload]", e);
    return null;
  });

  setBattleProgress(0.85);

  await warmScene(renderer, scene, camera, warm?.objects).catch((e) => {
    console.warn("[warmup]", e);
  });

  warm?.dispose();

  setBattleProgress(0.9);

  return {
    map: CurrentMap,
    renderer,
    scene,
    camera,
    world,
    level,
    levelName,
    debugGroup
  };
}

export async function startGame(opts: StartGameOptions = {}): Promise<GameHandle> {
  let prepP: Promise<Prepared>;

  if (opts.net && pending && pending.map === (opts.map ?? CurrentMap)) {
    prepP = pending.p;
    pending = null;
  } else {
    discardPrepared();
    prepP = prepare(opts.map, localMatchSet(opts));
  }

  const {
    map,
    renderer,
    scene,
    camera,
    world,
    level,
    levelName,
    debugGroup
  } = await prepP;

  const ac = new AbortController();
  const signal = ac.signal;

  const app = document.getElementById("app")!;
  const blocker = document.getElementById("blocker")!;

  app.appendChild(renderer.domElement);

  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);

  let dynLevel = DYN_STEPS.length - 1;

  const applyRes = (s: GameSettings) => {
    if (!s.dynamicRes) dynLevel = DYN_STEPS.length - 1;

    renderer.setPixelRatio(renderRatio(renderer, s) * DYN_STEPS[dynLevel]);
    renderer.setSize(window.innerWidth, window.innerHeight);
  };

  let dynN = 0;
  let dynSum = 0;
  let dynCpuSum = 0;
  let dynGood = 0;
  let dynHold = 5;
  let dynLastUp = 0;
  let dynFloorMs = Infinity;

  const dynTick = (raw: number, cpu: number): void => {
    const s = getSettings();

    if (!s.dynamicRes || document.hidden || raw > 0.25) {
      dynN = dynSum = dynCpuSum = 0;
      return;
    }

    dynN++;
    dynSum += raw * 1000;
    dynCpuSum += cpu;

    if (dynSum < 1000) return;

    const avg = dynSum / dynN;
    const cpuAvg = dynCpuSum / dynN;

    dynN = dynSum = dynCpuSum = 0;
    dynFloorMs = Math.min(dynFloorMs, avg);

    const target =
      1000 /
      (DYN_REFRESH.find((hz) => 1000 / hz <= dynFloorMs * 1.05) ?? 240);

    if (avg > target * 1.15) {
      dynGood = 0;

      if (dynLevel > 0 && cpuAvg < avg * 0.7) {
        if (performance.now() - dynLastUp < 10000) {
          dynHold = Math.min(dynHold * 2, 60);
        }

        dynLevel--;
        applyRes(s);
      }
    } else if (
      avg < target * 1.05 &&
      dynLevel < DYN_STEPS.length - 1 &&
      ++dynGood >= dynHold
    ) {
      dynGood = 0;
      dynLevel++;
      dynLastUp = performance.now();
      applyRes(s);
    }
  };

  const unsubRes = onSettings(applyRes);

  const unsubBrightness = onSettings((s) => {
    renderer.domElement.style.filter =
      s.brightness === 50 ? "" : `brightness(${brightnessFactor(s)})`;
  });

  window.addEventListener(
    "resize",
    () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    },
    { signal }
  );

  // Panduan kontrol ("Click to Play") tidak ditampilkan; blocker selalu disembunyikan.
  blocker.innerHTML = "";
  blocker.classList.add("hidden");

  // Input desktop + mobile.
  const input = new Input(document.body);

  // Mount virtual controls only on touch-capable devices.
  const virtualControls = createVirtualControls(input, {
    sensitivityX: 1.8,
    sensitivityY: 1.4,
    invertY: false,
    joystickSize: 140,
    deadzone: 0.16,
    directionThreshold: 0.3
  });

  let game: Game;

  try {
    game = await Game.create({
      scene,
      camera,
      world,
      R: RAPIER,
      input,
      levelName,
      levelSpawn: level.spawn,
      collisionJsonUrl: AssetPaths.collisionJson,
      net: opts.net,
      localTeam: opts.localTeam,
      localName: opts.localName,
      localRank: opts.localRank,
      match: opts.match,
      onMatchEnd: opts.onMatchEnd,
      onLeave: opts.onLeave,
      respawnInventory: opts.respawnInventory,
      localChara: opts.localChara,
      itemEffects: opts.itemEffects,
      botCount: opts.botCount,
      botSkill: opts.botSkill,
      botAllies: opts.botAllies,
      missions: opts.missions,
      missionPanel: opts.missionPanel,
      stageType: opts.stageType,
      room: opts.room,
      clanMatch: opts.clanMatch
    });
  } catch (error) {
    virtualControls?.destroy();
    input.dispose();
    ac.abort();
    unsubRes();
    unsubBrightness();
    blocker.classList.add("hidden");
    throw error;
  }

  await new Promise((r) => setTimeout(r, 0));

  await warmScene(renderer, scene, camera).catch((e) => {
    console.warn("[warmup]", e);
  });

  let debugVisible = false;

  window.addEventListener(
    "keydown",
    (e) => {
      if (e.code === "F4") {
        e.preventDefault();
        debugVisible = !debugVisible;
        debugGroup.visible = debugVisible;
      }
    },
    { signal }
  );

  document.body.addEventListener(
    "click",
    (e) => {
      const target = e.target as HTMLElement | null;

      if (target?.id === "pbleave") {
        opts.onLeave?.();
        return;
      }

      // Virtual control clicks must not request pointer lock.
      if (target?.closest(".pb-virtual-controls")) return;

      const hasTouch =
        navigator.maxTouchPoints > 0 ||
        window.matchMedia("(pointer: coarse)").matches;

      if (hasTouch) return;

      if (game.finalOn) return;

      if (document.pointerLockElement !== document.body) {
        void lockPointer();
      }
    },
    { signal }
  );

  const clock = new THREE.Clock();

  let raf = 0;
  let lastStep = performance.now();
  let lastCpu = 0;

  function animate() {
    raf = requestAnimationFrame(animate);

    lastStep = performance.now();

    const raw = clock.getDelta();
    const dt = Math.min(raw, 0.05);

    dynTick(raw, lastCpu);

    world.timestep = dt;

    const t0 = performance.now();

    game.update(dt, raw);

    const t1 = performance.now();

    world.step();

    const t2 = performance.now();

    renderer.render(scene, camera);

    const t3 = performance.now();

    lastCpu = t3 - t0;

    perfTick(t1 - t0, t2 - t1, t3 - t2);
  }

  (window as unknown as { __pb?: Game }).__pb = game;
  (window as unknown as { __pbR?: THREE.WebGLRenderer }).__pbR = renderer;

  animate();

  const stepOnly = () => {
    const raw = clock.getDelta();
    const dt = Math.min(raw, 0.05);

    world.timestep = dt;

    game.update(dt, raw);
    world.step();
  };

  const bg = setInterval(() => {
    if (document.hidden && performance.now() - lastStep > 400) {
      lastStep = performance.now();
      stepOnly();
    }
  }, 250);

  let stopped = false;
  let successor: GameHandle | null = null;

  const w = window as unknown as {
    __pb?: Game;
    __pbRestart?: (map?: MapId) => Promise<unknown>;
    __pbMem?: () => unknown;
  };

  const handle: GameHandle = {
    game,

    stop() {
      if (stopped) {
        successor?.stop();
        return;
      }

      stopped = true;

      cancelAnimationFrame(raf);
      clearInterval(bg);

      unsubRes();
      unsubBrightness();

      ac.abort();

      // Destroy touchscreen controls and release all virtual input.
      virtualControls?.destroy();

      // Remove physical and virtual Input listeners/state.
      input.dispose();

      if (document.pointerLockElement) {
        document.exitPointerLock();
      }

      releaseMatch(renderer, [scene, camera]);

      game.dispose();
      world.free();

      blocker.classList.add("hidden");

      if (w.__pb === game) delete w.__pb;
      if (w.__pbRestart === restart) delete w.__pbRestart;
    }
  };

  const restart = async (map?: MapId) => {
    if (opts.net) {
      throw new Error("__pbRestart: local match only");
    }

    const t0 = performance.now();
    const before = memSnap(renderer);

    handle.stop();

    const next = await startGame({
      ...opts,
      map: map ?? opts.map ?? CurrentMap
    });

    successor = next;

    const nr = (window as unknown as {
      __pbR: THREE.WebGLRenderer
    }).__pbR;

    return {
      ms: Math.round(performance.now() - t0),
      sameRenderer: nr === renderer,
      before,
      after: memSnap(nr),
      level: { ...levelCacheStats },
      renderer: { ...rendererStats }
    };
  };

  if (PERF || import.meta.env.DEV) {
    w.__pbRestart = restart;

    w.__pbMem = () => ({
      ...memSnap(renderer),
      level: { ...levelCacheStats },
      renderer: { ...rendererStats }
    });
  }

  return handle;
}