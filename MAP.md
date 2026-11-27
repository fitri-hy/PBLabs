# MAP.md — Panduan Menambah Map Baru (100% Manual)

Panduan membuat map baru **tanpa `pbx`, tanpa `pb-extract-tools`, tanpa extractor apa pun**.
Semua file ditulis tangan: model 3D dari Blender (atau editor 3D apa pun), JSON ditulis manual, registri `index.json` diedit manual.

---

## 1. Cara kerja map di PBLabs

Map **sepenuhnya data-driven**. Tidak ada kode yang perlu diubah untuk memuat satu map:

```
public/assets/maps/index.json        ← registri (dibaca saat boot)
public/assets/maps/<id>/...          ← aset per map
```

Alur di client (`src/config.ts`):

1. `loadMapIndex()` fetch `/assets/maps/index.json`.
2. Entry yang **lolos `passesCheck()`** masuk `AVAILABLE_MAPS` + `MAP_LABELS` → tersedia di `?map=<id>`, pemilih map room, stage selector lobby, dan launcher F2.
3. Saat match mulai, `AssetPaths` menurunkan path dari `CurrentMap` → `visual.glb`, `collision.glb`, `collision.json`, `lighting.json`.
4. `src/realLevel.ts` memuat visual + collision + props; spawn dari `collision.json` (`src/game/spawns.ts`); nav graph dari `navgraph.bin` — **kalau file itu tidak ada, client membangunnya sendiri saat match mulai** (`NavGraph.load` → fallback `NavGraph.build`).

**Ringkasannya: tambah folder aset + tulis satu entry di `index.json` = map langsung bisa dimainkan.** Sisanya (mode online, bomb, bot cepat) adalah lapisan opsional di §7–§8.

---

## 2. Struktur folder — mana yang benar-benar dibaca runtime

```
public/assets/maps/<id>/          ← <id> huruf kecil, dipakai sebagai ?map=<id> dan CurrentMap
├── visual.glb          WAJIB  — geometri render
├── collision.glb       WAJIB  — mesh collider (trimesh Rapier)
├── collision.json      WAJIB  — bounds + respawns + spawnSuggestion
├── index.json (di folder maps/, satu untuk semua map)  WAJIB — registri
│
├── tex/*.png           opsional — texture eksternal (lihat §4)
├── visual.json         opsional — TIDAK dibaca game runtime (hanya tooling)
├── lighting.json       opsional — tanpa ini: lighting fallback netral (aman)
├── env_ref.dds         opsional — refleksi/IBL
├── props.json          opsional — properti interaktif (kaca, peti, dll.)
├── surfaces.json       opsional — tipe permukaan impact; tanpa ini semua "Cm" (concrete)
├── navgraph.bin        opsional — bot; TANPA ini client bake live (lambat, lihat §8)
└── ambient.json        opsional — suara zone
```

Di luar folder map (opsional):

| File | Untuk |
| :--- | :--- |
| `public/assets/cross/maps/bombsites.json` | Site A/B mode Bomb |
| `public/assets/ui/cross/loading/<id>_red.png` / `_blue.png` | Art loading battle (tanpa ini pakai `loading.png` bawaan) |
| `public/assets/ui/cross-hud/` (index `radar`/`minimap`) | Minimap/radar in-game |
| `src/host/data/matchData.json` → `maps["<mapId>"]` | Objek/bomb yang disinkronkan server online |

Fakta penting dari kode (sudah diverifikasi):

- **`visual.json` tidak dibaca game saat runtime** — cukup `visual.glb`-nya ada. (Kalau ada tool yang Anda jalankan sendiri nanti yang membutuhkannya, itu di luar alur manual ini.)
- **`lighting.json` hilang → diam-diam fallback** (`loadPbLighting` menangkap error → `null` → cahaya netral). Tidak perlu ditulis untuk map pertama.
- **`navgraph.bin` hilang → client bake sendiri**, otomatis.
- Field `shapes[]`/`meshes`/`tris`/`axes` di `collision.json` **tidak dibaca runtime** — hanya `respawns`, `bounds`, `spawnSuggestion` yang dipakai. Field lain boleh ditulis untuk dokumentasi.

---

## 3. Langkah 1 — Buat geometri di Blender

Prasyarat: Blender (gratis) + plugin glTF bawaan (sudah termasuk).

