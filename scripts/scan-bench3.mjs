/**
 * Round 3: prove the two scan optimizations do what they claim.
 *
 * 1. Rate-skip: a character far under a chart's level fails every run at the
 *    slowest rate - the worker now stops after that rate. Measure the wall
 *    clock a hard-failed map costs with and without the skip, and confirm the
 *    verdict row kept is the slowest rate's.
 * 2. A character at level clears the same chart: no skip, all rates simulated,
 *    identical row count to the old behavior.
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

const dir = join(REPO_ROOT, '.scanbench3');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

// dense chart: ~11 nps sustained, OD 9 - hard for a level-8 character
const chart = (notes) => {
        const cols = [64, 192, 320, 448];
        let seeded = 999;
        const rand = () => (seeded = (seeded * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
        const lines = [
                'osu file format v14', '',
                '[General]', 'AudioFilename: audio.mp3', 'Mode: 3', '',
                '[Metadata]', 'Title: b', 'Artist: b', 'Creator: b', 'Version: b', '',
                '[Difficulty]',
                'CircleSize: 4', 'OverallDifficulty: 9', 'ApproachRate: 5', 'HPDrainRate: 9',
                'SliderMultiplier: 1.4', 'SliderTickRate: 1', '',
                '[TimingPoints]', '0,300,4,2,0,60,1,0', '',
                '[HitObjects]',
        ];
        let time = 1000;
        for (let i = 0; i < notes; i++) {
                lines.push(`${cols[Math.floor(rand() * 4)]},192,${time},1,0,0:0:0:0:`);
                time += 85 + Math.floor(rand() * 40); // ~9-12 nps
        }
        return lines.join('\n');
};

writeFileSync(join(dir, 'charts.json'), JSON.stringify({ hard: chart(1800) }));

writeFileSync(join(dir, 'e.mjs'), `
import '@oss-idle/shared/osu/controlPointPatch';
import { BeatmapDecoder } from 'osu-parsers';
import { ManiaGame } from '@oss-idle/shared/sim/maniaGame';
import CharacterBot from '@oss-idle/shared/sim/bots/character';
import { makeOrderedSkills } from '@oss-idle/shared/sim/skills/factory';
import Memory from '@oss-idle/shared/sim/skills/memory';

const decoder = new BeatmapDecoder();
const now = () => Number(process.hrtime.bigint()) / 1e6;
const rates = [1, 1.1, 1.2, 1.3];
const RUNS = 3;

const characterAt = (level) => {
        const row = {};
        for (const s of makeOrderedSkills()) {
                row[s.name] = level;
                row[s.name + 'XP'] = level * 100;
                row[s.name + 'Upgrades'] = 0;
                row[s.name + 'Overdrive'] = 0;
                row[s.name + 'Prestige'] = 0;
        }
        return row;
};

const skillsFrom = (row) => {
        const skills = makeOrderedSkills();
        for (const skill of skills) {
                for (const [field, column] of [
                        ['level', skill.name], ['xp', skill.name + 'XP'],
                        ['upgrades', skill.name + 'Upgrades'], ['overdrive', skill.name + 'Overdrive'],
                        ['prestige', skill.name + 'Prestige'],
                ]) {
                        if (typeof row[column] === 'number') skill[field].set(row[column]);
                }
                if (skill instanceof Memory) skill.timesPlayed.set(0);
        }
        return skills;
};

export function run(text, level, skipAfterFullFail) {
        const decoded = decoder.decodeFromString(text);
        for (const tp of decoded.controlPoints.timingPoints) tp.beatLengthUnlimited = tp.beatLength;

        const row = characterAt(level);
        const rows = [];
        let constructions = 0;
        const a = now();
        for (const rate of rates) {
                constructions++;
                let failures = 0;
                for (let run = 0; run < RUNS; run++) {
                        const bot = new CharacterBot(skillsFrom(row), decoded.difficulty.overallDifficulty);
                        const game = new ManiaGame(decoded, bot, { rate });
                        game.update(game.songEndMs + 2000);
                        if (game.score.failed) failures++;
                }
                const failRate = failures / RUNS;
                rows.push({ rate, failRate });
                if (skipAfterFullFail && failRate >= 1) break;
        }
        return { ms: now() - a, constructions, rows };
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
const { run } = await import(pathToFileURL(join(dir, 'b.mjs')).href);

const charts = JSON.parse((await import('node:fs')).readFileSync(join(dir, 'charts.json'), 'utf8'));

// level 8 against the dense chart: expect hard failure at x1
const RATES = [1, 1.1, 1.2, 1.3];
const under = run(charts.hard, 8, false);
const underSkip = run(charts.hard, 8, true);
console.log(`\nlevel 8 vs dense OD9 chart (runs=3, rates=${RATES.join('/')})`);
console.log('  no skip:  ', under.ms.toFixed(0) + 'ms', `${under.constructions} rate(s) simulated`, JSON.stringify(under.rows));
console.log('  with skip:', underSkip.ms.toFixed(0) + 'ms', `${underSkip.constructions} rate(s) simulated`, JSON.stringify(underSkip.rows));
const saved = 100 * (1 - underSkip.ms / under.ms);
console.log(`  -> ${saved.toFixed(0)}% less sim time on this map; kept row = slowest rate (x1): ${underSkip.rows[0].rate === 1}`);

// level 50: expect clears at x1 - no skip may fire
const at = run(charts.hard, 50, false);
const atSkip = run(charts.hard, 50, true);
console.log(`\nlevel 50 vs the same chart`);
console.log('  no skip:  ', at.ms.toFixed(0) + 'ms', `${at.constructions} rate(s)`, at.rows.map(r => r.failRate).join(','));
console.log('  with skip:', atSkip.ms.toFixed(0) + 'ms', `${atSkip.constructions} rate(s)`, atSkip.rows.map(r => r.failRate).join(','));
console.log(`  -> identical work when the map is clearable: ${at.constructions === atSkip.constructions}`);

rmSync(dir, { recursive: true, force: true });
