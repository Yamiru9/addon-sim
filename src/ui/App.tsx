/**
 * The farm overlay.
 *
 * One screen: sweep the library, rank it by XP per second toward a chosen
 * target, and turn the top of that ranking into a playlist.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Skills } from '@oss-idle/shared/skills';
import {
        rateLabel,
        rateSteps,
        versionLabel,
} from '@oss-idle/shared/rate';
import {
        createSettings,
        gameCharacter,
        recentPlayCounts,
        type CharacterRow,
} from '@oss-idle/addon-sdk';
import { usePersistedSettings } from '@oss-idle/addon-sdk/react';
import {
        collectCharts,
        libraryIndex,
        medalMultiplier,
        runSweep,
        type MapInfo,
        type Sweep,
} from '../engine/client.js';
import type { SimResult } from '../engine/protocol.js';
import { bucketLabel, type Wall } from '../engine/walls.js';
import {
        buildRotation,
        rankMaps,
        rowKey,
        tableRows,
        type FarmTarget,
        type RankedMap,
} from '../farm/metrics.js';
import RatePicker from './RatePicker.js';
import TargetPicker from './TargetPicker.js';
import { replacePlaylist, type RateLock } from '../engine/playlist.js';

type Phase =
        | { kind: 'idle' }
        | { kind: 'scanning'; done: number; total: number }
        | { kind: 'ready' }
        | { kind: 'error'; message: string };

const SKILL_NAMES = Skills as unknown as string[];

/**
 * What the overlay remembers between sessions.
 *
 * Scan results are deliberately *not* stored: a library sweep is megabytes of
 * per-skill numbers, and `localStorage` is shared with the game's own settings -
 * filling it would break the client, not just this add-on.
 *
 * `characterId` is remembered only once the player has overridden the detected
 * character (`characterPinned`). Otherwise detection runs afresh each time, so
 * signing in or out is picked up instead of being overridden by a stale choice.
 */
type Settings = {
        /** The skills the ranking counts; every one of them is `total`. */
        targetSkills: string[];
        /** Rank by pp instead - exclusive with the skills, see `metrics.ts`. */
        targetPp: boolean;
        /** The pre-toggle target, kept only to carry an old setting across. */
        targetSkill: string;
        overheadSec: number;
        runs: number;
        /** Unlocked rates not to simulate. */
        excludedRates: number[];
        excludeFailed: boolean;
        applyMindblock: boolean;
        oneMapPerSet: boolean;
        /** Let the playlist hold a difficulty at several rates. */
        severalRates: boolean;
        /** Which playlist entries are locked at their rate. */
        lockRates: RateLock;
        playlistSize: number;
        playlistName: string;
        playlistNameTouched: boolean;
        characterId: number;
        characterPinned: boolean;
        /** Skip difficulties beyond a tripped fail wall - see `engine/walls.ts`. */
        adaptiveSkip: boolean;
        /** How many consecutive failures in one LN class trip a wall. */
        wallFails: number;
        /** Star-rating window for the scan, as typed - parsed at scan time, '' is no bound. */
        minStars: string;
        maxStars: string;
};

const DEFAULTS: Settings = {
        targetSkills: [...SKILL_NAMES],
        targetPp: false,
        targetSkill: '',
        overheadSec: 8,
        runs: 3,
        excludedRates: [],
        excludeFailed: true,
        applyMindblock: true,
        oneMapPerSet: false,
        severalRates: false,
        lockRates: 'all',
        playlistSize: 5,
        playlistName: 'Farm: total',
        playlistNameTouched: false,
        characterId: 0,
        characterPinned: false,
        adaptiveSkip: true,
        wallFails: 3,
        minStars: '',
        maxStars: '',
};

const settingsStore = createSettings<Settings>('osu-idle-sim', DEFAULTS);

const formatRate = (rate: number) =>
        rate >= 100 ? rate.toFixed(0) : rate >= 10 ? rate.toFixed(1) : rate.toFixed(2);

/** A typed star bound as a number - empty, 0 or nonsense is 0, meaning no bound. */
const parseStars = (raw: string): number => {
        const n = Number(raw);
        return Number.isFinite(n) && n > 0 ? n : 0;
};

/** pp is not affected by mindblock - see the `pp` farm target. */
const PP_NOTE = 'Ranked by the pp a play would score, not by pp per second: '
        + 'only your best score on a map counts, so playing it faster earns nothing extra. '
        + 'Mindblock scales XP, not score, so it is ignored here.';