### 3.1 Visual (tampilan)

1. Model level-nya. Skala 1 unit = 1 meter, sumbu **+Z ke atas** tidak masalah (glTF mengonversi ke Y-up saat export).
2. Buat **2 UV map**:
   - `UVMap` (UV0) = texture utama — **wajib**.
   - `UVMap.1` (UV1) = lightmap — **opsional**. Tanpa UV1 penerangan bake tidak dipakai, tampilan tetap jalan dengan cahaya fallback.
3. Apply semua transform: seleksi semua → `Ctrl+A` → *Rotation & Scale*.
4. Export: `File → Export → glTF 2.0`:
   - Format: **glTF Binary (.glb)**
   - *Geometry → Apply Modifiers*: aktif
   - *Texture → Materials*: pilih **Embed textures** (paling mudah, tidak perlu folder `tex/`) **atau** *Keep/External* kalau mau file PNG terpisah (lihat §4)
   - Simpan sebagai `public/assets/maps/<id>/visual.glb`

### 3.2 Collision (tabrakan)

1. Buat mesh **terpisah dan sederhana** (dinding kotak, lantai bidang — bukan model detail). Semakin sedikit triangle, semakin cepat physics.
2. **Satu object = satu bentuk collider.** Setiap mesh jadi satu trimesh collider.
3. **Jangan pakai nama object diawali `TH_` atau `GLASS_`** — client memperlakukan nama itu sebagai kaca/panel tipis yang bisa pecah (perilaku khusus di `realLevel.ts`). Selain itu semua nama aman.
4. Apply transform, export seperti visual → `public/assets/maps/<id>/collision.glb`.

> Collision **tidak perlu** memakai material/texture — hanya geometri.

---

## 4. Langkah 2 — Texture (kalau tidak di-embed)

Kalau export §3.1 memakai texture eksternal, letakkan PNG-nya relatif terhadap `visual.glb`:

```
public/assets/maps/<id>/
├── visual.glb          ← merujuk "tex/dinding.png" (atau path lain yang dipakai saat export)
└── tex/
    └── dinding.png
```

Ketentuan client:

- Path texture di dalam GLB harus **relatif** dan case-coinsidens dengan file (dev server Windows mentolerir beda huruf besar/kecil, tapi jangan diandalkan).
- `tex/*.dds` (kompresi DXT) **tidak wajib** — tanpa DDS, client pakai PNG apa adanya. (Ada probe `.dds` yang bisa menimbulkan 404 per texture di console kalau folder `tex/` berisi PNG tanpa DDS — itu kosmetik, bukan error.)
- Cara paling simpel untuk map manual: **embed texture di GLB** (§3.1) → tidak perlu memikirkan `tex/` sama sekali.

---

## 5. Langkah 3 — Tulis `collision.json` (manual)

Buat `public/assets/maps/<id>/collision.json`. **Hanya tiga field ini yang dibaca game:**

```jsonc
{
  "bounds": {
    "min": [-50, 0, -50],      // ← wajib: BOUNDS LEVEL. Dipakai: nav graph bot, validasi respawn,
    "max": [ 50, 20,  50]      //    F4 wireframe. Isi dari nilai AABB visual/collision Anda.
  },
  "spawnSuggestion": [0, 1, 0],  // titik spawn cadangan (tengah map, 1 m di atas lantai)
  "respawns": [                  // titik respawn — SUMBER SPAWN PLAYER
    { "name": "Red1",  "pos": [-30, 0, -20], "yawDeg": 90,  "floorY": 0, "team": "red" },
    { "name": "Red2",  "pos": [-30, 0,  20], "yawDeg": 90,  "floorY": 0, "team": "red" },
    { "name": "Blue1", "pos": [ 30, 0, -20], "yawDeg": -90, "floorY": 0, "team": "blue" },
    { "name": "Blue2", "pos": [ 30, 0,  20], "yawDeg": -90, "floorY": 0, "team": "blue" }
  ]
}
```

Field opsional yang aman ditambahkan untuk dokumentasi (tidak dibaca runtime): `tris`, `verts`, `meshes`, `shapes`, `axes`, `respawnSource`.

### Aturan `respawns[]`

