/**
 * The simulation worker.
 *
 * Runs oss!idle's own simulation - the same `CharacterBot` + `ManiaGame` the
 * server uses to produce an authoritative score - over a batch of charts, and
 * reports what each play would be worth in XP.
 *
 * It runs off the main thread because the game is a rhythm game sharing this
 * page: simulating a few hundred maps takes seconds of solid CPU, and doing
 * that on the main thread would stutter audio and input. Results stream back in
 * chunks so the overlay can fill in as it goes rather than waiting for the sweep.
 *
 * The bundler inlines this file into the add-on as a string (`worker:` import),
 * since a Blob-loaded add-on has no URL to load a separate worker file from.
 */

// Side-effect import, exactly as every decode site in the game does it.
// osu-classes' `groupAt` re-sorts the whole control-point list on each
// insertion, so decoding is quadratic in control points: an SV-heavy chart
// (Camellia - Singularity carries ~23 400 timing points) takes ~3.6s instead of
// ~70ms. Over a whole library that is minutes of the sweep spent in the parser.
import '@oss-idle/shared/osu/controlPointPatch';
import { BeatmapDecoder } from 'osu-parsers';
import type { Beatmap } from 'osu-classes';
import { ManiaGame, LEAD_IN_MS } from '@oss-idle/shared/sim/maniaGame';
import CharacterBot from '@oss-idle/shared/sim/bots/character';
import { makeOrderedSkills } from '@oss-idle/shared/sim/skills/factory';
import Memory from '@oss-idle/shared/sim/skills/memory';
import { beatmapStore } from '@oss-idle/addon-sdk';
import { ppChart, ppReady, type PPChart } from './pp.js';
import {
        DEFAULT_WALL_FAILS,
        FailWalls,
        lnBucketFromRatio,
        lnRatioFromText,
        WALL_FAIL_RATE,
} from './walls.js';
import type {
        SimError,
        SimRequest,
        SimResult,
        WorkerRequest,
        WorkerResponse,
} from './protocol.js';

const decoder = new BeatmapDecoder();

/** Stream results back in chunks this size, so the table fills as it goes. */
const CHUNK = 8;

/** How many sets' charts to keep read, see `run`. Maps beyond an LRU this size
 *  are re-read, which is cheap next to a decode. */
const SET_CACHE = 12;

let cancelled = false;

/**
 * The fail walls standing in *this* worker's slice of the scan.
 *
 * Module scope, not a local, so the driver's broadcasts (`wall` messages) merge
 * into the live run: they arrive between this loop's `await` points, and a run
 * without them would keep simulating difficulties a sibling already walled.
 */
let walls = new FailWalls(DEFAULT_WALL_FAILS);

const post = (message: WorkerResponse) => (self as unknown as Worker).postMessage(message);

/**
 * Give the event loop a turn. The game's skills update through async `Synced`
 * listeners, and their pending promises keep a whole play alive until the loop
 * runs - dozens of plays of one map without a turn run the worker out of memory.
 *
 * Through a `MessageChannel` rather than `setTimeout`: the timer round-trip
 * costs ~1ms a call (the scan pays it once per rate, so a 5000-map sweep burns
 * ~20 seconds just yielding), while a port-to-port message is the same kind of
 * macrotask turn at a few microseconds. Anything without `MessageChannel`
 * (nothing we know of) falls back to the timer.
 */
const yieldChannel: MessageChannel | undefined =
        typeof MessageChannel !== 'undefined' ? new MessageChannel() : undefined;
const settle = () => new Promise<void>(resolve => {
        if (!yieldChannel) {
                setTimeout(resolve);
                return;
        }
        // Sequential awaits keep the one handler slot coherent: each call replaces
        // the previous handler, which can no longer fire.
        yieldChannel.port1.onmessage = () => resolve();
        yieldChannel.port2.postMessage(0);
});

