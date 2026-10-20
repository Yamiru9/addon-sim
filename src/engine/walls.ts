/**
 * Adaptive fail walls: skipping the part of a library the character cannot
 * clear, without trusting star rating alone.
 *
 * A sweep simulated every difficulty at every rate, bottom to top, and the top
 * of a big library is far beyond an early character - thousands of maps whose
 * simulation reports they die. Those maps are worthless to the ranking, but
 * they cost the same decode-and-simulate as any other. The fix is a *wall*:
 * once the character has failed a few maps in a row at increasing difficulty,
 * everything harder is skipped without being read.
 *
 * Star rating alone is a poor wall, because SR does not say *why* a map is
 * hard: a heavy long-note chart reads far easier than its SR suggests to a
 * character whose release/reading lag behind, and the other way round for
 * rice. So walls are tracked **per LN class** - difficulties bucketed by their
 * share of long notes - and failing three rice maps in a row walls only the
 * rice class above that SR, while long-note maps above it are still scanned.
 *
 * The classes snap to the fifths of the LN-share scale - 0%, 25%, 50%, 75%,
 * 100% - so a map lands in the class it is nearest, and "0% LN" is rice.
 */

/**
 * How many consecutive failed maps in one class it takes to wall it.
 *
 * One fail proves nothing - the simulation is stochastic - and two is still a
 * coin flip on a borderline map; three in a row, none of them cleared even at
 * the slowest simulated rate, is a character genuinely out of their depth.
 */
export const DEFAULT_WALL_FAILS = 3;

/**
 * The share of runs that must die for a difficulty to count as failed - the
 * same line the ranking's "hide maps you usually fail" draws. A difficulty
 * that dies half the time is a coin flip, not a wall; more than half, and it
 * is beyond the character.
 */
export const WALL_FAIL_RATE = 0.5;

/**
 * How wide a run of consecutive failures may be, in star rating, to count as
 * evidence of a wall.
 *
 * Classes are unevenly populated - rice is most of most libraries - but a
 * sparse class can fail at 2★, 5★ and 9★ with no map of it in between. Those
 * are three separate defeats, not a wall, and walling at 9★ from them would
 * skip half a library on no evidence. A run that wide resets instead.
 */
export const WALL_SPAN = 1.0;

export type Wall = {
        /** Which LN class walled, see {@link lnBucket}. */
        bucket: number;
        /** The star rating it walled at: everything strictly above is skipped. */
        stars: number;
};

/**
 * Which fifth of the LN-share scale a difficulty lands in: 0 rice, 4 all LN.
 *
 * Counts come straight from stored set metadata (`rice` / `ln`), which the
 * game fills per difficulty at download time. Both unknown gives `-1` - the
 * class is then measured from the chart text in the worker - and a chart with
 * no notes at all has no class either.
 */
export const lnBucket = (rice: number | undefined, ln: number | undefined): number => {
        const total = (rice ?? 0) + (ln ?? 0);
        if (total <= 0) return -1;
        return lnBucketFromRatio((ln ?? 0) / total);
};

/** The class a measured LN share falls into, snapping to 0/25/50/75/100%. */
export const lnBucketFromRatio = (ratio: number): number =>
        Math.min(4, Math.max(0, Math.round(ratio * 4)));

/** How a class is written: `0% LN` .. `100% LN`, or `?` for unmeasured. */
export const bucketLabel = (bucket: number): string =>
        bucket < 0 || bucket > 4 ? '?' : `${['0', '25', '50', '75', '100'][bucket]}% LN`;

/**
 * A difficulty's LN share, measured from its `.osu` text.
 *
 * The fallback for metadata that predates the game's `rice`/`ln` backfill:
 * `[HitObjects]` lines are counted by their type field, bit 1 a tap and bit
 * 128 a hold. Nowhere near a decode - one pass over the text, and only for
 * difficulties whose class is otherwise unknown.
 *
 * `undefined` when the chart has no notes the parser recognises.
 */
