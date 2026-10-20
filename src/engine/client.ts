/**
 * Main-thread driver for the simulation worker.
 *
 * Charts are read here rather than in the worker so a single IndexedDB read
 * serves a whole set, and are streamed over in batches. Results arrive in
 * chunks, so a sweep of a large library fills the table progressively instead
 * of blocking on the whole run.
 */

import {
        beatmapStore,
        gameCharacter,
        playCountsSince,
        type CharacterRow,
} from '@oss-idle/addon-sdk';
import { medalXPMultiplier } from '@oss-idle/shared/achievements/catalogue';
import { hasUnlock } from '@oss-idle/shared/rebirth';
import { rateSteps } from '@oss-idle/shared/rate';
import createSimWorker from 'worker:./sim.worker';
import { DEFAULT_WALL_FAILS, FailWalls, lnBucket, type Wall } from './walls.js';
import type {
        SimError,
        SimRequest,
        SimResult,
        WorkerRequest,
        WorkerResponse,
} from './protocol.js';

type SweepProgress = {
        done: number;
        total: number;
        results: SimResult[];
        errors: SimError[];
        /** Difficulties skipped by fail walls so far, across every worker. */
        skipped: number;
        /** Every wall standing so far - see `walls.ts`. */
        walls: Wall[];
};

export type Sweep = {
        /** Resolves when the sweep finishes or is cancelled. */
        finished: Promise<{
                results: SimResult[];
                errors: SimError[];
                cancelled: boolean;
                skipped: number;
                walls: Wall[];
        }>;
        cancel: () => void;
};

/** Only 4K mania difficulties are playable, so only those are worth simulating. */
const isSimulatable = (version: { mode: number; keys: number }) =>
        version.mode === 3 && version.keys === 4;

/**
 * What the sweep found, and what it discarded.
 *
 * An empty result has several very different causes - nothing downloaded, only
 * non-4K difficulties stored, everything outside the requested star range, or
 * charts missing next to their metadata - and they call for different fixes,
 * so the counts are reported rather than collapsed into "no maps found".
 */
type LibrarySurvey = {
        sets: number;
        versions: number;
        /** Difficulties excluded for not being 4K mania. */
        skippedMode: number;
        /** Difficulties already listed by an earlier set - see {@link planSweep}. */
        duplicates: number;
        /** Difficulties outside the requested star range - see {@link planSweep}. */
        skippedRange: number;
        requests: SimRequest[];
};

/** The shape {@link planSweep} needs from a stored set. */
type PlannableSet = {
        id: number;
        versions?: {
                id: number;
                mode: number;
                keys: number;
                /** Star rating as the catalog lists it - the x1 basis of the scan order. */
                difficulty?: number;
                /** Tap and long-note counts, kept per difficulty since the game's backfill. */
                rice?: number;
                ln?: number;
        }[];
};

/** The window of star ratings a sweep was asked to stay inside. */
export type StarRange = {
        /** Lowest star rating to simulate - 0 (or unset) for no lower bound. */
        min?: number;
        /** Highest star rating to simulate - 0 (or unset) for no upper bound. */
        max?: number;
};

/**
 * Decide what to simulate from the stored set metadata.
 *
 * **Each difficulty is listed at most once.** A `beatmapId` can appear under
 * more than one stored set - a set re-downloaded after an update can leave the
 * old record behind, and a set's `versions` array is not itself guaranteed
 * distinct. Simulating such a difficulty twice puts two rows with the same
 * identity in the table, which is not merely cosmetic: the results list is keyed
 * by `beatmapId`, and duplicate keys make React reuse the wrong rows when the
 * ranking re-sorts, so stale rows survive at stale positions above the real
 * ordering.
 *
 * A star **range** may be supplied to keep the sweep to a window of the library
 * - most libraries pile up at low ratings, and a mid-range character cares
 * about neither end. The bounds are inclusive; an unset bound is no bound.
 * Difficulties outside are counted in `skippedRange`, not simulated. A
 * difficulty the game never rated counts as 0, so it only survives a range
 * with no minimum.
 *
 * Pure, so this is testable without a beatmap store.
 *
 * The list comes out **sorted by star rating, lowest first** (unrated maps
 * first, since nothing can be said about them). The ranking is order-blind,
 * but the scan is not: the table fills in from the maps worth playing, and -
 * the reason for the order - fail walls can only skip difficulties *above*
 * where the character has already failed. A descending or shuffled order
 * would have to simulate everything before it could skip anything.
 */
