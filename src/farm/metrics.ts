/**
 * Turning simulated plays into farm value.
 *
 * A simulated play tells you what one attempt is worth. Farming is a *rate*, so
 * the ranking divides by what the attempt costs in wall-clock time, and then
 * accounts for **mindblock**: repeating the same map inside a 24h window scales
 * its technique XP down toward 25%, over ~25 plays, with stamina, memory, speed
 * and jackspeed exempt. That is why the best *single* map is not the best
 * *farm*.
 *
 * The curve is the game's own, mirroring the server's `mindblock.ts`, so this
 * cannot drift from what the player actually earns.
 *
 * (oss!idle 0.19 removed the session-fatigue XP multiplier - `getSkillsXP` no
 * longer takes a factor and `getServerXP` no longer computes one - so there is
 * nothing here for it.)
 */

import { MINDBLOCK_SKILLS } from '@oss-idle/shared/skills';
import cubic_bezier from '@oss-idle/shared/math/cubic_bezier';
import lerp from '@oss-idle/shared/math/lerp';
import type { SimResult } from '../engine/protocol.js';

/** Mindblock constants, mirroring the server's `mindblock.ts`. */
const PLAYS_FOR_FULL_BLOCK = 25;
const MIN_FACTOR = 0.25;
const BLOCK_CB = cubic_bezier(.6, 0, .6, 1);

/** How much technique XP survives after `recentPlays` repeats in 24h. */
const mindblockFactor = (recentPlays: number): number =>
        lerp(1, MIN_FACTOR, BLOCK_CB(Math.min(1, recentPlays / PLAYS_FOR_FULL_BLOCK)));

const MINDBLOCK_SET = new Set<string>(MINDBLOCK_SKILLS as unknown as string[]);

/**
 * The XP a play awards after mindblock and then the medal bonus, per skill -
 * the order and flooring of the server's `getServerXP`.
 */
const adjustedXp = (
        xp: Record<string, number>,
        { recentPlays = 0, medalMultiplier = 1 }: { recentPlays?: number; medalMultiplier?: number } = {},
): Record<string, number> => {
        const block = mindblockFactor(recentPlays);
        const out: Record<string, number> = {};
        for (const [skill, value] of Object.entries(xp)) {
                const blocked = MINDBLOCK_SET.has(skill) ? Math.floor(value * block) : value;
                out[skill] = Math.floor(blocked * medalMultiplier);
        }
        return out;
};

export type FarmTarget =
        /**
         * Rank by the sum of the chosen skills' XP - every skill for a total, or
         * any subset the player is actually farming. A subset is not a smaller
         * total: skills an upgrade is about to make expensive can be left out, and
         * the ranking then ignores the maps that only earn what is not needed.
         */
        | { kind: 'skills'; skills: readonly string[] }
        /**
         * Rank by performance points.
         *
         * **Ranked by the pp itself, not by pp per second.** XP accumulates, so for
         * XP the useful question is a rate - how much per minute of play. pp does
         * not: only your best score on a map counts, and your total is a weighted
         * sum of your top plays, so playing a map twice as fast earns you nothing
         * extra. The question is simply which map your character would score most
         * on. Mindblock does not apply either, since it scales XP rather than score.
         */
        | { kind: 'pp' };

type RankOptions = {
        target: FarmTarget;
        /** Repeats already made of each map in the last 24h, by beatmap id. */
        recentPlays?: Map<number, number>;
        /**
         * Seconds of overhead per play beyond the chart itself - result screen,
         * transition and song load. Autopilot pays this on every cycle, so it is
         * part of the true rate and it penalises short maps.
         */
        overheadSec?: number;
        /**
         * Drop maps the character usually cannot clear. Failing is probabilistic, so
         * this is a threshold on the share of simulated runs that died, not a flag:
         * a map that dies half the time is not a farm, but one that dies once in ten
         * attempts still is.
         */
        maxFailRate?: number;
        /** XP multiplier from the medals the character holds - see `medalMultiplier` in `engine/client.ts`. */
        medalMultiplier?: number;
};