| Field | Keterangan |
| :--- | :--- |
| `pos` | `[x, y, z]` posisi **kaki** player (meter). |
| `floorY` | Y lantai; kalau di-skip, pakai `pos[1]`. |
| `yawDeg` | Arah hadap dalam derajat. **Aturan manual: `0` = menghadap +Z.** Lihat catatan di bawah. |
| `team` | `"red"` / `"blue"` (atau `0` / `1`). **Boleh dihapus** — client mengelompokkan sendiri jadi 2 tim dengan k-means. Isi manual supaya pasti. |
| `name` | Bebas. Jangan diakhiri `_generated` (itu penanda titik hasil generate; konvensi yaw-nya kebalik). |

> **Soal `yawDeg`:** client memakai konvensi asli GINS: arah hadap dunia = `(sin θ, cos θ)`, lalu menambahkan π untuk tiga.js. Konvensi umum PB: `θ = -90` (atau `270`) menghadap **−X** (barat), `θ = 90` menghadap **+X** (timur), `0` menghadap **+Z` (utara). **Selalu uji di game** (§9) dan koreksi kalau player spawn membelakangi map.

### Aturan `bounds`

- Isi **AABB level** (kotak pembungkus seluruh geometry). Cara cepat: di Blender, lihat ukuran objek via sidebar (`N` → *Dimensions*) + posisi world, atau dari editor mana pun yang menampilkan bounding box.
- Semua `respawns[].pos` **harus berada di dalam `bounds` (±1 m)** — ini syarat lolos check `respawnsInside` di `index.json`, dan tanpa `bounds` valid **bot tidak jalan** (nav graph butuh bounds).
- `bounds` juga menentukan ukuran grid bake nav graph — isi se-realistis mungkin (terlalu besar = bake live lama).

---

## 6. Langkah 4 — Daftarkan ke `index.json` (edit manual)

Buka **`public/assets/maps/index.json`** — satu array berisi semua map. Tambahkan object Anda (boleh di posisi mana pun; urutan menentukan urutan di pemilih map):

```jsonc
{
  "id": "mymap",                    // ← nama folder = ?map=mymap (huruf kecil)
  "pack": "MyMap",                  // bebas (nama asli/kustom)
  "mapId": null,                    // lihat §7 — null = hanya ?map= dan offline
  "mapIdSource": null,
  "name": "My Map",                 // tampilan di UI
  "nameEn": "My Map",
  "source": "custom",
  "tris": 12345,                    // boleh perkiraan/0 (tidak dibaca runtime)
  "collisionTris": 4321,
  "bounds": { "min": [-50, 0, -50], "max": [50, 20, 50] },
  "respawns": 4,
  "teams": { "red": 2, "blue": 2 },
  "respawnSource": "manual",
  "check": {
    "visual": true,                                 // ← SYARAT 1
    "collisionGlb": true,                           // ← SYARAT 2
    "respawnsInside": "4/4",                        // ← SYARAT 3: "jumlah-di-bounds/jumlah-respawn", HARUS cocok
    "collisionInsideVisual": true,                  // opsional (diagnostik)
    "dMin": [0, 0, 0], "dMax": [0, 0, 0]            // opsional (diagnostik)
  }
}
```

**`passesCheck()` di `src/config.ts` hanya mensyaratkan tiga hal:**

```ts
check.visual === true
&& check.collisionGlb === true
&& check.respawnsInside === "N/N"     // contoh "4/4"; "0/0" (tanpa respawn) juga lolos
```

Entry yang gagal check tetap tersimpan untuk pemetaan `mapId`, tapi **tidak masuk** `AVAILABLE_MAPS` → tidak muncul di mana pun.

⚠️ **`check` wajib ditulis lengkap** — tanpa `check`, `passesCheck()` menganggap entry gagal (`c?.visual` → `false`) sehingga map **tidak pernah masuk** `AVAILABLE_MAPS` (tidak error, tapi tidak muncul di mana pun).

⚠️ **Jaga validitas JSON** — file ini dibaca saat boot; satu karakter rusak = semua map hilang (fallback cuma 4 map lama).

### Cek manual "respawns di dalam bounds"

Sebelum menulis `"respawnsInside": "N/N"`, pastikan benar: setiap `respawns[].pos` berada di dalam `bounds` (±1 m) di ketiga sumbu. Kalau ada respawn di luar → pindahkan respawn-nya atau lebarkan `bounds`, jangan mengarang angka check-nya — `check` yang bohong membuat respawn jatuh/aneh tanpa peringatan.

---

## 7. Mode online / room picker (opsional)

`?map=mymap` dan test offline (F2) langsung jalan dengan §6. Supaya map **bisa dipilih pemain lain di room online**, tambahkan:

### 7.1 `mapId` server

Isi `"mapId": <angka>` di entry index. Syarat:

- **0–255** — dikirim lewat 1 byte (`writeC`), jadi tidak boleh lebih dari 255.
- **Unik** — dipakai juga sebagai key di `matchData.json` dan pemetaan `mapFromRoomMapId()`; `mapId` yang dobel dengan map lain membuat salah satu map tidak akan pernah tercapai (pemetaan "pertama menang").
- Kalau server asli PB Anda punya id untuk map ini, pakai id itu. Untuk map kustom, pilih angka bebas yang belum terpakai di `index.json` (mis. `201`).

### 7.2 Daftarkan di set mode (2 file — harus sama)

- TDM/Deathmatch: tambahkan angkanya ke **`TDM_SERVER_MAP_IDS`** di:
  - `src/ui/roomScreen.ts`
  - `src/lobby/core/controller.ts`
- Bomb Mission: tambahkan ke **`BOMB_SERVER_MAP_IDS`** di `src/lobby/core/controller.ts`.

Tanpa ini, map tidak muncul di pemilih map room/lobby/launcher F2 (semua menyaring lewat set itu, dan dedupe per `mapId`).

### 7.3 Mode Bomb: site A/B

Tambahkan key = `id` map di `public/assets/cross/maps/bombsites.json`:

```jsonc
"mymap": {
  "stage": "My Map",
  "mapId": 201,
  "sites": [
    { "area": 0, "pos": [x, y, z], "floor": 0, "floorDy": 0 },
    { "area": 1, "pos": [x, y, z], "floor": 0, "floorDy": 0 }
  ]
}
```

### 7.4 `matchData.json` (server online)

Untuk **TDM polos** entry ini tidak wajib — `getMap()` mengembalikan `null` dengan aman (objek kosong). Untuk **mode Bomb online** server membutuhkan posisi bomb dari `src/host/data/matchData.json`:

```jsonc
// tambahkan di dalam "maps":
"201": { "objects": [], "bombs": [[x, y, z], [x, y, z]] }
```

`objects` boleh `[]` (tidak ada properti yang disinkronkan). Ini data statis yang di-import saat server muluh.

### 7.5 Nama di header room

`mapName()` (`src/net/roomClient.ts`) hanya mengenal mapId `4` dan `36`; map lain tampil `Map201`. **Hanya kosmetik.** Kalau mau, tambahkan pasangan `id: "My Map"` di tabel `mapName()` — perubahan kecil yang aman.

---

## 8. Bot & nav graph (tanpa tool bake)

`navgraph.bin` **tidak wajib**. Tanpa file itu, saat match dengan bot mulai client memanggil `NavGraph.build()` — membangun graph langsung di browser.

Konsekuensinya (dari kode):

- Butuh **`bounds` valid** di `collision.json` — tanpa bounds, bot dilewati sama sekali (`[nav] skipped`).
- Waktu bake live berkisar **1,6 detik (map kecil) sampai ~136 detik (map besar)**, terjadi sekali di awal match saat bot ada.
- Untuk map kecil (< ~80×80 m) bake live biasanya masih wajar.

Tips mempercepat tanpa tool eksternal:

- Isi `bounds` **se-rapat mungkin** (grid nav = `bounds / 1.75 m`, jadi bounds 2× lebih luas = 4× lebih banyak raycast).
- Jangan luangkan ruang kosong raksasa di bounds.
- Kalau suatu saat Anda punya akses ke tool bake eksternal, file `navgraph.bin` hanya drop-in — client otomatis memakainya dan validasi `bounds`/respawns-nya sendiri (file basi otomatis ditolak → bake live).

---

## 9. Checklist verifikasi

### Tanpa browser (cepat)

```powershell
# 1. Test wiring index — map baru harus terbaca, ?map= harus resolve
node --test src/test/config.test.ts