export const lnRatioFromText = (chartText: string): number | undefined => {
        let total = 0;
        let ln = 0;

        const lines = chartText.split(/\r?\n/);
        let inObjects = false;
        for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('//')) continue;
                if (trimmed.startsWith('[')) {
                        inObjects = trimmed.toLowerCase() === '[hitobjects]';
                        continue;
                }
                if (!inObjects) continue;

                // `x,y,time,type,hitSound,...` - the type field is the class of note.
                const type = Number(trimmed.split(',')[3]);
                if (!Number.isFinite(type)) continue;
                if (type & 128) { ln++; total++; }
                else if (type & 1) total++;
        }

        return total > 0 ? ln / total : undefined;
};

/**
 * Wall state for one sweep: per LN class, the run of consecutive failures and
 * the wall itself, if one has been tripped.
 *
 * One instance lives per worker run (and one on the main thread for display);
 * walls discovered anywhere are merged in from outside, and never loosen - a
 * wall only ever climbs down, because a higher one was looser evidence.
 */
export class FailWalls {
        private readonly walls: (number | undefined)[] = new Array(5).fill(undefined);
        private readonly counts = new Array(5).fill(0);
        private readonly since = new Array(5).fill(0);

        constructor(
                private readonly fails: number = DEFAULT_WALL_FAILS,
                private readonly span: number = WALL_SPAN,
        ) {}

        /**
         * Whether this difficulty is beyond a wall and need not be simulated.
         *
         * Unmeasured difficulties (`bucket < 0`) and unstarred ones (`stars <= 0`,
         * metadata that never carried a difficulty rating) are never skipped: a
         * wall is a statement about star ratings, and says nothing about a map
         * without one. Equal to the wall is not above it, so a borderline
         * difficulty still gets its chance.
         */
        shouldSkip(bucket: number, stars: number): boolean {
                if (bucket < 0 || stars <= 0) return false;
                const wall = this.walls[bucket];
                return wall !== undefined && stars > wall;
        }

        /**
         * Fold one simulated difficulty into the state.
         *
         * `cleared` is the verdict on the difficulty itself - passed at the
         * slowest rate simulated, not merely at some faster one - so a map that
         * only dies at x1.4 does not feed the wall its own rate's ambition.
         * Returns the wall this report tripped, if any, for broadcasting.
         */
        report(bucket: number, stars: number, cleared: boolean): Wall | undefined {
                if (bucket < 0 || stars <= 0) return undefined;

                const index = Math.min(4, bucket);
                if (cleared) {
                        this.counts[index] = 0;
                        return undefined;
                }

                if (this.counts[index] === 0) this.since[index] = stars;
                this.counts[index]++;

                if (this.counts[index] < this.fails) return undefined;

                // A run wider than the span is sparse evidence, not a wall: restart
                // the run at this difficulty, which is the only thing it proved.
                if (stars - this.since[index] > this.span) {
                        this.counts[index] = 1;
                        this.since[index] = stars;
                        return undefined;
                }

                this.counts[index] = 0;
                const previous = this.walls[index];
                this.walls[index] = previous === undefined ? stars : Math.min(previous, stars);
                return { bucket: index, stars: this.walls[index] };
        }

        /** Fold in a wall found elsewhere - another worker's slice, say. */
        merge(wall: Wall): boolean {
                const index = Math.min(4, Math.max(0, wall.bucket));
                const previous = this.walls[index];
                if (previous !== undefined && previous <= wall.stars) return false;
                this.walls[index] = wall.stars;
                this.counts[index] = 0;
                return true;
        }

        /** The walls standing, for display. */
        get list(): Wall[] {
                const out: Wall[] = [];
                for (let bucket = 0; bucket < 5; bucket++) {
                        const stars = this.walls[bucket];
                        if (stars !== undefined) out.push({ bucket, stars });
                }
                return out;
        }
}