const formatTime = (seconds: number) => {
        const total = Math.round(seconds);
        return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

export default function App({
        open,
        onClose,
        version,
}: {
        /**
         * Whether the panel is showing. It is *hidden*, never unmounted: a sweep
         * takes a while, and unmounting would throw away the results so far and
         * cancel the worker mid-run, so closing the overlay would silently undo the
         * scan the player is waiting on.
         */
        open: boolean;
        onClose: () => void;
        version: string;
}) {
        const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
        const [results, setResults] = useState<SimResult[]>([]);
        const [index, setIndex] = useState<Map<number, MapInfo>>(new Map());
        const [recent, setRecent] = useState<Map<number, number>>(new Map());
        /** `undefined` until a scan has read it, `null` when the server was unreachable. */
        const [medals, setMedals] = useState<number | null | undefined>(undefined);
        const [errorCount, setErrorCount] = useState(0);
        const [duplicateCount, setDuplicateCount] = useState(0);
        /** Difficulties the fail walls skipped, and the walls themselves. */
        const [skippedCount, setSkippedCount] = useState(0);
        const [walls, setWalls] = useState<Wall[]>([]);
        /** Difficulties the star range left out of the last scan. */
        const [rangeCount, setRangeCount] = useState(0);

        const [settings, update] = usePersistedSettings(settingsStore, DEFAULTS);
        const {
                targetSkills, targetPp, overheadSec, runs, excludedRates,
                excludeFailed, applyMindblock, oneMapPerSet, severalRates, lockRates,
                playlistSize, playlistName, adaptiveSkip, wallFails,
                minStars: minStarsRaw, maxStars: maxStarsRaw,
        } = settings;

        const starMin = parseStars(minStarsRaw);
        const starMax = parseStars(maxStarsRaw);
        /** A window whose minimum is above its maximum matches nothing. */
        const badRange = starMin > 0 && starMax > 0 && starMin > starMax;

        const [characters, setCharacters] = useState<CharacterRow[]>([]);
        const [characterId, setCharacterId] = useState<number | undefined>(
                settings.characterPinned ? settings.characterId : undefined,
        );
        const [saveState, setSaveState] = useState<string>('');
        /** Beatmap ids being re-simulated on their own, by the row buttons. */
        const [rescanning, setRescanning] = useState<Set<number>>(new Set());
        const [notice, setNotice] = useState('');

        const sweepRef = useRef<Sweep | undefined>(undefined);

        /**
         * Re-read the characters.
         *
         * The client writes skill levels back to this row after every play
         * (`persistSkills`), so the row is live - but this list is a snapshot, and
         * the overlay is mounted for the add-on's whole life. Without re-reading, the
         * level beside a character's name would be whatever it was when the game
         * booted, while a sweep quietly used the real, current one. Refreshed
         * whenever the panel is opened and again before each scan.
         */
        const refreshCharacters = useCallback(async () => {
                const [rows, detected] = await Promise.all([gameCharacter.list(), gameCharacter.live()]);
                setCharacters(rows);
                setCharacterId(previous => {
                        // A pinned choice wins, but only while that character still exists.
                        if (previous !== undefined && rows.some(row => row.id === previous)) return previous;
                        return detected?.id ?? rows[0]?.id;
                });
        }, []);

        useEffect(() => {
                if (open) void refreshCharacters();
        }, [open, refreshCharacters]);

        /** One-time: carry the pre-toggle target into the toggles, then retire it. */
        useEffect(() => {
                const old = settings.targetSkill;
                if (!old) return;
                if (old === 'pp') update({ targetPp: true, targetSkill: '' });
                else if (old === 'total') update({ targetSkills: [...SKILL_NAMES], targetSkill: '' });
                else if (SKILL_NAMES.includes(old)) update({ targetSkills: [old], targetSkill: '' });
                else update({ targetSkill: '' });
                // eslint-disable-next-line react-hooks/exhaustive-deps
        }, []);

        const target: FarmTarget = useMemo(
                () => targetPp ? { kind: 'pp' } : { kind: 'skills', skills: targetSkills },
                [targetPp, targetSkills],
        );

        /** How the target reads in the table's XP column and the playlist name. */
        const targetName = targetPp
                ? 'pp'
                : targetSkills.length === SKILL_NAMES.length
                        ? 'total'
                        : targetSkills.length === 1
                                ? targetSkills[0]!
                                : `${targetSkills.length} skills`;

        // Keep the suggested playlist name in step with the target, but never
        // overwrite a name the player has typed themselves.
        useEffect(() => {
                if (!settings.playlistNameTouched) update({ playlistName: `Farm: ${targetName}` });
        }, [targetName, settings.playlistNameTouched, update]);

        const ranked: RankedMap[] = useMemo(() => rankMaps(results, {
                target,
                recentPlays: applyMindblock ? recent : new Map(),
                overheadSec,
                maxFailRate: excludeFailed ? 0.5 : 1,
                medalMultiplier: medals ?? 1,
        }), [results, target, recent, applyMindblock, overheadSec, excludeFailed, medals]);

        const rotation = useMemo(() => buildRotation(ranked, {
                size: playlistSize,
                target,
                overheadSec,
                oneMapPerSet,
                medalMultiplier: medals ?? 1,
                mixRates: lockRates !== 'none',
                severalRates,
        }), [ranked, playlistSize, target, overheadSec, oneMapPerSet, medals, lockRates, severalRates]);

        /** An unlocked playlist plays at one rate, which the rotation has picked. */
        const oneRate = lockRates === 'none' ? ` at ${rateLabel(rotation[0]?.rate ?? 1)}` : '';

        const rotationIds = useMemo(
                () => new Set(rotation.map(rowKey)),
                [rotation],
        );

        const rows = useMemo(() => tableRows(ranked, rotation), [ranked, rotation]);
        const simulatedMaps = useMemo(() => new Set(results.map(map => map.beatmapId)).size, [results]);

        const speedUpgrades = Number(characters.find(row => row.id === characterId)?.speedUpgrades) || 0;
        const steps = rateSteps(speedUpgrades);
        const noRates = steps.every(step => excludedRates.includes(step));

        const scan = useCallback(async () => {
                setSaveState('');
                setNotice('');
                setPhase({ kind: 'scanning', done: 0, total: 0 });
                try {
                        // Levels move while the overlay sits open; the sweep reads the
                        // character fresh, so the label beside it should be fresh too.
                        await refreshCharacters();
                        const [survey, maps, character] = await Promise.all([
                                collectCharts({ min: starMin, max: starMax }),
                                libraryIndex(),
                                characterId === undefined ? gameCharacter.live() : gameCharacter.byId(characterId),
                        ]);
                        setIndex(maps);
                        const [recentPlays, multiplier] = character
                                ? await Promise.all([recentPlayCounts(Number(character.id)), medalMultiplier(character)])
                                : [new Map<number, number>(), 1];
                        setRecent(recentPlays);
                        setMedals(multiplier ?? null);

                        if (!survey.requests.length) {
                                // Say which of the several possible causes it actually is.
                                const rangePhrase = starMin && starMax
                                        ? `between ${starMin} and ${starMax} stars`
                                        : starMin
                                                ? `at or above ${starMin} stars`
                                                : `at or below ${starMax} stars`;
                                const detail = survey.sets === 0
                                        ? 'The beatmap store is empty - download a map in song select first.'
                                        : survey.skippedRange > 0
                                                ? `all ${survey.skippedRange} 4K difficulties are outside the star range (${rangePhrase})`
                                                : `Found ${survey.sets} set(s), but none of their ${survey.versions} difficulties are 4K mania.`;
                                setPhase({ kind: 'error', message: `Nothing to simulate. ${detail}` });
                                return;
                        }

                        setResults([]);
                        setErrorCount(0);
                        setDuplicateCount(survey.duplicates);
                        setRangeCount(survey.skippedRange);
                        setSkippedCount(0);
                        setWalls([]);
                        setPhase({ kind: 'scanning', done: 0, total: survey.requests.length });

                        // Every results update re-ranks the whole library on the game's
                        // thread - hundreds of ms at every rate - so the table catches up
                        // once a second rather than on each finished map.
                        let pending: SimResult[] = [];
                        let shownAt = 0;
                        const show = () => {
                                const batch = pending;
                                pending = [];
                                shownAt = Date.now();
                                if (batch.length) setResults(previous => [...previous, ...batch]);
                        };

                        const sweep = await runSweep(survey.requests, {
                                runs, characterId, excludedRates,
                                adaptive: adaptiveSkip, wallFails,
                        }, progress => {
                                setPhase({ kind: 'scanning', done: progress.done, total: progress.total });
                                setSkippedCount(progress.skipped);
                                setWalls(progress.walls);
                                pending.push(...progress.results);
                                if (Date.now() - shownAt >= 1000) show();
                                if (progress.errors.length) {
                                        setErrorCount(previous => previous + progress.errors.length);
                                }
                        });
                        sweepRef.current = sweep;

                        const settled = await sweep.finished;
                        show();
                        setSkippedCount(settled.skipped);
                        setWalls(settled.walls);
                        setPhase({ kind: 'ready' });
                } catch (e) {
                        setPhase({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
                }
        }, [runs, excludedRates, characterId, refreshCharacters, adaptiveSkip, wallFails, starMin, starMax]);

        /**
         * Re-simulate one difficulty where it sits, at every picked rate.
         *
         * The sweep reads the character and the play counts fresh, so this is how
         * a row is brought up to date after levelling without paying for the
         * whole library again. Fail walls are off: the player asked for *this*
         * map, and a wall would be wrong to overrule them.
         */
        const rescanMap = useCallback(async (map: RankedMap) => {
                setNotice('');
                setRescanning(previous => new Set(previous).add(map.beatmapId));
                try {
                        const sweep = await runSweep(
                                [{ setId: map.setId, beatmapId: map.beatmapId }],
                                { runs, characterId, excludedRates, adaptive: false },
                        );
                        const { results: fresh, errors } = await sweep.finished;
                        if (fresh.length) {
                                // One row per rate of this difficulty, replacing every
                                // rate of it the scan produced.
                                setResults(previous => [
                                        ...previous.filter(other => other.beatmapId !== map.beatmapId),
                                        ...fresh,
                                ]);
                        }
                        if (errors.length) {
                                setNotice(`Re-scan failed: ${errors[0]!.message}`);
                        }
                } catch (e) {
                        setNotice(`Re-scan failed: ${e instanceof Error ? e.message : String(e)}`);
                } finally {
                        setRescanning(previous => {
                                const next = new Set(previous);
                                next.delete(map.beatmapId);
                                return next;
                        });
                }
        }, [runs, characterId, excludedRates]);

        useEffect(() => () => sweepRef.current?.cancel(), []);

        const savePlaylist = useCallback(async () => {
                if (!rotation.length) return;
                setSaveState('saving');
                try {
                        const { created } = await replacePlaylist(playlistName, rotation, lockRates);
                        setSaveState(
                                `${created ? 'Created' : 'Replaced'} "${playlistName}" - ${rotation.length} maps`
                                + `${oneRate}. Reopen song select to see it.`,
                        );
                } catch (e) {
                        setSaveState(e instanceof Error ? e.message : String(e));
                }
        }, [rotation, playlistName, lockRates, oneRate]);

        const scanning = phase.kind === 'scanning';

        return (
                <div style={{ display: open ? 'contents' : 'none' }} aria-hidden={!open}>
                        <div className="backdrop" onClick={onClose} />
                        <div className="panel" role="dialog" aria-label="oss!idle sim">
                                <header>
                                        <h1>oss!idle sim</h1>
                                        <span className="hint">
                                                XP/second across your downloaded maps, simulated for your character
                                        </span>
                                        <span className="spacer" />
                                        <span className="hint">v{version} - Ctrl+Shift+F</span>
                                        <button onClick={onClose}>Close</button>
                                </header>

                                <div className="controls">
                                        <label title="The client keeps the live character in memory, out of reach of an add-on - so this is a best guess. Check it matches who you are playing.">
                                                Character
                                                <select
                                                        value={characterId ?? ''}
                                                        onChange={e => {
                                                                const id = Number(e.target.value);
                                                                setCharacterId(id);
                                                                update({ characterId: id, characterPinned: true });
                                                        }}
                                                >
                                                        {characters.map(row => (
                                                                <option key={row.id} value={row.id}>
                                                                        {row.name} - lv {row.overallLevel}{row.local ? ' (guest)' : ''}
                                                                </option>
                                                        ))}
                                                </select>
                                        </label>

                                        <div
                                                className="field"
                                                title="What the ranking counts. Toggle skills off to ignore their XP - the ranking re-sorts on the spot. pp ranks by score per play instead."
                                        >
                                                Target
                                                <TargetPicker
                                                        skills={SKILL_NAMES}
                                                        selected={targetSkills}
                                                        pp={targetPp}
                                                        onChange={({ selected, pp }) => update({ targetSkills: selected, targetPp: pp })}
                                                />
                                        </div>

                                        <label
                                                title="Result screen, transitions and song load - paid on every play. Unused when ranking by pp."
                                                style={{ opacity: targetPp ? 0.45 : undefined }}
                                        >
                                                Overhead (s)
                                                <input
                                                        type="number" min={0} max={60} value={overheadSec}
                                                        onChange={e => update({ overheadSec: Number(e.target.value) || 0 })}
                                                />
                                        </label>


                                        <label title="The simulation is stochastic; averaging more attempts steadies the ranking, at a linear cost in scan time">
                                                Runs / map
                                                <input
                                                        type="number" min={1} max={10} value={runs}
                                                        onChange={e => update({ runs: Math.max(1, Math.min(10, Number(e.target.value) || 1)) })}
                                                />
                                        </label>

                                        <div className="field" title="Each rate is a full extra sweep of the library. A playlist plays at one rate, so the generated one sticks to its best.">
                                                Rates
                                                <RatePicker
                                                        steps={steps}
                                                        excluded={excludedRates}
                                                        onChange={excluded => update({ excludedRates: excluded })}
                                                />
                                        </div>

                                        <label className="check" title="When maps fail in a row at climbing difficulty, everything harder is skipped without simulating it - and when a map fails every run even at its slowest rate, its faster rates are skipped too, since they cannot be cleared either. Tracked per long-note class, because star rating alone does not say what a map is made of. The count resets every scan - the character grows.">
                                                <input
                                                        type="checkbox" checked={adaptiveSkip}
                                                        onChange={e => update({ adaptiveSkip: e.target.checked })}
                                                />
                                                Skip failed maps &amp; harder
                                        </label>

                                        <label
                                                title="How many failed maps in a row before everything harder is skipped. Fewer skips more of the scan; more trusts the character further."
                                                style={{ opacity: adaptiveSkip ? undefined : 0.45 }}
                                        >
                                                Fails in a row
                                                <input
                                                        type="number" min={2} max={10} value={wallFails}
                                                        disabled={!adaptiveSkip}
                                                        onChange={e => update({ wallFails: Math.max(2, Math.min(10, Number(e.target.value) || 2)) })}
                                                />
                                        </label>

                                        <label className="check">
                                                <input
                                                        type="checkbox" checked={applyMindblock}
                                                        onChange={e => update({ applyMindblock: e.target.checked })}
                                                />
                                                Account for today&apos;s plays (mindblock)
                                        </label>

                                        <label className="check">
                                                <input
                                                        type="checkbox" checked={excludeFailed}
                                                        onChange={e => update({ excludeFailed: e.target.checked })}
                                                />
                                                Hide maps you usually fail
                                        </label>

                                        <label
                                                className="check"
                                                title="Mindblock counts plays per difficulty, so several difficulties of one set are independent farm targets. Tick this only if you would rather not hear the same song repeatedly."
                                        >
                                                <input
                                                        type="checkbox" checked={oneMapPerSet}
                                                        onChange={e => update({ oneMapPerSet: e.target.checked })}
                                                />
                                                One difficulty per mapset
                                        </label>

                                        <label
                                                className="check"
                                                title="Mindblock counts plays per difficulty whatever the rate, so each extra rate of a difficulty is charged its plays. Needs locked rates."
                                                style={{ opacity: lockRates === 'none' ? 0.45 : undefined }}
                                        >
                                                <input
                                                        type="checkbox" checked={severalRates}
                                                        onChange={e => update({ severalRates: e.target.checked })}
                                                />
                                                Several rates of one difficulty
                                        </label>

                                        {medals === null && (
                                                <span className="hint" title="The medal list comes from the game server; XP is ranked without the medal bonus.">
                                                        Medal bonus unavailable
                                                </span>
                                        )}
                                        {medals != null && medals > 1 && (
                                                <span className="hint" title="Every medal held compounds its tier's XP bonus onto each play.">
                                                        Medals +{((medals - 1) * 100).toFixed(1)}% XP
                                                </span>
                                        )}

                                        <div
                                                className="field"
                                                title="Only simulate difficulties whose star rating falls inside this range - most libraries pile up at the low end, so a window here cuts most of the scan. The scan still runs easiest to hardest inside it. Leave a side empty for no limit; maps the game has not rated count as 0 stars."
                                        >
                                                Star range
                                                <span className="range">
                                                        <input
                                                                type="number" min={0} max={12} step={0.1}
                                                                value={minStarsRaw}
                                                                placeholder="any"
                                                                onChange={e => update({ minStars: e.target.value })}
                                                        />
                                                        <span className="dash">-</span>
                                                        <input
                                                                type="number" min={0} max={12} step={0.1}
                                                                value={maxStarsRaw}
                                                                placeholder="any"
                                                                onChange={e => update({ maxStars: e.target.value })}
                                                        />
                                                </span>
                                        </div>

                                        <span className="spacer" style={{ flex: 1 }} />

                                        <button
                                                className="primary" onClick={scan} disabled={scanning || noRates || badRange}
                                                title={noRates
                                                        ? 'Pick at least one rate'
                                                        : badRange
                                                                ? 'The star range matches nothing - its minimum is above its maximum'
                                                                : undefined}
                                        >
                                                {scanning ? 'Simulating...' : results.length ? 'Re-scan' : 'Scan library'}
                                        </button>
                                        {scanning && (
                                                <button onClick={() => sweepRef.current?.cancel()}>Stop</button>
                                        )}
                                </div>

                                <div className="body">
                                        {phase.kind === 'error' && <div className="empty error">{phase.message}</div>}

                                        {!results.length && phase.kind !== 'error' && (
                                                <div className="empty">
                                                        {scanning
                                                                ? 'Simulating your library...'
                                                                : <>Scan your library to rank every downloaded map by XP per second.<br />
                                                                        Every map is played by a simulation of your current character.</>}
                                                </div>
                                        )}

                                        {!!results.length && (
                                                <table>
                                                        <thead>
                                                                <tr>
                                                                        <th className="rank" />
                                                                        <th>Map</th>
                                                                        <th className="num">SR</th>
                                                                        <th className="num">Length</th>
                                                                        <th className="num">Acc</th>
                                                                        <th className="num">pp</th>
                                                                        {!targetPp && (
                                                                                <>
                                                                                        <th className="num">{`${targetName} XP`}</th>
                                                                                        <th className="num">XP/s</th>
                                                                                </>
                                                                        )}
                                                                        <th className="num">Fail</th>
                                                                        <th className="num">Played 24h</th>
                                                                        <th className="act" title="Re-simulate this one map with the character as it is now">↻</th>
                                                                </tr>
                                                        </thead>
                                                        <tbody>
                                                                {rows.slice(0, 300).map((map, position) => {
                                                                        const info = index.get(map.beatmapId);
                                                                        return (
                                                                                <tr
                                                                                        key={rowKey(map)}
                                                                                        className={rotationIds.has(rowKey(map)) ? 'picked' : undefined}
                                                                                        title={rotationIds.has(rowKey(map)) ? 'In the generated playlist' : undefined}
                                                                                >
                                                                                        <td className="rank">{position + 1}</td>
                                                                                        <td className="map">
                                                                                                <div className="title">
                                                                                                        {info ? `${info.artist} - ${info.title}` : `#${map.beatmapId}`}
                                                                                                </div>
                                                                                                <div className="sub">{versionLabel(info?.version ?? '', map.rate)}</div>
                                                                                        </td>
                                                                                        <td className="num">{(map.stars || info?.difficulty)?.toFixed(2) ?? '-'}</td>
                                                                                        <td className="num">{formatTime(map.durationSec)}</td>
                                                                                        <td className="num">{(map.accuracy * 100).toFixed(2)}%</td>
                                                                                        <td className={targetPp ? 'num rate' : 'num'}>
                                                                                                {map.pp.toFixed(targetPp ? 1 : 0)}
                                                                                        </td>
                                                                                        {!targetPp && (
                                                                                                <>
                                                                                                        <td className="num">{Math.round(map.value).toLocaleString()}</td>
                                                                                                        <td
                                                                                                                className="num rate"
                                                                                                                title={`+/- ${(map.variation * 100).toFixed(0)}% across ${map.runs} run(s)`}
                                                                                                        >
                                                                                                                {formatRate(map.perSecond)}
                                                                                                        </td>
                                                                                                </>
                                                                                        )}
                                                                                        <td className="num">
                                                                                                {map.failRate ? `${Math.round(map.failRate * 100)}%` : ''}
                                                                                        </td>
                                                                                        <td className="num">{map.recentPlays || ''}</td>
                                                                                        <td className="act">
                                                                                                <button
                                                                                                        className="rescan"
                                                                                                        title="Re-simulate this map at every picked rate, with the character as it is now - no full scan"
                                                                                                        disabled={scanning || noRates || rescanning.has(map.beatmapId)}
                                                                                                        onClick={() => void rescanMap(map)}
                                                                                                >
                                                                                                        {rescanning.has(map.beatmapId) ? '…' : '↻'}
                                                                                                </button>
                                                                                        </td>
                                                                                </tr>
                                                                        );
                                                                })}
                                                        </tbody>
                                                </table>
                                        )}
                                </div>

                                <footer>
                                        {scanning && (
                                                <>
                                                        <div className="bar">
                                                                <div style={{ width: `${phase.total ? (phase.done / phase.total) * 100 : 0}%` }} />
                                                        </div>
                                                        <span className="status">
                                                                {phase.done} / {phase.total}
                                                                {skippedCount ? ` - ${skippedCount} skipped as too hard` : ''}
                                                        </span>
                                                        {walls.length > 0 && (
                                                                <span
                                                                        className="status"
                                                                        title="After failed maps in a row, everything harder in that long-note class is skipped without scanning. Resets on the next scan."
                                                                >
                                                                        {walls.map(wall => `${bucketLabel(wall.bucket)} above ${wall.stars.toFixed(2)}`).join(' · ')}
                                                                </span>
                                                        )}
                                                </>
                                        )}

                                        {!scanning && (
                                                <>
                                                        <label className="check">
                                                                Playlist
                                                                <input
                                                                        type="text" value={playlistName}
                                                                        onChange={e => update({
                                                                playlistName: e.target.value, playlistNameTouched: true,
                                                        })}
                                                                />
                                                        </label>
                                                        <label className="check">
                                                                Maps
                                                                <input
                                                                        type="number" min={1} max={20} value={playlistSize}
                                                                        onChange={e => update({ playlistSize: Math.max(1, Number(e.target.value) || 1) })}
                                                                />
                                                        </label>
                                                        <label
                                                                className="check"
                                                                title="A locked entry plays at its own rate; an unlocked one follows the rate picked in song select, so an unlocked playlist sticks to one rate."
                                                        >
                                                                Lock rates
                                                                <select
                                                                        value={lockRates}
                                                                        onChange={e => update({ lockRates: e.target.value as RateLock })}
                                                                >
                                                                        <option value="all">All</option>
                                                                        <option value="rated">All but x1</option>
                                                                        <option value="none">None</option>
                                                                </select>
                                                        </label>
                                                        <button
                                                                className="primary"
                                                                onClick={savePlaylist}
                                                                disabled={!rotation.length || saveState === 'saving'}
                                                        >
                                                                {saveState === 'saving'
                                                                        ? 'Saving...'
                                                                        : `Save ${rotation.length}${oneRate} as playlist`}
                                                        </button>
                                                        <span className={saveState && saveState !== 'saving' ? 'status ok' : 'status'}>
                                                                {saveState === 'saving' ? '' : saveState}
                                                        </span>
                                                        <span className="spacer" style={{ flex: 1 }} />
                                                        {targetPp && (
                                                                <span className="status" title={PP_NOTE}>
                                                                        ranked by pp per play
                                                                </span>
                                                        )}
                                                        {notice && (
                                                                <span className="status error">{notice}</span>
                                                        )}
                                                        {walls.length > 0 && (
                                                                <span
                                                                        className="status"
                                                                        title="After failed maps in a row, everything harder in that long-note class was skipped without scanning. Resets on the next scan."
                                                                >
                                                                        {walls.map(wall => `${bucketLabel(wall.bucket)} above ${wall.stars.toFixed(2)}`).join(' · ')}
                                                                </span>
                                                        )}
                                                        <span className="status">
                                                                {results.length
                                                                        ? `${rows.length} playable of ${simulatedMaps} simulated`
                                                                        : ''}
                                                                {skippedCount ? ` - ${skippedCount} skipped as too hard` : ''}
                                                                {errorCount ? ` - ${errorCount} skipped` : ''}
                                                                {duplicateCount ? ` - ${duplicateCount} duplicate` : ''}
                                                                {rangeCount ? ` - ${rangeCount} outside star range` : ''}
                                                        </span>
                                                </>
                                        )}
                                </footer>
                        </div>
                </div>
        );
}