export type RankedMap = SimResult & {
        /** XP (or pp) toward the chosen target, after adjustments. */
        value: number;
        /** `value` per second of wall-clock play. Meaningless for a pp target. */
        perSecond: number;
        /** Full play cost including overhead. */
        cycleSec: number;
        /** Repeats assumed when computing `value`. */
        recentPlays: number;
};

/**
 * What the ranking actually sorts on.
 *
 * A rate for XP, which accrues with every play; the raw value for pp, which
 * does not.
 */
const rankingScore = (
        map: Pick<RankedMap, 'value' | 'perSecond'>,
        target: FarmTarget,
): number => (target.kind === 'pp' ? map.value : map.perSecond);

/** A row's identity: one difficulty at one rate. */
export const rowKey = (map: Pick<SimResult, 'beatmapId' | 'rate'>): string =>
        `${map.beatmapId}@${map.rate}`;

const valueOf = (
        xp: Record<string, number>,
        target: FarmTarget,
        result: { pp: number },
): number => {
        switch (target.kind) {
                case 'skills':
                        return target.skills.reduce((sum, skill) => sum + (xp[skill] ?? 0), 0);
                case 'pp':
                        // Untouched by the XP adjustments - see the target's note.
                        return result.pp;
        }
};

/** Score and sort simulated maps by XP per second, best first. */
export const rankMaps = (results: readonly SimResult[], options: RankOptions): RankedMap[] => {
        const {
                target,
                recentPlays = new Map<number, number>(),
                overheadSec = 8,
                maxFailRate = 0.5,
                medalMultiplier = 1,
        } = options;

        const ranked: RankedMap[] = [];
        // Every rendered row comes through here, and the table keys rows by
        // `rowKey` - so this is the one place that has to guarantee each difficulty
        // appears once per rate, whatever the sweep produced.
        const emitted = new Set<string>();

        for (const result of results) {
                if (result.failRate > maxFailRate) continue;
                const key = rowKey(result);
                if (emitted.has(key)) continue;
                emitted.add(key);

                const repeats = recentPlays.get(result.beatmapId) ?? 0;
                const xp = adjustedXp(result.xp, { recentPlays: repeats, medalMultiplier });
                const value = valueOf(xp, target, result);
                const cycleSec = result.durationSec + overheadSec;

                ranked.push({
                        ...result,
                        value,
                        cycleSec,
                        perSecond: cycleSec > 0 ? value / cycleSec : 0,
                        recentPlays: repeats,
                });
        }

        return ranked.sort((a, b) => rankingScore(b, target) - rankingScore(a, target));
};

type RotationOptions = {
        size?: number;
        playsPerMap?: number;
        target: FarmTarget;
        overheadSec?: number;
        /**
         * Allow at most one difficulty per beatmapset. Off by default - a taste
         * preference, not a farm consideration, since mindblock is per difficulty.
         */
        oneMapPerSet?: boolean;
        medalMultiplier?: number;
        /** Whether entries are locked at their rates, so the rotation can mix them. */
        mixRates?: boolean;
        /**
         * Let the rotation hold a difficulty at several rates. Never for a pp target,
         * where only a difficulty's best score counts.
         */
        severalRates?: boolean;
};

/**
 * Pick a rotation of `size` maps.
 *
 * Not simply the top N: mindblock is per map, so a rotation's real value
 * depends on how often each map comes round. Maps are chosen greedily by the
 * rate they would have *at their position in the rotation* - the first pick is
 * played most and is charged the most repeats - which naturally spreads the
 * playlist across several maps instead of stacking near-identical ones.
 *
 * Two difficulties of one beatmapset are **not** the same map for this purpose:
 * mindblock counts plays per difficulty, so each carries its own decay and both
 * can earn a place. `oneMapPerSet` exists only for players who would rather not
 * hear one song on repeat, and is off by default.
 *
 * `playsPerMap` is how many times the player expects to cycle the whole
 * playlist in a session; with a rotation of `size`, each map is then played
 * that many times rather than all repeats landing on one map.
 *
 * An unlocked playlist plays at the one rate the player has picked, so unless
 * entries are locked (`mixRates`) the rotation is built at each rate the
 * ranking holds and the best one kept: every map in it shares
 * {@link RankedMap.rate}.
 */