export const planSweep = (sets: readonly PlannableSet[], range?: StarRange): LibrarySurvey => {
        const survey: LibrarySurvey = {
                sets: sets.length,
                versions: 0,
                skippedMode: 0,
                duplicates: 0,
                skippedRange: 0,
                requests: [],
        };

        const min = range?.min ?? 0;
        const max = range?.max ?? 0;

        const seen = new Set<number>();

        for (const set of sets) {
                const versions = set.versions ?? [];
                survey.versions += versions.length;

                for (const version of versions) {
                        if (!isSimulatable(version)) {
                                survey.skippedMode++;
                                continue;
                        }
                        if (seen.has(version.id)) {
                                survey.duplicates++;
                                continue;
                        }
                        seen.add(version.id);
                        const stars = Number(version.difficulty) || 0;
                        if (stars < min || (max > 0 && stars > max)) {
                                survey.skippedRange++;
                                continue;
                        }
                        survey.requests.push({
                                setId: set.id,
                                beatmapId: version.id,
                                stars,
                                bucket: lnBucket(version.rice, version.ln),
                        });
                }
        }

        survey.requests.sort((a, b) => (a.stars ?? 0) - (b.stars ?? 0));
        return survey;
};

/**
 * List every stored 4K difficulty worth simulating, inside a star range.
 *
 * Only metadata is read here. The charts themselves are loaded by the workers,
 * so a large library never has to sit in main-thread memory - a difficulty whose
 * chart turns out to be missing is reported as a per-map error instead.
 */
export const collectCharts = async (range?: StarRange): Promise<LibrarySurvey> =>
        planSweep(await beatmapStore.sets(), range);

/**
 * How many workers to run.
 *
 * The strain analysis is the sweep's real cost and is inherently per-attempt, so
 * the way to make a sweep faster is to run several at once. One core is left to
 * the game: it is still rendering and playing audio while this runs, and taking
 * every core makes the sweep marginally faster at the cost of the thing the
 * player is actually doing.
 *
 * The cap sits at 12 rather than the machine's full count so a many-core box
 * does not spend half its memory on wasm heaps and chart caches for a
 * diminishing slice of throughput - past roughly a dozen workers the sweep is
 * I/O-bound on the beatmap store anyway.
 */
const workerCount = (): number => {
        const cores = navigator.hardwareConcurrency || 2;
        return Math.max(1, Math.min(cores - 1, 12));
};

/** Deal jobs round-robin, so every worker sweeps the same star band at the
 *  same time. Ascending star order makes that matter: a wall one worker trips
 *  at 4.4 stars is immediately useful to every other worker, which is all still
 *  down there too. Contiguous slices instead would put each worker in its own
 *  band, and a wall would only ever cover the band it was found in. */
const partition = <T>(items: readonly T[], parts: number): T[][] => {
        const slices: T[][] = Array.from({ length: parts }, () => []);
        items.forEach((item, i) => slices[i % parts]!.push(item));
        return slices;
};

/** The rates to simulate: every one the character's Speed upgrades unlock, but `excluded`. */
export const ratesFor = (speedUpgrades: number, excluded: readonly number[]): number[] =>
        rateSteps(speedUpgrades).filter(rate => !excluded.includes(rate));