# 2. Typecheck (tidak ada perubahan kode = harus tetap lolos)
npm run typecheck
```

`config.test.ts` membaca `public/assets/maps/index.json` yang sama — kalau JSON Anda rusak, test ini gagal duluan.

### Di browser (dev: `npm run dev` → `http://localhost:8000`)

| Uji | Cara | Yang dicek |
| :--- | :--- | :--- |
| Load map | `http://localhost:8000/?map=mymap` | Map terlihat (bukan hanya collision ungu-abu), tidak error di console |
| Spawn | Tunggu spawn | Player berdiri di tempat wajar, tidak jatuh, tidak tembus lantai |
| Dinding | Jalan ke dinding | Tidak menembus (collision glb bekerja) |
| Shoot | Tembak lantai/dinding | Impact efek & suara muncul (default "concrete" kalau tanpa `surfaces.json`) |
| Bot (opsional) | F2 → isi bots ≥ 2 | Bot jalan (nav build live di console, lihat §8) |
| Room online (§7) | Buat room → pemilih map | Map muncul & lawan bisa join |

### Setelah yakin

Kalau nanti ada perubahan pada `collision.*`, bake/nav tidak perlu diapa-apakan (memang tidak ada file bake manual) — cukup ulangi test di atas.

---

## 10. Troubleshooting

