/**
 * Round 2: inside the ManiaGame constructor, the pp wasm share, and yield costs.
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

const dir = join(REPO_ROOT, '.scanbench2');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const chart = (notes, lnShare, bpm = 180) => {
        const cols = [64, 192, 320, 448];
        let seeded = 12345;
        const rand = () => (seeded = (seeded * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
        const beat = 60000 / bpm;
        const lines = [
                'osu file format v14', '',
                '[General]', 'AudioFilename: audio.mp3', 'Mode: 3', '',
                '[Metadata]', 'Title: b', 'Artist: b', 'Creator: b', 'Version: b', '',
                '[Difficulty]',
                'CircleSize: 4', 'OverallDifficulty: 8', 'ApproachRate: 5',
                'SliderMultiplier: 1.4', 'SliderTickRate: 1', '',
                '[TimingPoints]', `0,${beat.toFixed(3)},4,2,0,60,1,0`,
        ];
        for (let t = beat * 8; t < notes * 100; t += beat * 8) {
                lines.push(`${Math.round(t)},-${(0.8 + rand() * 0.4).toFixed(3)},4,2,0,60,0,0`);
        }
        lines.push('', '[HitObjects]');
        let time = 1000;
        for (let i = 0; i < notes; i++) {
                const x = cols[Math.floor(rand() * 4)];
                const ln = rand() < lnShare;
                const dur = ln ? Math.round(100 + rand() * 400) : 0;
                if (ln) lines.push(`${x},192,${time},128,0,${time + dur}:0:0:0:0:`);
                else lines.push(`${x},192,${time},1,0,0:0:0:0:`);
                time += Math.round(60 + rand() * 180);
        }
        return lines.join('\n');
};

const charts = [
        { name: 'med-2000', text: chart(2000, 0.15) },
        { name: 'large-6000', text: chart(6000, 0.2) },
];

writeFileSync(join(dir, 'charts.json'), JSON.stringify(charts));

writeFileSync(join(dir, 'e.mjs'), `
import '@oss-idle/shared/osu/controlPointPatch';
import { BeatmapDecoder } from 'osu-parsers';
import { ManiaGame } from '@oss-idle/shared/sim/maniaGame';
import CharacterBot from '@oss-idle/shared/sim/bots/character';
import { Bot } from '@oss-idle/shared/sim/bot';
import { makeOrderedSkills } from '@oss-idle/shared/sim/skills/factory';
import { MessageChannel } from 'node:worker_threads';
import { ppReady, ppChart } from '../src/engine/pp.js';

const decoder = new BeatmapDecoder();
const now = () => Number(process.hrtime.bigint()) / 1e6;

const characterRow = {};
for (const s of makeOrderedSkills()) {
        characterRow[s.name] = 50;
        characterRow[s.name + 'XP'] = 5000;
        characterRow[s.name + 'Upgrades'] = 2;
        characterRow[s.name + 'Overdrive'] = 0;
        characterRow[s.name + 'Prestige'] = 0;
}
const skillsFrom = () => {
        const skills = makeOrderedSkills();
        for (const skill of skills) {
                for (const [field, column] of [
                        ['level', skill.name], ['xp', skill.name + 'XP'],
                        ['upgrades', skill.name + 'Upgrades'], ['overdrive', skill.name + 'Overdrive'],
                        ['prestige', skill.name + 'Prestige'],
                ]) {
                        const value = characterRow[column];
                        if (typeof value === 'number') skill[field].set(value);
                }
        }
        return skills;
};

class NoopBot extends Bot {
        generateEvents() { return []; }
}

const decode = (text) => {
        const chart = decoder.decodeFromString(text);
        for (const tp of chart.controlPoints.timingPoints) tp.beatLengthUnlimited = tp.beatLength;
        return chart;
};

export async function bench(text) {
        const t = {};
        const decoded = decode(text);
        const runs = 3, rates = [1, 1.1, 1.2, 1.3];

        // full construction cost, real bot
        let a = now();
        for (let i = 0; i < runs * rates.length; i++) {
                const bot = new CharacterBot(skillsFrom(), decoded.difficulty.overallDifficulty);
                new ManiaGame(decoded, bot, { rate: rates[i % rates.length] });
        }
        t.fullConstruct = (now() - a) / (runs * rates.length);

        // construction cost with the bot's analysis replaced by nothing
        a = now();
        for (let i = 0; i < runs * rates.length; i++) {
                new ManiaGame(decoded, new NoopBot(), { rate: rates[i % rates.length] });
        }
        t.prepConstruct = (now() - a) / (runs * rates.length);
        t.botShare = t.fullConstruct - t.prepConstruct;

        // yields
        const n = 2000;
        a = now();
        for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r));
        t.setTimeout = (now() - a) / n;

        const ch = new MessageChannel();
        a = now();
        for (let i = 0; i < n; i++) await new Promise(r => { ch.port1.onmessage = r; ch.port2.postMessage(0); });
        t.messageChannel = (now() - a) / n;
        ch.port1.close(); ch.port2.close();

        a = now();
        for (let i = 0; i < n; i++) await new Promise(r => queueMicrotask(r));
        t.microtask = (now() - a) / n;

        return t;
}

// pp costs, through the add-on's own pp module (wasm embedded as base64)
export async function ppBench(text) {
        const ok = await ppReady();
        if (!ok) return { error: 'wasm init failed' };
        const chart = ppChart(text, true);
        const now2 = () => Number(process.hrtime.bigint()) / 1e6;

        let a = now2();
        const stars = chart.stars(1.2);
        const starsMs = now2() - a;

        const score = {
                score: 850000, accuracy: 0.97, maxCombo: 1200,
                counts: { MARVELOUS: 400, PERFECT: 900, GREAT: 300, GOOD: 200, BAD: 50, MISS: 12 },
        };
        a = now2();
        for (let i = 0; i < 12; i++) chart.calculate(score, 1.2);
        const calc12Ms = now2() - a;

        a = now2();
        chart.stars(1.2);
        const stars2Ms = now2() - a;

        a = now2();
        const c2 = ppChart(text, true);
        const parseMs = now2() - a;

        // a whole simulate()-shaped call: 12 calculates + 4 stars, as one map pays
        a = now2();
        for (let r = 0; r < 4; r++) {
                for (let i = 0; i < 3; i++) chart.calculate(score, [1, 1.1, 1.2, 1.3][r]);
                chart.stars([1, 1.1, 1.2, 1.3][r]);
        }
        const perMapMs = now2() - a;
        c2.free(); chart.free();
        return { starsMs, stars2Ms, calc12Ms, parseMs, perMapMs, stars };
}
`);

await build({
        entryPoints: [join(dir, 'e.mjs')], outfile: join(dir, 'b.mjs'), bundle: true,
        format: 'esm', platform: 'node', target: 'es2022',
        loader: { '.wasm': 'base64' },
        plugins: [
                dedupePlugin(['osu-classes', 'osu-parsers', 'osu-mania-stable'], REPO_ROOT),
                sharedSourcePlugin(join(game.root, 'packages/shared/src')),
                tsExtensionPlugin(),
        ],
        absWorkingDir: REPO_ROOT,
});
const { bench, ppBench } = await import(pathToFileURL(join(dir, 'b.mjs')).href);

for (const { name, text } of charts) {
        const t = await bench(text);
        const pp = await ppBench(text);
        console.log(`\n${name}`);
        console.log(`  construction:      ${t.fullConstruct.toFixed(1)}ms total  (bot analysis ${(100 * t.botShare / t.fullConstruct).toFixed(0)}%, runtime prep ${(100 * t.prepConstruct / t.fullConstruct).toFixed(0)}%)`);
        console.log(`  yields:            setTimeout ${(t.setTimeout * 1000).toFixed(0)}us  messageChannel ${(t.messageChannel * 1000).toFixed(0)}us  microtask ${(t.microtask * 1000).toFixed(1)}us`);
        console.log(`  pp per map:        parse ${pp.parseMs.toFixed(1)}ms  stars(1 rate) ${pp.starsMs.toFixed(1)}ms  calculate(12 runs) ${pp.calc12Ms.toFixed(1)}ms  [stars=${pp.stars.toFixed(2)}]`);
}
rmSync(dir, { recursive: true, force: true });
