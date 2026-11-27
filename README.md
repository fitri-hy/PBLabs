# PBLabs

<img src="./public/1.png" />

An unofficial, open-source web version of Point Blank—an experiment to bring the desktop gaming experience directly into a web browser.

- **Client:** TypeScript, Vite, three.js, Rapier
- **Server:** TypeScript (Original Point Blank protocol & PostgreSQL)
- **Matchmaking:** Peer-to-peer via WebRTC, with failover, handoff and rejoin
- **Game modes:** Deathmatch, Bomb Mission, Destroy, HeadHunter, Chaos, the Sniper / Shotgun / Knife presets, and bots
- **Lobby & rooms:** server and channel select, room create/join with rules, countdown, AI seats, vote-kick and vote-leader
- **Items & progression:** shop, inventory and equip, atomic purchases, rank items, missions and mission cards, titles
- **Social:** clan, friends, lobby/room chat with a filter, mute, player and bug reports
- **Game master:** NORMAL / MODERATOR / GAMEMASTER roles, 13 in-game commands, stealth GM
- **Infrastructure:** Distributed servers connected to a single PostgreSQL instance (with per-server categorization and custom names, supporting refreshes without requiring a restart), rate limits, an origin allow-list, and a shared ticket secret.
- **Security:** login and session tokens, per-IP caps, WS origin checks, node-to-node auth on `POST /api/kick`


---

## Prerequisites

| Component | Description |
| :--- | :--- |
| **Node.js** | Version 22.18+ (Node 24 recommended) |
| **Database** | PostgreSQL 16+ or Docker (Port `5433` / `5432`) |
| **Assets** | [Download](https://github.com/fitri-hy/PBLabs/releases) automatically via `npm run download -- --assets --<tag>` or place assets manually in the `public/assets/` folder |

---

## Quick Start

1. **Install dependencies:**

```
npm run install:all
```

2. **Download assets (e.g., Tag 0.0.3):**

```
npm run download -- --assets --0.0.3
```


3. **Set up environment:**

```
cp server/.env.example server/.env.local
```


4. **Run the application:**
```
npm start
```


5. **Open in browser:** `http://localhost:8000`

---

## Main Commands

| Command                     | Description                                                                                           |
| --------------------------- | ----------------------------------------------------------------------------------------------------- |
| `npm start`                 | Run production (server + static `dist`, without Vite). Automatically builds if `dist` does not exist. |
| `npm start -- --docker`     | Run production with Docker DB.                                                                        |
| `npm run start:build`       | Force rebuild `dist`, then run production.                                                            |
| `npm run start:web`         | Run static frontend only (port 8000).                                                                 |
| `npm run start:status`      | Check production ports and service status.                                                            |
| `npm run build:prod`        | Build production files into `dist/`.                                                                  |
| `npm run dev`               | Run server + Vite (previously `npm start`).                                                           |
| `npm run dev -- --docker`   | Run development with Docker DB.                                                                       |
| `npm run dev -- --frontend` | Run frontend only (port 8000).                                                                        |
| `npm run dev -- --backend`  | Run backend only (port 8090).                                                                         |
| `npm run dev:vite`          | Run Vite only (previously `npm run dev`).                                                             |
| `npm run dev:all`           | Alternative: run server + Vite.                                                                       |
| `npm run dev:all:nowatch`   | Same as `dev:all`, but without file watching/HMR.                                                     |
| `npm run dev:alt`           | Run alternative Vite setup.                                                                           |
| `npm run dev:status`        | Check development ports and service status (previously `npm run status`).                             |
| `npm run dev:build`         | Build in default mode, not production mode (previously `npm run build`).                              |
| `npm run dev:preview`       | Run Vite preview (previously `npm run preview`).   

---

## Distributed Servers, one database

Servers can be run across multiple machines while sharing the same PostgreSQL database. The primary machine maintains the configuration described above, while additional machines execute the same `node src/main.ts` command, including the `PB_TICKET_SECRET` and `PB_GAME_SERVER_IDS` variables. Clients connect to each game server via the specific machine hosting it; this routing information is retrieved from a centralized configuration (`system_servers.gateway`, provided via the `GET /api/nodes` endpoint).

Each entry includes its own display metadata: `system_servers.name` (the name shown on the server card) and `system_servers.category` (the category used to group servers—this is how servers hosted on different machines are distinguished from those on the primary machine).

This data is read in real-time: you can modify a server's name or reassign it to a different category, then simply press the **refresh** button on the in-game server selection screen. No restart is required.

Refer to **[DISTRIBUTED_SERVERS.md](DISTRIBUTED_SERVERS.md)** for details regarding the architecture, per-node environment settings, and the configuration tools used:

```
node scripts/servers-config.mjs nodes      # which machine carries which server and channels
node scripts/servers-config.mjs add 4 <ip> 39194 Public ws://<ip>:8090
node scripts/servers-config.mjs name 4 "Server New"        # what the card says (live)
node scripts/servers-config.mjs category 4 "Asian"    # the tab it sits under (live)
```

---

## Demo Accounts

| Role | Username | Password |
| :--- | :--- | :--- |
| **GM** | `player` | `player` |
| **Player** | `player1` | `player1` |

---

## Documentation

| Document | What is in it |
| --- | --- |
| **[DISTRIBUTED_SERVERS.md](DISTRIBUTED_SERVERS.md)** | Running the game on several machine against one PostgreSQL: what used to pin everything to one process, the per-node environment, the centralized config tool (`scripts/servers-config.mjs`), the display config (`name` / `category`, no restart), and the rules the config must satisfy |
| **[EVENTS.md](EVENTS.md)** | In-game events: the seven event types and their `system_event_*` tables, the `yyMMddHHmm` date format (UTC), SQL recipes for login / visit / quest / rank-up / boost / xmas and the Play.json playtime event, plus load-and-restart rules |
| **[GM_COMMAND.md](GM_COMMAND.md)** | In-game GM commands: how to run them from lobby or room chat, roles and permissions, enabling the GM role, and the full command list (`:help`, `:host`, `:endbattle`, `:sendmsg`, ...) |

---

## Legal Notice & License

> **Note:** This repository contains source code only. All game assets, protocols, and raw data are the full property of **Zepetto** and are **not covered by the MIT License**. This project is strictly for educational/experimental purposes and is **strictly prohibited** for commercial use.