/** Simulate the current character against every stored 4K chart. */
export const runSweep = async (
        batch: SimRequest[],
        {
                runs = 3,
                characterId,
                excludedRates = [],
                adaptive = false,
                wallFails = DEFAULT_WALL_FAILS,
        }: {
                runs?: number;
                characterId?: number;
                excludedRates?: readonly number[];
                /** Track fail walls and skip difficulties beyond them - see `walls.ts`. */
                adaptive?: boolean;
                /** How many consecutive failures in one LN class trip a wall. */
                wallFails?: number;
        } = {},
        onProgress?: (progress: SweepProgress) => void,
): Promise<Sweep> => {
        // Which character to simulate is the player's choice when they have made
        // one, because the client's own answer lives in module state we cannot read.
        const character = characterId !== undefined
                ? await gameCharacter.byId(characterId)
                : await gameCharacter.live();
        if (!character) throw new Error('No character found in the game database.');

        // Memory trains per map, from how often this character has played it since
        // memory was last prestiged.
        const playCounts = await playCountsSince(
                Number(character.id),
                Number(character.memoryResetAt) || 0,
        );

        const slices = partition(batch, Math.min(workerCount(), batch.length || 1))
                .filter(slice => slice.length);
        const workers = slices.map(() => createSimWorker());

        const results: SimResult[] = [];
        const errors: SimError[] = [];
        // Progress is the sum across workers, each of which counts only its own slice.
        const doneByWorker = new Array<number>(workers.length).fill(0);
        const skippedByWorker = new Array<number>(workers.length).fill(0);
        // The driver's own copy of the walls, min-merged from every worker's report:
        // one place that knows what the sweep as a whole has ruled out.
        const walls = new FailWalls(wallFails);
        let cancelled = false;
        let live = workers.length;

        type Settled = { results: SimResult[]; errors: SimError[]; cancelled: boolean; skipped: number; walls: Wall[] };
        let settle: (value: Settled) => void;
        let fail: (reason: unknown) => void;
        const finished = new Promise<Settled>((resolve, reject) => { settle = resolve; fail = reject; });

        const skipped = () => skippedByWorker.reduce((sum, n) => sum + n, 0);

        const retire = (worker: Worker) => {
                worker.terminate();
                if (--live === 0) settle({ results, errors, cancelled, skipped: skipped(), walls: walls.list });
        };

        const abort = (reason: unknown) => {
                for (const worker of workers) worker.terminate();
                live = 0;
                fail(reason);
        };

        workers.forEach((worker, index) => {
                worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
                        const message = event.data;
                        switch (message.type) {
                                case 'progress':
                                        results.push(...message.results);
                                        errors.push(...message.errors);
                                        doneByWorker[index] = message.done;
                                        skippedByWorker[index] = message.skipped;
                                        onProgress?.({
                                                done: doneByWorker.reduce((sum, n) => sum + n, 0),
                                                total: batch.length,
                                                results: message.results,
                                                errors: message.errors,
                                                skipped: skipped(),
                                                walls: walls.list,
                                        });
                                        break;
                                case 'wall':
                                        // Relay to every worker, the finder included: each
                                        // merges by minimum, so this is a no-op where the
                                        // wall is already known and a skip everywhere it
                                        // is not.
                                        walls.merge(message);
                                        for (const other of workers) {
                                                other.postMessage(message satisfies WorkerRequest);
                                        }
                                        onProgress?.({
                                                done: doneByWorker.reduce((sum, n) => sum + n, 0),
                                                total: batch.length,
                                                results: [],
                                                errors: [],
                                                skipped: skipped(),
                                                walls: walls.list,
                                        });
                                        break;
                                case 'cancelled':
                                        cancelled = true;
                                        retire(worker);
                                        break;
                                case 'done':
                                        retire(worker);
                                        break;
                                case 'fatal':
                                        abort(new Error(message.message));
                                        break;
                        }
                };

                worker.onerror = (event) => abort(new Error(event.message || 'simulation worker crashed'));

                worker.postMessage({
                        type: 'run',
                        character: character as unknown as Record<string, unknown>,
                        divine: hasUnlock(Number(character.generation) || 1, 'DIVINE'),
                        runs,
                        rates: ratesFor(Number(character.speedUpgrades) || 0, excludedRates),
                        playCounts,
                        batch: slices[index]!,
                        workerId: index,
                        adaptive,
                        wallFails,
                } satisfies WorkerRequest);
        });

        return {
                finished,
                cancel: () => {
                        for (const worker of workers) {
                                worker.postMessage({ type: 'cancel' } satisfies WorkerRequest);
                        }
                },
        };
};

/** The game's production API, as baked into its client build. */
const API_URL = 'https://api.oss.idle.rhythmgamers.net';

/**
 * XP multiplier from the medals a character holds, or `undefined` when the
 * server cannot be reached.
 *
 * Medals are awarded and stored by the server only, so a guest character holds
 * none, and an account character's set is read from its public profile.
 */
export const medalMultiplier = async (character: CharacterRow): Promise<number | undefined> => {
        if (character.local) return 1;
        try {
                const res = await fetch(`${API_URL}/v1/characters/${character.id}/medals`);
                if (!res.ok) return undefined;
                const { held } = await res.json() as { held: { id: string }[] };
                return medalXPMultiplier(held.map(medal => medal.id));
        } catch {
                return undefined;
        }
};

export type MapInfo = {
        setId: number;
        beatmapId: number;
        title: string;
        artist: string;
        creator: string;
        version: string;
        difficulty: number;
        lengthSec: number;
        bpm: number;
        objects: number;
};

/**
 * Display metadata for every stored 4K difficulty, by beatmap id.
 *
 * Kept apart from {@link collectCharts} so the table can label rows without
 * holding every chart's text in memory alongside the results.
 */
export const libraryIndex = async (): Promise<Map<number, MapInfo>> => {
        const index = new Map<number, MapInfo>();
        for (const { set, version } of await beatmapStore.difficulties()) {
                if (!isSimulatable(version)) continue;
                index.set(version.id, {
                        setId: set.id,
                        beatmapId: version.id,
                        title: set.title,
                        artist: set.artist,
                        creator: set.creator,
                        version: version.version,
                        difficulty: version.difficulty,
                        lengthSec: version.total_length,
                        bpm: version.bpm,
                        objects: version.objects,
                });
        }
        return index;
};
