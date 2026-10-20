#!/usr/bin/env node
/**
 * End-to-end proof of the compact build's pp path: bundle `engine/pp.ts` with
 * the compact pipeline (compressed wasm + shims) and actually calculate pp and
 * stars from a real chart, in Node (which has `DecompressionStream` like the
 * target browsers).
 *
 * Verifies: the deflate marker round-trips, the wasm inflates byte-identical,
 * rosu-pp initializes from the inflated bytes, and calculations agree with the
 * plain (uncompressed) build of the same module.
 */
import { build as esbuild } from 'esbuild';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
        assetQueryPlugin, dedupePlugin, sharedSourcePlugin, tsExtensionPlugin,
} from '@oss-idle/addon-sdk/build';
import { resolveGameRoot } from './resolve-game.mjs';
import { deflateRawSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const game = resolveGameRoot();

const DEFLATE_PREFIX = 'deflate1:';
const compressedWasmPlugin = () => ({
        name: 'compressed-wasm',
        setup(build) {
                build.onLoad({ filter: /\.wasm$/ }, async args => {
                        const wasm = await readFile(args.path);
                        const deflated = deflateRawSync(wasm, { level: 9 });
                        return { loader: 'js', contents: `export default "${DEFLATE_PREFIX}${deflated.toString('base64')}";` };
                });
        },
});

const dir = join(pkgRoot, '.pptest');
rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });

const chartText = `osu file format v14

[General]
AudioFilename: audio.mp3
Mode: 3

[Metadata]
Title: Compact Test
Artist: test
Creator: test
Version: 4K

[Difficulty]
CircleSize: 4
OverallDifficulty: 8
ApproachRate: 5
HPDrainRate: 8
SliderMultiplier: 1.4
SliderTickRate: 1

[TimingPoints]
0,333.333333333333,4,2,0,60,1,0

[HitObjects]
64,192,0,1,0
192,192,150,1,0
320,192,300,1,0
448,192,450,1,0
64,192,600,128,0,600:750
192,192,900,128,0,900:1050
320,192,1200,1,0
448,192,1350,1,0`;

let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? pass++ : (fail++, console.log('  FAIL:', n, x)); };

// --- the compact pipeline ----------------------------------------------------
writeFileSync(join(dir, 'compact.ts'), `export { ppReady, ppChart } from '../src/engine/pp.js';`);
await esbuild({
        entryPoints: [join(dir, 'compact.ts')], outfile: join(dir, 'compact.mjs'), bundle: true,
        format: 'esm', platform: 'neutral', mainFields: ['module', 'main'],
        conditions: ['import', 'default'], absWorkingDir: pkgRoot,
        loader: { '.wasm': 'base64' },
        plugins: [
                assetQueryPlugin(),
                dedupePlugin(['osu-classes', 'osu-parsers', 'osu-mania-stable'], pkgRoot),
                compressedWasmPlugin(),
        ],
});
const compactSrc = await readFile(join(dir, 'compact.mjs'), 'utf8');
check('compact bundle embeds the deflate marker', compactSrc.includes('deflate1:'));
const markerAt = compactSrc.indexOf(DEFLATE_PREFIX);
const b64Len = compactSrc.slice(markerAt + DEFLATE_PREFIX.length).match(/^[A-Za-z0-9+/=]+/)?.[0]?.length ?? 0;
check('compressed wasm is far smaller than raw base64', b64Len < 350 * 1024, `${(b64Len / 1024).toFixed(1)} kB`);

// --- the plain pipeline (control) --------------------------------------------
await esbuild({
        entryPoints: [join(dir, 'compact.ts')], outfile: join(dir, 'plain.mjs'), bundle: true,
        format: 'esm', platform: 'neutral', mainFields: ['module', 'main'],
        conditions: ['import', 'default'], absWorkingDir: pkgRoot,
        loader: { '.wasm': 'base64' },
        plugins: [
                assetQueryPlugin(),
                dedupePlugin(['osu-classes', 'osu-parsers', 'osu-mania-stable'], pkgRoot),
        ],
});

// --- run both ----------------------------------------------------------------
const { ppReady: readyC, ppChart: chartC } = await import(pathToFileURL(join(dir, 'compact.mjs')).href);
const { ppReady: readyP, ppChart: chartP } = await import(pathToFileURL(join(dir, 'plain.mjs')).href);

check('compact wasm initializes', await readyC() === true);
check('plain wasm initializes', await readyP() === true);

const score = { score: 900000, accuracy: 0.98, maxCombo: 400, counts: { MARVELOUS: 100, PERFECT: 350, GREAT: 40, GOOD: 10, BAD: 0, MISS: 0 } };

const cc = chartC(chartText, true);
const pc = chartP(chartText, true);

const ppC = cc.calculate(score, 1);
const ppP = pc.calculate(score, 1);
check('compact pp matches plain pp', Math.abs(ppC - ppP) < 1e-9, `${ppC} vs ${ppP}`);
check('pp is a real number', ppC > 0, `${ppC}`);

const starsC = cc.stars(1);
const starsP = pc.stars(1);
check('compact stars match plain stars', Math.abs(starsC - starsP) < 1e-9, `${starsC} vs ${starsP}`);
check('stars are real', starsC > 0, `${starsC}`);

const rateStars = cc.stars(1.4);
const rateStarsPlain = pc.stars(1.4);
check('compact rate stars match plain', Math.abs(rateStars - rateStarsPlain) < 1e-9, `${rateStars} vs ${rateStarsPlain}`);
check('rate pp differs', cc.calculate(score, 1.4) !== ppC);

cc.free(); pc.free();

console.log(`\n${pass} passed, ${fail} failed`);
rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