/**
 * Rebuild the player's skills from a stored `character` row.
 *
 * Mirrors the client's `Character` constructor: the row keeps one column group
 * per skill, and the factory produces the objects the bot expects.
 *
 * `timesPlayed` seeds the memory skill, which the client does separately (it is
 * per map, not per character). Memory trains on the *transition* from unknown to
 * memorised - its XP weight is a hump that is zero on a fresh map and zero again
 * on a mastered one - so leaving this at its default 0 means memory earns
 * nothing anywhere, on every map.
 */
const skillsFrom = (row: Record<string, unknown>, timesPlayed: number) => {
        const skills = makeOrderedSkills();
        for (const skill of skills) {
                const set = (field: 'level' | 'xp' | 'upgrades' | 'overdrive' | 'prestige', column: string) => {
                        const value = row[column];
                        if (typeof value === 'number') skill[field].set(value);
                };
                set('level', skill.name);
                set('xp', `${skill.name}XP`);
                set('upgrades', `${skill.name}Upgrades`);
                set('overdrive', `${skill.name}Overdrive`);
                set('prestige', `${skill.name}Prestige`);
                if (skill instanceof Memory) skill.timesPlayed.set(timesPlayed);
        }
        return skills;
};

/**
 * Simulate one chart `runs` times and average the result.
 *
 * The play is advanced straight past the end rather than stepped: the game only
 * needs intermediate samples to stream a replay, and we want the final score. A
 * run past `songEndMs` guarantees every note - including a trailing long note's
 * tail - has been judged.
 *
 * Averaging is not optional polish. The bot samples its hit error, so one run of
 * a chart is a draw from a distribution, not a measurement: spread runs 4-17% of
 * total XP, worst on maps the character is only just holding together. Ranking
 * maps against each other on single draws would shuffle the top of the table
 * every scan.
 *
 * The chart is decoded once per map and replayed at every rate, since decoding
 * costs more than the simulation does. A rate runs as the server's
 * `simulateAndStore` does: notes sped up by the game, XP over the play's real
 * length, pp at that clock rate.
 */
const decode = (chartText: string): Beatmap => {
        const chart = decoder.decodeFromString(chartText);
        // The game's `buildBarlines` steps through each timing section by the raw
        // `beatLengthUnlimited`, so a gimmick timing point (beatLength ~1e-7ms) makes
        // it push billions of barlines and the worker runs out of memory. Barlines are
        // drawing only, and every other reader uses the clamped `beatLength` (6 to
        // 60000ms), so clamping the raw value leaves the result unchanged.
        for (const tp of chart.controlPoints.timingPoints) tp.beatLengthUnlimited = tp.beatLength;
        return chart;
};

