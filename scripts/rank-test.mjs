/** A pp target must rank by the pp a play scores, not by pp per second. */
import { build } from 'esbuild';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolveGameRoot } from './resolve-game.mjs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** This repository's root, so nothing depends on where it is checked out. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const game = resolveGameRoot();
const { sharedSourcePlugin, tsExtensionPlugin } =
        await import('@oss-idle/addon-sdk/build');

const dir = join(REPO_ROOT, '.ranktest');
rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'e.ts'), `export { rankMaps, buildRotation, tableRows } from '../src/farm/metrics.js';`);
await build({
        entryPoints: [join(dir, 'e.ts')], outfile: join(dir, 'b.mjs'), bundle: true,
        format: 'esm', platform: 'node', target: 'es2022',
        plugins: [sharedSourcePlugin(join(game.root, 'packages/shared/src')), tsExtensionPlugin()],
        absWorkingDir: REPO_ROOT,
});
const { rankMaps, buildRotation, tableRows } = await import(pathToFileURL(join(dir, 'b.mjs')).href);




const map = (beatmapId, pp, durationSec, xp, rate = 1) => ({
        setId: beatmapId * 10, beatmapId, rate, stars: 0, pp, durationSec,
        // accuracy is subject to mindblock; speed is one of the exempt skills, so
        // both are here to check the split.
        xp: { accuracy: xp, speed: xp }, totalXp: xp * 2,
        accuracy: 0.99, grade: 'S', runs: 3, failRate: 0, variation: 0,
});

// "short" scores less pp but is far quicker: a rate would rank it first.
const short = map(1, 100, 30, 300);
const long = map(2, 300, 300, 900);

let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? pass++ : (fail++, console.log('  FAIL:', n, x)); };

const byRate = rankMaps([short, long], { target: { kind: 'skills', skills: ['accuracy'] }, overheadSec: 0 });
check('XP target still ranks by rate', byRate[0].beatmapId === 1,
        `got ${byRate[0].beatmapId} (rates ${byRate.map(m => m.perSecond.toFixed(2))})`);

const byPP = rankMaps([short, long], { target: { kind: 'pp' }, overheadSec: 0 });
check('pp target ranks the higher-pp map first', byPP[0].beatmapId === 2,
        `got ${byPP[0].beatmapId}`);
check('pp target value is the pp itself', byPP[0].value === 300, `${byPP[0].value}`);

// overhead must not reorder a pp ranking
const byPPOverhead = rankMaps([short, long], { target: { kind: 'pp' }, overheadSec: 120 });
check('overhead does not change pp order', byPPOverhead[0].beatmapId === 2);

// mindblock scales XP, never score
const recent = new Map([[2, 25]]);
const blocked = rankMaps([short, long], { target: { kind: 'pp' }, recentPlays: recent });
check('mindblock does not reduce pp', blocked[0].value === 300, `${blocked[0].value}`);
const blockedXp = rankMaps([long], {
        target: { kind: 'skills', skills: ['accuracy'] }, recentPlays: recent,
});
check('mindblock reduces a mindblocked skill', blockedXp[0].value < 900, `${blockedXp[0].value}`);
const exemptXp = rankMaps([long], {
        target: { kind: 'skills', skills: ['speed'] }, recentPlays: recent,
});
check('mindblock leaves an exempt skill alone', exemptXp[0].value === 900, `${exemptXp[0].value}`);

// the medal bonus lands after mindblock, floored, like the server's getServerXP
const medalled = rankMaps([long], {
        target: { kind: 'skills', skills: ['accuracy'] }, recentPlays: recent, medalMultiplier: 1.5,
});
check('medals scale XP after mindblock', medalled[0].value === Math.floor(blockedXp[0].value * 1.5),
        `${medalled[0].value} vs ${blockedXp[0].value}`);
const medalledPP = rankMaps([long], { target: { kind: 'pp' }, medalMultiplier: 1.5 });
check('medals do not change pp', medalledPP[0].value === 300, `${medalledPP[0].value}`);
const medalRot = buildRotation(rankMaps([long], { target: { kind: 'skills', skills: ['speed'] } }),
        { size: 1, target: { kind: 'skills', skills: ['speed'] }, overheadSec: 0, medalMultiplier: 1.5 });
