/**
 * Where a scan's wall-clock time actually goes, measured on synthetic charts.
 *
 * The stock bench.mjs needs the game's private chart cache; this one generates
 * realistic 4K charts itself and splits the worker's per-map cost into the
 * pieces we can act on:
 *
 *   decode   - osu-parsers text -> Beatmap, once per map
 *   ruleset  - ManiaRuleset.applyToBeatmap, once per ManiaGame (i.e. per run x rate!)
 *   skills   - makeOrderedSkills + the worker's field restore, per run x rate
 *   build    - the rest of the ManiaGame constructor (notes, scroll, bot events)
 *   play     - update() to the end
 *   xp       - getSkillsXP
 *   settle   - one setTimeout(0) yield, as the worker does per rate
 *
 * Also times the two hoisting candidates directly: re-applying the ruleset to
 * an already-converted beatmap, and building skills once vs per run.
 */
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { resolveGameRoot } from './resolve-game.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const game = resolveGameRoot();
const { sharedSourcePlugin, tsExtensionPlugin, dedupePlugin } =
        await import('@oss-idle/addon-sdk/build');

const dir = join(REPO_ROOT, '.scanbench');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

/** A synthetic but realistic 4K mania chart. */
const chart = (notes, lnShare, bpm = 180) => {
        const cols = [64, 192, 320, 448];
        let seeded = 12345;
        const rand = () => (seeded = (seeded * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

        const beat = 60000 / bpm;
        const lines = [
                'osu file format v14', '',
                '[General]', 'AudioFilename: audio.mp3', 'Mode: 3', '',
                '[Metadata]', 'Title: bench', 'Artist: bench', 'Creator: bench', 'Version: bench', '',
                '[Difficulty]',
                'CircleSize: 4', 'OverallDifficulty: 8', 'ApproachRate: 5',
                'SliderMultiplier: 1.4', 'SliderTickRate: 1', '',
                '[TimingPoints]',
                `0,${beat.toFixed(3)},4,2,0,60,1,0`,
        ];
        // a little SV, one point every ~8 beats
        for (let t = beat * 8; t < notes * 100; t += beat * 8) {
                lines.push(`${Math.round(t)},-${(0.8 + rand() * 0.4).toFixed(3)},4,2,0,60,0,0`);
        }
        lines.push('', '[HitObjects]');
        let time = 1000;
        const gapMin = 60, gapMax = 240; // ~4-16 nps aggregate
        for (let i = 0; i < notes; i++) {
                const x = cols[Math.floor(rand() * 4)];
                const ln = rand() < lnShare;
                const dur = ln ? Math.round(100 + rand() * 400) : 0;
                if (ln) {
                        lines.push(`${x},192,${time},128,0,${time + dur}:0:0:0:0:`);
                } else {
                        lines.push(`${x},192,${time},1,0,0:0:0:0:`);
                }
                time += Math.round(gapMin + rand() * (gapMax - gapMin));
        }
        return lines.join('\n');
};

const charts = [
        { name: 'small-500', text: chart(500, 0.1) },
        { name: 'med-2000', text: chart(2000, 0.15) },
        { name: 'large-6000', text: chart(6000, 0.2) },
        { name: 'ln-3000', text: chart(3000, 0.6) },
];

writeFileSync(join(dir, 'charts.json'), JSON.stringify(charts));

writeFileSync(join(dir, 'e.mjs'), `
import '@oss-idle/shared/osu/controlPointPatch';
import { BeatmapDecoder } from 'osu-parsers';
import { ManiaRuleset } from 'osu-mania-stable';
import { ManiaGame } from '@oss-idle/shared/sim/maniaGame';
import CharacterBot from '@oss-idle/shared/sim/bots/character';
import { makeOrderedSkills } from '@oss-idle/shared/sim/skills/factory';
import Memory from '@oss-idle/shared/sim/skills/memory';

const decoder = new BeatmapDecoder();
const ruleset = new ManiaRuleset();
const now = () => Number(process.hrtime.bigint()) / 1e6;

const characterRow = {};
for (const s of makeOrderedSkills()) {
        characterRow[s.name] = 50;
        characterRow[s.name + 'XP'] = 5000;
        characterRow[s.name + 'Upgrades'] = 2;
        characterRow[s.name + 'Overdrive'] = 0;
        characterRow[s.name + 'Prestige'] = 0;
}

// the worker's skillsFrom, verbatim in spirit
const skillsFrom = (timesPlayed) => {
        const skills = makeOrderedSkills();
        for (const skill of skills) {
                const set = (field, column) => {
                        const value = characterRow[column];
                        if (typeof value === 'number') skill[field].set(value);
                };
                set('level', skill.name);
                set('xp', skill.name + 'XP');
                set('upgrades', skill.name + 'Upgrades');
                set('overdrive', skill.name + 'Overdrive');
                set('prestige', skill.name + 'Prestige');
                if (skill instanceof Memory) skill.timesPlayed.set(timesPlayed);
        }
        return skills;
};

const decode = (text) => {
        const chart = decoder.decodeFromString(text);
        for (const tp of chart.controlPoints.timingPoints) tp.beatLengthUnlimited = tp.beatLength;
        return chart;
};

export function bench(text, runs, rates) {
        const t = { decode: 0, ruleset: 0, skills: 0, build: 0, play: 0, xp: 0, notes: 0 };

        let a = now();
        const decoded = decode(text);
        t.decode = now() - a;

        // ruleset cost, as the worker pays it: inside every ManiaGame construction
        a = now();
        const appliedOnce = ruleset.applyToBeatmap(decoded);
        t.ruleset = now() - a;

        // what a construction costs when the beatmap is already converted
        a = now();
        ruleset.applyToBeatmap(appliedOnce);
        t.rulesetAgain = now() - a;

        a = now();
        const skills = skillsFrom(3);
        t.skills = now() - a;

        const skills2 = skillsFrom(3);
        a = now();
        for (let i = 0; i < runs * rates.length; i++) skillsFrom(3);
        t.skillsAll = now() - a;
        void skills; void skills2;

        // the worker's per-rate loop, timed piecewise (skills fresh per run, as now)
        for (const rate of rates) {
                for (let run = 0; run < runs; run++) {
                        a = now();
                        const bot = new CharacterBot(skillsFrom(3), decoded.difficulty.overallDifficulty);
                        t.skills += now() - a;

                        a = now();
                        const game = new ManiaGame(decoded, bot, { rate });
                        t.build += now() - a;
                        t.notes = game.totalNotes;

                        a = now();
                        game.update(game.songEndMs + 2000);
                        t.play += now() - a;

                        a = now();
                        bot.getSkillsXP(decoded.totalLength / rate, game.score);
                        t.xp += now() - a;
                }
        }
        return t;
}

export async function settleCost(n) {
        const settle = () => new Promise(r => setTimeout(r));
        const a = now();
        for (let i = 0; i < n; i++) await settle();
        return now() - a;
}
`);

await build({
        entryPoints: [join(dir, 'e.mjs')], outfile: join(dir, 'b.mjs'), bundle: true,
        format: 'esm', platform: 'node', target: 'es2022',
        plugins: [
                dedupePlugin(['osu-classes', 'osu-parsers', 'osu-mania-stable'], REPO_ROOT),
                sharedSourcePlugin(join(game.root, 'packages/shared/src')),
                tsExtensionPlugin(),
        ],
        absWorkingDir: REPO_ROOT,
});
const { bench, settleCost } = await import(pathToFileURL(join(dir, 'b.mjs')).href);

const RUNS = 3, RATES = [1, 1.1, 1.2, 1.3];
console.log(`\nscan bench   (runs=${RUNS}, rates=${RATES.join('/')} - one map, as a worker sees it)`);
console.log('chart          notes    decode   ruleset  ruleset2   skills  skillsAll    build     play       xp    total');

const sums = {};
for (const { name, text } of charts) {
        let r;
        try { r = bench(text, RUNS, RATES); } catch (e) { console.log(name, 'ERROR', e.message); continue; }
        const total = r.decode + r.ruleset * RUNS * RATES.length + r.skillsAll + r.build + r.play + r.xp;
        for (const k of ['decode', 'ruleset', 'rulesetAgain', 'skills', 'skillsAll', 'build', 'play', 'xp']) {
                sums[k] = (sums[k] ?? 0) + r[k];
        }
        sums.total = (sums.total ?? 0) + total;
        console.log(
                name.padEnd(14),
                String(r.notes).padStart(6),
                (r.decode.toFixed(1) + 'ms').padStart(9),
                (r.ruleset.toFixed(1) + 'ms').padStart(9),
                (r.rulesetAgain.toFixed(1) + 'ms').padStart(9),
                (r.skills.toFixed(1) + 'ms').padStart(8),
                (r.skillsAll.toFixed(1) + 'ms').padStart(9),
                (r.build.toFixed(1) + 'ms').padStart(8),
                (r.play.toFixed(1) + 'ms').padStart(8),
                (r.xp.toFixed(1) + 'ms').padStart(8),
                (total.toFixed(0) + 'ms').padStart(9),
        );
}

console.log('-'.repeat(110));
const share = (k) => {
        // ruleset is paid once per ManiaGame (run x rate); decode, skillsAll, build, play, xp likewise totalled above
        const weight = { decode: 1, ruleset: RUNS * RATES.length, rulesetAgain: 0, skills: 0, skillsAll: 1, build: 1, play: 1, xp: 1 };
        const v = (sums[k] ?? 0) * weight[k];
        return v;
};
let grand = 0;
for (const k of ['decode', 'ruleset', 'skillsAll', 'build', 'play', 'xp']) grand += share(k);
for (const k of ['decode', 'ruleset', 'skillsAll', 'build', 'play', 'xp']) {
        console.log('  share of scan:', k.padEnd(11), (100 * share(k) / grand).toFixed(1).padStart(6) + '%');
}
console.log('  (ruleset2 = re-applying to a converted beatmap; skills = one construction; skillsAll = 12 constructions as the worker pays)');

const ms = await settleCost(2000);
console.log(`\nsettle(): ${ms.toFixed(0)}ms per 2000 calls = ${(ms / 2000).toFixed(3)}ms each; a 5000-map scan x 4 rates pays ${(ms / 2000 * 20000).toFixed(0)}s in yields`);

rmSync(dir, { recursive: true, force: true });
