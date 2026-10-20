<p align="center">
  <img src="icon.svg" alt="" width="112">
</p>

<h1 align="center">oss!idle sim</h1>

<p align="center">
  An add-on for <a href="https://github.com/oss-idle/oss-idle">oss!idle</a> that simulates plays on every map you have downloaded
</p>

<p align="center">
  Press <strong>Ctrl+Shift+F</strong> in game to open the overlay.
</p>

## How it works

It runs oss!idle's own `CharacterBot` + `ManiaGame` against each chart, the same simulation the server uses for authoritative scores, then ranks the results.

It uses XP/second for each skill, and can approximate pp gains.

## Rates

Each map is simulated at the rates you tick among those your character's Speed upgrades unlock (each rate is a full extra sweep). The table lists each difficulty once, at its best rate.

## Playlists

Use the top n maps rather that the single best one to avoid mindblock.

Saved entries can be locked at their rate (all of them, all but x1, or none), so a playlist can mix rates. An unlocked entry follows the rate set in song select, so with no locks a generated playlist sticks to its best rate, which the save button names. Tick "Several rates of one difficulty" to let the playlist hold a difficulty more than once; mindblock counts all of its plays.

After saving playlists, reopen the song select screen to see the changes.

Works on your downloaded maps. Each map is averaged over several runs.

## Building it