| Gejala | Penyebab / fix |
| :--- | :--- |
| `?map=mymap` tidak dikenal / map tidak muncul di daftar | Entry gagal `passesCheck()` — cek 3 syarat §6 (`check` harus ada dan benar). |
| Semua map hilang, yang tersisa cuma 4 map lama | `index.json` JSON-nya rusak (koma hilang, dll). Validasi ulang file-nya. |
| Player spawn di titik aneh / 8 spawn berdesakan | `respawns[]` kosong → client pakai 8 spawn fallback di sekitar `spawnSuggestion`. Isi respawns sungguhan. |
| Player jatuh menembus lantai | `collision.glb` tidak mencakup lantai, atau mesh belum di-apply transform-nya. |
| Map hanya menampilkan kotak-kotak ungu-abu | `visual.glb` gagal dimuat (path salah / GLB rusak) → mode collision-only. Cek console & file. |
| Awal match bot lambat (beberapa detik–menit) | Normal tanpa `navgraph.bin` (§8). Perkecil `bounds`, atau kurangi jumlah bot saat uji. |
| Bot tidak bergerak sama sekali | `bounds` tidak ada/tidak valid di `collision.json` → nav graph dilewati. |
| Lighting datar / tidak ada refleksi | Normal tanpa `lighting.json`/`env_ref.dds` (opsional). |
| Map muncul tapi tidak bisa dipilih di room | `mapId` null, belum masuk `TDM_SERVER_MAP_IDS` (2 file), atau `mapId` sudah terpakai (dedupe). §7.1–7.2. |
| Room online error saat mode Bomb | Belum ada `matchData.json` → `maps["<mapId>"]` dengan `bombs`. §7.4. |
| Console banyak 404 `tex/*.dds` | Kosmetik — PNG tetap dipakai. Ingin bersih: embed texture di GLB (§4). |
| Texture tidak muncul (hitam/pink) | Path di GLB tidak cocok dengan file (case-sensitive di server produksi). Embed di GLB paling aman. |
| Player spawn membelakangi map | Konvensi `yawDeg` — koreksi ±180° pada respawn (§5). |

---

## 11. Referensi cepat

| Topik | Lokasi kode |
| :--- | :--- |
| Registri map, `?map=`, `passesCheck`, pemetaan mapId | `src/config.ts` |
| Pemilih map room + `TDM_SERVER_MAP_IDS` | `src/ui/roomScreen.ts` |
| `TDM_SERVER_MAP_IDS` (salinan lobby) + `BOMB_SERVER_MAP_IDS` + `stageChoices()` | `src/lobby/core/controller.ts` |
| Loader level (visual/collision/props/lighting) | `src/realLevel.ts` |
| Spawn, `yawDeg`, pembagian tim (k-means) | `src/game/spawns.ts` |
| Nav graph + fallback bake live | `src/game/navGraph.ts` (`NavGraph.load` → `NavGraph.build`) |
| Properti map (kaca `GLASS_*`/`TH_*`) | `src/game/mapProps.ts` |
| Site bom | `src/game/game.ts` (`initBomb`) |
| Tabel pemetaan `mapId` online | `src/host/matchCore.ts` (`getMap`) + `src/host/data/matchData.json` |
| Test wiring index | `src/test/config.test.ts` |