check('rotation applies medals', medalRot[0].perSecond === 1350 / 300, `${medalRot[0].perSecond}`);

// a pp rotation is simply the best-scoring maps
const rot = buildRotation(rankMaps([short, long], { target: { kind: 'pp' } }),
        { size: 2, target: { kind: 'pp' } });
check('pp rotation picks best pp first', rot[0].beatmapId === 2, `${rot.map(m => m.beatmapId)}`);
check('pp rotation keeps the real pp value', rot[0].value === 300, `${rot[0].value}`);

// one difficulty at two rates is two rows, and a playlist plays at one rate
const fast = map(1, 150, 20, 50, 1.3);
const rated = rankMaps([short, long, fast], { target: { kind: 'skills', skills: ['accuracy', 'speed'] }, overheadSec: 0 });
check('each rate of a map is its own row', rated.length === 3, `${rated.length}`);
const rateRot = buildRotation(rated, { size: 3, target: { kind: 'skills', skills: ['accuracy', 'speed'] }, overheadSec: 0 });
check('rotation sticks to one rate', new Set(rateRot.map(m => m.rate)).size === 1,
        `${rateRot.map(m => m.rate)}`);
check('rotation keeps the better rate', rateRot[0].rate === 1, `${rateRot.map(m => m.rate)}`);

// the table lists each difficulty once: its best rate, or the rotation's
const quick = map(1, 150, 20, 900, 1.3);
const both = rankMaps([short, long, quick], { target: { kind: 'skills', skills: ['accuracy', 'speed'] }, overheadSec: 0 });
const best = tableRows(both, []);
check('a difficulty is listed once', best.filter(m => m.beatmapId === 1).length === 1, `${best.length}`);
check('at its best rate', best.find(m => m.beatmapId === 1).rate === 1.3);
const held = tableRows(both, both.filter(m => m.rate === 1));
check('or at the rate the rotation holds it', held.find(m => m.beatmapId === 1).rate === 1);

// locked rates let a rotation mix them; a difficulty stays once unless allowed
const mixed = buildRotation(both, { size: 3, target: { kind: 'skills', skills: ['accuracy', 'speed'] }, overheadSec: 0, mixRates: true });
check('locked rotation mixes rates', new Set(mixed.map(m => m.rate)).size === 2, `${mixed.map(m => m.rate)}`);
check('a difficulty once by default', mixed.filter(m => m.beatmapId === 1).length === 1);
const several = buildRotation(both, {
        size: 3, target: { kind: 'skills', skills: ['accuracy', 'speed'] }, overheadSec: 0, mixRates: true, severalRates: true,
});
check('several rates of one difficulty when allowed', several.filter(m => m.beatmapId === 1).length === 2,
        `${several.map(m => `${m.beatmapId}@${m.rate}`)}`);
const ppSeveral = buildRotation(both, {
        size: 3, target: { kind: 'pp' }, mixRates: true, severalRates: true,
});
check('never for pp', ppSeveral.filter(m => m.beatmapId === 1).length === 1);
check('the table shows every rate the rotation holds',
        tableRows(both, several).filter(m => m.beatmapId === 1).length === 2);

// a skill subset counts only what it names - the toggle target
{
        const only = rankMaps([long], { target: { kind: 'skills', skills: ['accuracy'] }, overheadSec: 0 });
        check('a subset counts only its skills', only[0].value === 900, `${only[0].value}`);
        const pair = rankMaps([long], { target: { kind: 'skills', skills: ['accuracy', 'speed'] }, overheadSec: 0 });
        check('several skills sum', pair[0].value === 1800, `${pair[0].value}`);
        // mindblock still applies per skill inside a subset, and leaves the rest alone
        const mixed = rankMaps([long], {
                target: { kind: 'skills', skills: ['accuracy', 'speed'] }, recentPlays: recent,
        });
        check('a subset keeps the mindblock split', mixed[0].value === blockedXp[0].value + 900,
                `${mixed[0].value}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