Built with the [oss!idle Addon SDK](https://github.com/oss-idle/addon-sdk).

The sim bundles the game's simulation from source, so it builds against a
checkout of the game. That checkout is the pinned submodule - a public release,
which is what the bundle's `gameVersion` claims - and not a working clone, which
carries unreleased work no server runs.

```sh
npm install

git submodule update --init --depth 1 vendor/oss-idle
npm install --prefix vendor/oss-idle

npm run verify     # typecheck, tests, build
```

`dist/oss-idle-sim.js` is the file to paste into the in-game add-on editor
(Options → Add-ons → Manage).

`npm run bench` prints where a sweep's time goes.

## Licence

AGPL-3.0-only. The add-on bundles oss!idle's simulation, which is AGPL-3.0.


# What this fork changes

This fork sits on top of v0.8.1 (`f3af4c7`) and carries four commits, one per
concern, in review order:

| # | Commit | Area | One-line summary |
|---|--------|------|------------------|
| 1 | `feat:` walls, range, chips, faster scans | engine + UI | the scan skips what the character cannot clear, and stays inside a chosen star window |
| 2 | `bench:` scan benchmarks | scripts | the measurements behind commit 1's speed claims |
| 3 | `build:` compact bundle | build | built addon 3.2 MB → 719.3 kB, under the in-game editor's paste limit |
| 4 | `docs:` this file | — | the map you are reading |

Every feature is opt-in or behavior-preserving where possible; the details,
per feature, are below. `npm run verify` on the final state: typecheck clean,
**126 checks pass** (30 plan + 37 walls + 3 pp + 10 compact + 26 rank +
15 character + 5 playlist), build = **736,610 bytes**.

---

## 1. Adaptive fail walls

*A sweep simulated every difficulty at every rate, bottom to top, and the top
of a big library is far beyond an early character — thousands of maps whose
simulation reports they die. Those rows are worthless to the ranking but cost
the same decode-and-simulate as any other.*

- Difficulties are bucketed by their share of long notes (0/25/50/75/100% LN,
  from stored `rice`/`ln` metadata, measured from the chart text as fallback).
  Star rating alone is a poor wall — a heavy LN chart reads far easier than
  its SR suggests to a character whose release/reading lag — so the wall is
  tracked per LN class.
- **3 consecutive failed difficulties** in one class (fail = more than half
  of the runs died, at the **slowest** simulated rate) wall off everything
  strictly harder **in that class**. A 1.0-SR span guard stops a sparse class
  from walling on scattered evidence. Walls never loosen (min-merge).
- Workers scan their slice in ascending star order; a wall found in any
  worker is broadcast to all workers mid-sweep and applied live.
- Opt-in per sweep — the "Skip failed maps & harder" checkbox, with a
  configurable "Fails in a row" count. The footer reports how many
  difficulties were skipped and each wall standing ("0% LN above 4.40").

**Files:** `src/engine/walls.ts` (new, all the logic + its docs),
`src/engine/protocol.ts` (`stars`/`bucket` on `SimRequest`, wall messages,
`adaptive`/`wallFails`), `src/engine/sim.worker.ts` (star-ordered queue,
pre-read wall skip, text-measured bucket fallback, slowest-rate verdict,
wall broadcast), `src/engine/client.ts` (round-robin partition so all workers
sweep the same star band, driver-side wall relay, `runSweep` options),
`src/ui/App.tsx` + `src/ui/styles.css` (settings, walls display, footer).
**Tests:** `scripts/walls-test.mjs` (37 checks).

## 2. Star rating range

*Most libraries pile up at low SR; a mid-range character cares about neither
end. A window like 3–5★ cuts most of the scan.*

- Two number inputs beside the Scan button ("any" = open bound). Bounds are
  inclusive; an unrated difficulty counts as 0, so it only survives a range
  with no minimum. Difficulties outside are counted in the survey
  (`skippedRange`) and reported ("N outside star range") rather than
  simulated. An inverted range disables Scan; an empty scan says which range
  produced it instead of the misleading "none are 4K mania".
- Per-map rescan (↻) deliberately ignores the range — the player asked for
  that map.

**Files:** `src/engine/client.ts` (`StarRange`, `planSweep` filter),
`src/ui/App.tsx` + `src/ui/styles.css`.
**Tests:** `scripts/plan-test.mjs` (+14 checks).

## 3. Target chips

*The Target tab was a dropdown — one skill, or pp. The ranking supports any
subset of skills, so the UI now offers toggle chips for exactly that.*

- Multi-toggle chips (any subset of skills; pp exclusive). Existing
  `targetSkill` settings migrate to the new shape on load.
- `FarmTarget` gains a `skills` subset, so a farm target can be "accuracy +
  tenacity" instead of one skill at a time.

**Files:** `src/ui/TargetPicker.tsx` (new), `src/ui/App.tsx`,
`src/farm/metrics.ts`, `src/ui/styles.css`.
**Tests:** `scripts/rank-test.mjs` (updated for the subset).

## 4. Faster scanning

*Profiled first (`scripts/scan-bench*.mjs`, `npm run bench:scan`): 91.5% of
scan time is `ManiaGame` construction — the game's own bot skill analysis,
untouched here. The optimizations target everything around it.*

- **Yield via `MessageChannel` instead of `setTimeout`** in the worker's
  rate loop: the timer round-trip cost ~1 ms per call (~20 s across a
  5000-map sweep × 4 rates); a port-to-port message is the same kind of
  macrotask turn at microseconds. `setTimeout` remains the fallback.
- **Hard-fail rate skip:** with "Skip failed maps & harder" on, a rate where
  *every* run failed ends that difficulty's rate loop — faster rates are
  strictly harder (the same monotonicity the wall verdict rests on), so
  their rows would be all-fail with even less XP. Measured 854 ms → 130 ms
  per hopeless map; clearable maps simulate identically. Off by default via
  the same toggle; per-map rescan is unaffected.
- **Worker cap 8 → 12** (`cores - 1` still honored, one core left to the game).

**Files:** `src/engine/sim.worker.ts`, `src/engine/client.ts`,
`src/ui/App.tsx` (tooltip documents the rate skip).
**Benchmarks:** `scripts/scan-bench.mjs`, `scan-bench2.mjs`, `scan-bench3.mjs`.

## 5. Compact bundle

*The in-game editor rejects pastes over roughly 1 MB; the built addon was
3.2 MB.*

- rosu-pp's wasm is deflate-compressed at build time and inflated via the
  native `DecompressionStream` (a `deflate1:` marker prefix selects this;
  plain base64 sources are still accepted, so the module is
  backward-compatible).
- zod, lingui and lzma are shimmed out of the bundle — the addon never
  parses those schemas, never translates, and decodes beatmaps only (no
  replays). Minify on.
- `npm run build` produces the compact bundle (736,610 bytes = 719.3 kB);
  `npm run build:full` keeps the original pipeline. `scripts/compact-test.mjs`
  bundles `pp.ts` through the compact pipeline and verifies pp/star values
  match the plain build byte-identically.

**Files:** `src/engine/pp.ts`, `scripts/build-compact.mjs`,
`scripts/compact-test.mjs`, plus the analysis tooling that found the weight
(`scripts/analyze-bundle.mjs`, `trace-imports.mjs`, `trace-worker.mjs`),
`package.json`.

---

## Building and verifying

```sh
git submodule update --init   # vendor/oss-idle — required for typecheck/tests
npm install
npm run verify                # typecheck + 126 checks + compact build
npm run build                 # dist/oss-idle-sim.js, 719.3 kB — the single
                              # file pasted into the game's in-game editor
```

`dist/` is gitignored (upstream convention); the single-file addon is
reproduced from source by the build, which is the whole point of this fork:
source of truth in the repo, one script out of the pipeline.

## Compatibility notes

- The built addon is a drop-in replacement: same mount shape, same settings
  keys (old `targetSkill` values migrate), same results for clearable maps.
- A per-map rescan always runs the full rate fan-out, ignores walls and
  ignores the star range — it is a player's explicit request for that map.
- The fail-wall and rate-skip behaviors are gated behind one checkbox and
  default off; a sweep with it unchecked behaves exactly like v0.8.1 apart
  from being faster at yielding.