export const buildRotation = (
        ranked: readonly RankedMap[],
        options: RotationOptions,
): RankedMap[] => {
        if (options.mixRates) return rotationAt(ranked, options);

        const byRate = new Map<number, RankedMap[]>();
        for (const map of ranked) {
                const maps = byRate.get(map.rate);
                if (maps) maps.push(map);
                else byRate.set(map.rate, [map]);
        }

        let best: RankedMap[] = [];
        let bestTotal = -Infinity;
        for (const maps of byRate.values()) {
                const rotation = rotationAt(maps, options);
                const total = rotation.reduce((sum, map) => sum + rankingScore(map, options.target), 0);
                if (total > bestTotal) {
                        best = rotation;
                        bestTotal = total;
                }
        }
        return best;
};

/** The greedy pick of {@link buildRotation}, among maps at one rate. */
const rotationAt = (
        ranked: readonly RankedMap[],
        {
                size = 5,
                playsPerMap = 5,
                target,
                overheadSec = 8,
                oneMapPerSet = false,
                medalMultiplier = 1,
                severalRates = false,
        }: RotationOptions,
): RankedMap[] => {
        const chosen: RankedMap[] = [];
        const usedSets = new Set<number>();
        /** Rates already picked of each difficulty: mindblock counts them all as its plays. */
        const picks = new Map<number, number>();
        const oncePerDifficulty = !severalRates || target.kind === 'pp';
        const remaining = [...ranked];

        while (chosen.length < size && remaining.length) {
                let bestIndex = -1;
                let bestRate = -Infinity;

                remaining.forEach((candidate, index) => {
                        if (oneMapPerSet && usedSets.has(candidate.setId)) return;
                        const picked = picks.get(candidate.beatmapId) ?? 0;
                        if (oncePerDifficulty && picked) return;
                        // Charge this candidate the repeats it would actually accumulate,
                        // its other rates' plays included. (Mindblock scales XP only, so for
                        // a pp target this is a no-op and the pick is simply the best-scoring
                        // map left.)
                        const xp = adjustedXp(candidate.xp, {
                                recentPlays: candidate.recentPlays + playsPerMap * (picked + 1), medalMultiplier,
                        });
                        const value = valueOf(xp, target, candidate);
                        const score = rankingScore(
                                { value, perSecond: value / (candidate.durationSec + overheadSec) },
                                target,
                        );
                        if (score > bestRate) {
                                bestRate = score;
                                bestIndex = index;
                        }
                });

                if (bestIndex < 0) break;
                const [pick] = remaining.splice(bestIndex, 1);
                if (!pick) break;
                usedSets.add(pick.setId);
                picks.set(pick.beatmapId, (picks.get(pick.beatmapId) ?? 0) + 1);
                // Keep the map's own numbers for a pp target; only an XP rate is
                // re-derived from the repeats charged above.
                chosen.push(target.kind === 'pp' ? pick : { ...pick, perSecond: bestRate });
        }

        return chosen;
};

/**
 * What the table lists: each difficulty once, at its best rate - unless the
 * rotation holds it, then at the rates the rotation holds it at, so the picks
 * shown are the plays the playlist makes.
 */
export const tableRows = (
        ranked: readonly RankedMap[],
        rotation: readonly RankedMap[],
): RankedMap[] => {
        const picked = new Set(rotation.map(rowKey));
        const inRotation = new Set(rotation.map(map => map.beatmapId));
        const listed = new Set<number>();
        return ranked.filter(map => {
                const show = picked.has(rowKey(map))
                        || (!inRotation.has(map.beatmapId) && !listed.has(map.beatmapId));
                if (show) listed.add(map.beatmapId);
                return show;
        });
};