const simulate = (
        chart: Beatmap,
        rate: number,
        character: Record<string, unknown>,
        divine: boolean,
        runs: number,
        pp: PPChart,
        timesPlayed: number,
): Omit<SimResult, 'setId' | 'beatmapId'> => {
        const totals: Record<string, number> = {};
        const grades: string[] = [];
        let accuracy = 0;
        let duration = 0;
        let failures = 0;
        let ppTotal = 0;
        const totalsPerRun: number[] = [];

        for (let run = 0; run < runs; run++) {
                const bot = new CharacterBot(
                        skillsFrom(character, timesPlayed),
                        chart.difficulty.overallDifficulty,
                );
                // Only `divine` and `rate` - exactly what the server passes in `simulateAndStore`,
                // and what the client's local play passes. `scrollMs` is left at its
                // default (600): it is the bot's visibility span, a constant of the
                // simulation, not the player's scroll-speed setting. Only the live
                // renderer passes that, because it is about drawing.
                const game = new ManiaGame(chart, bot, { divine, rate });

                game.update(game.songEndMs + 2000);

                const score = game.score;
                const xp = bot.getSkillsXP(chart.totalLength / rate, score) as Record<string, number>;

                let runTotal = 0;
                for (const [skill, value] of Object.entries(xp)) {
                        totals[skill] = (totals[skill] ?? 0) + value;
                        runTotal += value;
                }
                totalsPerRun.push(runTotal);

                // A failed play stops where HP ran out, so it costs less time *and* earns
                // less - both halves matter to an XP-per-second ranking.
                const lastNoteEnd = game.notes.reduce(
                        (max, note) => Math.max(max, note.hold ? note.endTime : note.time),
                        0,
                );
                const failed = score.failed;
                if (failed) failures++;
                const endMs = failed && score.failedIndex > 0
                        ? (game.hits[score.failedIndex - 1]?.time ?? lastNoteEnd)
                        : lastNoteEnd;

                accuracy += score.accuracy;
                duration += (LEAD_IN_MS + endMs) / 1000;
                grades.push(String(score.grade));
                ppTotal += pp.calculate(score, rate);
        }

        const xp: Record<string, number> = {};
        for (const [skill, sum] of Object.entries(totals)) xp[skill] = sum / runs;
        const totalXp = totalsPerRun.reduce((sum, value) => sum + value, 0) / runs;

        // Report how noisy the mean is, so a close ranking can be read with the
        // right amount of confidence.
        const variance = totalsPerRun.reduce((sum, value) => sum + (value - totalXp) ** 2, 0) / runs;
        const variation = totalXp > 0 ? Math.sqrt(variance) / totalXp : 0;

        grades.sort();

        return {
                rate,
                stars: pp.stars(rate),
                xp,
                totalXp,
                durationSec: duration / runs,
                accuracy: accuracy / runs,
                grade: grades[Math.floor(grades.length / 2)] ?? 'D',
                pp: ppTotal / runs,
                runs,
                failRate: failures / runs,
                variation,
        };
};

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
        const message = event.data;

        if (message.type === 'cancel') {
                cancelled = true;
                return;
        }

        // A wall tripped in another worker's slice. Walls only tighten, so applying
        // this mid-run is safe: the worst a late arrival does is leave a few
        // difficulties simulated that need not have been.
        if (message.type === 'wall') {
                walls.merge(message);
                return;
        }

        cancelled = false;
        walls = new FailWalls(message.wallFails);
        void run(message);
};

/**
 * Work through this worker's slice of the library.
 *
 * The slice is walked in **star order, lowest first** - the driver sends it
 * sorted, and the order is enforced again here because the fail walls stand
 * on it: only a difficulty *above* where the character has failed can be
 * skipped, so an out-of-order slice would simulate maps it could have skipped
 * and judge maps it had no results for yet.
 *
 * Charts are read per set and kept in a small LRU. Star order interleaves sets
 * - a set's difficulties usually cluster in star rating, but nothing says they
 * must - and holding every set read at once would be the whole library in
 * memory, exactly what reading charts worker-side exists to avoid. A set that
 * falls out of the cache is simply re-read, which is cheap next to the decode
 * it spares. Failed reads are not cached, so a broken set's error is reported
 * faithfully per difficulty rather than remembered as one blanket failure.
 */
