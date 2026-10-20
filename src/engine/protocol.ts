/**
 * Messages between the overlay and the simulation worker.
 *
 * Everything crossing this boundary is structured-cloneable: the worker
 * receives a plain snapshot of the character (the `character` row as stored)
 * and rebuilds the game's `Skill` objects on its own side, because those carry
 * behaviour and cannot be cloned.
 */

/**
 * One difficulty to simulate.
 *
 * Deliberately just ids: charts are read by the worker, straight from the same
 * IndexedDB the client stores them in. Reading them on the main thread instead
 * would mean holding an entire library of `.osu` text in memory (a thousand maps
 * is easily hundreds of megabytes) and then paying for a structured-clone copy
 * of all of it per worker.
 *
 * `stars` and `bucket` are the difficulty's place in the scan order - the
 * stored star rating and LN class, both from set metadata - and exist so a
 * worker can apply fail walls without reading the chart first. Both optional:
 * a caller with no use for them (a single-map re-scan, say) passes nothing.
 */
export type SimRequest = {
        setId: number;
        beatmapId: number;
        /** Star rating from set metadata, the x1 basis the scan is ordered by. 0 = unrated. */
        stars?: number;
        /** LN class, 0 (rice) to 4 (all LN) - see `walls.ts`. -1 = unmeasured. */
        bucket?: number;
};

/**
 * What a simulated play is worth, before any farm-level adjustment.
 *
 * The simulation is **stochastic** - the bot's hit error is sampled, so the same
 * chart played twice earns different XP (measured at 4-17% variation run to
 * run, worst on maps the character is only just clearing). Every field here is
 * therefore a mean over `runs` attempts, which is what makes two close maps
 * rankable against each other at all.
 */
export type SimResult = {
        setId: number;
        beatmapId: number;
        /** Playback rate the play ran at. */
        rate: number;
        /** Star rating at that rate (0 if rosu-pp is unavailable). */
        stars: number;
        /** Mean per-skill XP per play, before mindblock. */
        xp: Record<string, number>;
        /** Sum over every skill. */
        totalXp: number;
        /** Mean wall-clock cost in seconds: lead-in plus time to the last judged note. */
        durationSec: number;
        /** Mean accuracy across runs. */
        accuracy: number;
        /** Grade of the median run. */
        grade: string;
        /** Mean performance points per play (0 if rosu-pp is unavailable). */
        pp: number;
        /** How many attempts were averaged. */
        runs: number;
        /** Share of runs that died to HP drain (0 = always clears, 1 = never). */
        failRate: number;
        /** Relative spread of total XP across runs - how trustworthy the mean is. */
        variation: number;
};

export type SimError = {
        setId: number;
        beatmapId: number;
        message: string;
};

export type WorkerRequest =
        | {
                type: 'run';
                /** The `character` row, used to rebuild the player's skills worker-side. */
                character: Record<string, unknown>;
                /** Whether the character has the DIVINE unlock (changes judgement). */
                divine: boolean;
                /** Attempts to average per map. Higher is steadier but linearly slower. */
                runs: number;
                /** Playback rates to simulate each map at. */
                rates: number[];
                /**
                 * Plays of each map since memory was last prestiged, by beatmap id.
                 *
                 * Seeds the memory skill, which is the only thing that makes it earn: it
                 * trains on *partially* learned maps, so a map the character has never
                 * played trains it exactly zero.
                 */
                playCounts: Record<number, number>;
                batch: SimRequest[];
                /** Identifies this worker in a pool, for progress accounting. */
                workerId: number;
                /** Skip difficulties beyond a tripped fail wall, and track new walls. */
                adaptive: boolean;
                /** How many consecutive failures in one LN class trip a wall. */
                wallFails: number;
        }
        /** A wall another worker tripped: apply it to this worker's remaining batch. */
        | { type: 'wall'; bucket: number; stars: number }
        | { type: 'cancel' };

export type WorkerResponse =
        | {
                type: 'progress';
                done: number;
                total: number;
                results: SimResult[];
                errors: SimError[];
                /** Difficulties skipped by fail walls so far, this worker's slice. */
                skipped: number;
        }
        /** A wall this worker tripped: the driver relays it to every worker. */
        | { type: 'wall'; bucket: number; stars: number }
        | { type: 'done' }
        | { type: 'cancelled' }
        | { type: 'fatal'; message: string };
