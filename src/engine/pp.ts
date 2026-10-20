/**
 * Performance points for a simulated play.
 *
 * pp comes from rosu-pp, which is WebAssembly. A Blob-loaded add-on cannot fetch
 * a sibling asset, so the binary is imported as base64 and inlined into the
 * bundle (the build's `.wasm` loader), then decoded once and handed to the
 * module's init as a `BufferSource` - the same `InitInput` the client's
 * `osu/rosu.ts` satisfies with a URL.
 *
 * This mirrors the client's `osu/pp.ts`: same inputs, same `lazer: false`, same
 * accuracy clamp (a pure divine play reads above 1, outside rosu-pp's domain).
 *
 * rosu-pp objects are wasm-backed and are **not** garbage collected with the JS
 * wrapper, so everything created here is freed explicitly. A sweep builds one
 * per map across a thousand maps; leaking them exhausts the wasm heap.
 */

import init, * as ppjs from 'rosu-pp-js-web';
import wasmSource from 'rosu-pp-js-web/rosu_pp_js_bg.wasm?base64';

/**
 * The wasm binary as shipped in this bundle.
 *
 * The compact build swaps the base64 blob for a **deflate-raw** compressed
 * one, marked with this prefix - raw base64 never contains a colon, so the
 * prefix is unambiguous. The plain build (and the tests) embed the ordinary
 * base64 of the raw binary, which lands here without the prefix.
 *
 * Compressed, the 808 kB binary travels as ~226 kB (~301 kB base64); the
 * decompression is native (`DecompressionStream`, Chrome 103 / Firefox 113 /
 * Safari 16.4 and later) and costs a few ms once per worker. A browser without
 * it falls into the same `false` as any other failed init: pp and stars read 0
 * and the scan otherwise runs on metadata star ratings.
 */
const DEFLATE_PREFIX = 'deflate1:';

const wasmBytes = async (source: string): Promise<Uint8Array> => {
        if (!source.startsWith(DEFLATE_PREFIX)) {
                return Uint8Array.from(atob(source), c => c.charCodeAt(0));
        }
        const compressed = Uint8Array.from(
                atob(source.slice(DEFLATE_PREFIX.length)),
                c => c.charCodeAt(0),
        );
        const stream = new Blob([compressed])
                .stream()
                .pipeThrough(new DecompressionStream('deflate-raw'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
};

/** The score fields rosu-pp needs - satisfied by the sim's `ScoreState`. */
type PPScore = {
        score: number;
        accuracy: number;
        maxCombo: number;
        counts: Record<string, number>;
};

let ready: Promise<boolean> | undefined;

/**
 * Load the wasm module once.
 *
 * Resolves `false` rather than throwing if it cannot: pp is one column, and
 * losing it must not take down a sweep that is otherwise fine.
 */
export const ppReady = (): Promise<boolean> => ready ??= (async () => {
        try {
                const bytes = await wasmBytes(wasmSource);
                // The object form; passing the buffer positionally still works but logs a
                // deprecation warning into the player's console on every sweep.
                await init({ module_or_path: bytes });
                return true;
        } catch (e) {
                console.error('[farm] rosu-pp failed to load; pp will read 0', e);
                return false;
        }
})();

/**
 * A chart parsed by rosu-pp, reusable across the runs of one map.
 *
 * Parsing is the expensive half, and it does not depend on the play - so it is
 * done once per map and the (cheap) performance calculation repeated per run.
 */
export type PPChart = {
        calculate(score: PPScore, rate?: number): number;
        stars(rate?: number): number;
        free(): void;
};

const NOOP_CHART: PPChart = { calculate: () => 0, stars: () => 0, free: () => {} };

/** Parse a chart for pp. Returns a no-op chart if rosu is unavailable or refuses it. */
export const ppChart = (chartText: string, available: boolean): PPChart => {
        if (!available) return NOOP_CHART;

        let map: ppjs.Beatmap;
        try {
                map = new ppjs.Beatmap(chartText);
        } catch {
                // rosu rejects charts it considers unsuitable for calculation.
                return NOOP_CHART;
        }

        return {
                calculate(score, rate = 1) {
                        let performance: ppjs.Performance | undefined;
                        let attributes: ppjs.PerformanceAttributes | undefined;
                        try {
                                performance = new ppjs.Performance({
                                        lazer: false,
                                        clockRate: rate,
                                        legacyTotalScore: Math.floor(score.score),
                                        accuracy: Math.min(1, score.accuracy),
                                        combo: score.maxCombo,
                                        nGeki: (score.counts.MARVELOUS ?? 0) + (score.counts.DIVINE ?? 0),
                                        n300: score.counts.PERFECT ?? 0,
                                        nKatu: score.counts.GREAT ?? 0,
                                        n100: score.counts.GOOD ?? 0,
                                        n50: score.counts.BAD ?? 0,
                                        misses: score.counts.MISS ?? 0,
                                });
                                attributes = performance.calculate(map);
                                return attributes.pp;
                        } catch {
                                return 0;
                        } finally {
                                attributes?.free();
                                performance?.free();
                        }
                },
                stars(rate = 1) {
                        let difficulty: ppjs.Difficulty | undefined;
                        let attributes: ppjs.DifficultyAttributes | undefined;
                        try {
                                difficulty = new ppjs.Difficulty({ lazer: false, clockRate: rate });
                                attributes = difficulty.calculate(map);
                                return attributes.stars;
                        } catch {
                                return 0;
                        } finally {
                                attributes?.free();
                                difficulty?.free();
                        }
                },
                free: () => map.free(),
        };
};