const run = async (message: Extract<WorkerRequest, { type: 'run' }>): Promise<void> => {
        const { batch, character, divine, runs, rates, playCounts, adaptive } = message;

        // One wasm init per worker, before any chart is parsed for pp.
        const ppAvailable = await ppReady();

        try {
                const queue = [...batch].sort((a, b) => (a.stars ?? 0) - (b.stars ?? 0));

                /** Charts already read this run; insertion order is recency. */
                const read = new Map<number, Record<number, string>>();

                const chartsFor = async (setId: number): Promise<Record<number, string>> => {
                        const cached = read.get(setId);
                        if (cached !== undefined) {
                                read.delete(setId);
                                read.set(setId, cached);
                                return cached;
                        }
                        const charts = await beatmapStore.charts(setId);
                        read.set(setId, charts);
                        if (read.size > SET_CACHE) {
                                const oldest = read.keys().next();
                                if (!oldest.done) read.delete(oldest.value);
                        }
                        return charts;
                };

                let results: SimResult[] = [];
                let errors: SimError[] = [];
                let done = 0;
                let skipped = 0;
                let skippedAtFlush = 0;

                const flush = () => {
                        post({ type: 'progress', done, total: batch.length, results, errors, skipped });
                        results = [];
                        errors = [];
                        skippedAtFlush = skipped;
                };

                /** Count one difficulty skipped by a wall, streaming progress in chunks. */
                const skip = () => {
                        skipped++;
                        if (results.length + errors.length + skipped - skippedAtFlush >= CHUNK) flush();
                };

                for (const request of queue) {
                        if (cancelled) break;
                        done++;

                        const stars = request.stars ?? 0;
                        let bucket = request.bucket ?? -1;

                        // Beyond a wall already: not even the chart is read.
                        if (adaptive && walls.shouldSkip(bucket, stars)) {
                                skip();
                                continue;
                        }

                        let chart: string | undefined;
                        try {
                                chart = (await chartsFor(request.setId))[request.beatmapId];
                        } catch (e) {
                                // The whole set is unreadable - report this difficulty and move on.
                                errors.push({
                                        setId: request.setId, beatmapId: request.beatmapId,
                                        message: e instanceof Error ? e.message : String(e),
                                });
                                if (results.length + errors.length >= CHUNK) flush();
                                continue;
                        }

                        // No LN class in the metadata - measure it from the text now that
                        // it is in hand, then check the walls again with the real class.
                        if (chart && bucket < 0) {
                                const ratio = lnRatioFromText(chart);
                                if (ratio !== undefined) bucket = lnBucketFromRatio(ratio);
                                if (adaptive && walls.shouldSkip(bucket, stars)) {
                                        skip();
                                        continue;
                                }
                        }

                        if (!chart) {
                                errors.push({ setId: request.setId, beatmapId: request.beatmapId, message: 'no stored chart' });
                        } else {
                                // Parsed once per map and freed after: wasm objects outlive
                                // their JS wrappers, and a sweep sees a thousand maps.
                                const pp = ppChart(chart, ppAvailable);
                                try {
                                        const decoded = decode(chart);
                                        // The difficulty's verdict for the walls comes from its
                                        // *slowest* simulated rate: dying at x1.4 is the rate's
                                        // ambition, not the map's difficulty, and only a map that
                                        // cannot be cleared even slowed down says anything about
                                        // what lies above it.
                                        let verdict: number | undefined;
                                        for (const rate of rates) {
                                                if (cancelled) break;
                                                await settle();
                                                const result: SimResult = {
                                                        setId: request.setId,
                                                        beatmapId: request.beatmapId,
                                                        ...simulate(
                                                                decoded, rate, character, divine, Math.max(1, runs || 1), pp,
                                                                playCounts[request.beatmapId] ?? 0,
                                                        ),
                                                };
                                                if (verdict === undefined) verdict = result.failRate;
                                                results.push(result);
                                                // Every run failed even at this rate: the rates above
                                                // it are strictly harder (the same logic the walls'
                                                // verdict rests on), so their rows would be failures
                                                // with even less XP - not worth the constructions.
                                                // Off with `adaptive`, so a player who wants every
                                                // failed row at every rate keeps getting them.
                                                if (adaptive && result.failRate >= 1) break;
                                        }
                                        if (adaptive && verdict !== undefined) {
                                                const tripped = walls.report(bucket, stars, verdict <= WALL_FAIL_RATE);
                                                if (tripped) post({ type: 'wall', ...tripped });
                                        }
                                } catch (e) {
                                        // One unparseable or exotic chart must not end the sweep.
                                        errors.push({
                                                setId: request.setId, beatmapId: request.beatmapId,
                                                message: e instanceof Error ? e.message : String(e),
                                        });
                                } finally {
                                        pp.free();
                                }
                        }

                        if (results.length + errors.length + skipped - skippedAtFlush >= CHUNK) flush();
                }

                if (results.length || errors.length || skipped > skippedAtFlush) flush();
                post({ type: cancelled ? 'cancelled' : 'done' });
        } catch (e) {
                post({ type: 'fatal', message: e instanceof Error ? e.message : String(e) });
        }
};
