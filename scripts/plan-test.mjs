/** planSweep must list each difficulty once - duplicate ids break the table's
 *  React keys, which is what makes stale rows survive a re-sort. */
import { build } from 'esbuild';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** This repository's root, so nothing depends on where it is checked out. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');


const dir = join(REPO_ROOT, '.plantest');
rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'e.ts'), `export { planSweep } from '../src/engine/client.js';`);
await build({
        entryPoints: [join(dir, 'e.ts')], outfile: join(dir, 'b.mjs'), bundle: true,
        format: 'esm', platform: 'neutral', mainFields: ['module', 'main'],
        conditions: ['import', 'default'],
        absWorkingDir: REPO_ROOT,
        // planSweep is pure, but its module also pulls in the kit, the game's
        // rebirth and rate helpers and the worker factory. Stub them: the test is about the
        // planning logic, not what the sweep would then do with it.
        plugins: [{
                name: 'stub-deps',
                setup(b) {
                        b.onResolve({ filter: /^(@oss-idle\/addon-sdk|@oss-idle\/shared\/.*|worker:.*)$/ },
                                a => ({ path: a.path, namespace: 'stub' }));
                        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
                                contents: 'export default () => {}; export const beatmapStore = {};'
                                        + ' export const gameCharacter = {}; export const gameDb = {};'
                                        + ' export const playCountsSince = async () => ({});'
                                        + ' export const hasUnlock = () => false;'
                                        + ' export const medalXPMultiplier = () => 1;'
                                        + ' export const allowedRate = () => 1; export const rateSteps = () => [1];',
                                loader: 'js',
                        }));
                },
        }],
});
const { planSweep } = await import(pathToFileURL(join(dir, 'b.mjs')).href);




const v = (id, mode = 3, keys = 4, difficulty, rice, ln) => ({ id, mode, keys, difficulty, rice, ln });
let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? pass++ : (fail++, console.log('  FAIL:', n, x)); };

let r = planSweep([{ id: 1, versions: [v(10), v(11)] }]);
check('lists playable difficulties', r.requests.length === 2);
check('no duplicates reported', r.duplicates === 0);

// same beatmapId under two stored sets (stale set record after a re-download)
r = planSweep([{ id: 1, versions: [v(10)] }, { id: 2, versions: [v(10), v(12)] }]);
check('cross-set duplicate dropped', r.requests.length === 2, JSON.stringify(r.requests));
check('duplicate counted', r.duplicates === 1);
check('keeps the first set for it', r.requests[0].setId === 1);

// same id twice inside one set
r = planSweep([{ id: 1, versions: [v(10), v(10)] }]);
check('within-set duplicate dropped', r.requests.length === 1);

// non-4K is skipped, not counted as duplicate
r = planSweep([{ id: 1, versions: [v(10, 0), v(11, 3, 7), v(12)] }]);
check('non-mania and non-4K skipped', r.requests.length === 1, JSON.stringify(r.requests));
check('skips counted', r.skippedMode === 2);

// the scan order: lowest stars first, unrated ahead of everything
r = planSweep([
        { id: 1, versions: [v(10, 3, 4, 4.5)] },
        { id: 2, versions: [v(11, 3, 4, 1.2)] },
        { id: 3, versions: [v(12)] },
]);
check('sorted by stars, unrated first',
        r.requests.map(x => x.beatmapId).join(',') === '12,11,10',
        JSON.stringify(r.requests));
check('star ratings carried onto requests', r.requests[1].stars === 1.2);
check('unrated carries stars 0', r.requests[0].stars === 0);

// the LN class rides along from the stored counts
r = planSweep([{ id: 1, versions: [v(13, 3, 4, 2, 100, 0), v(14, 3, 4, 2, 50, 50)] }]);
check('rice request carries class 0', r.requests.find(x => x.beatmapId === 13).bucket === 0);
check('even split carries class 2', r.requests.find(x => x.beatmapId === 14).bucket === 2);

// a duplicate keeps the first listing, stars and class included
r = planSweep([
        { id: 1, versions: [v(20, 3, 4, 5.0, 100, 0)] },
        { id: 2, versions: [v(20, 3, 4, 2.0, 0, 100)] },
]);
check('duplicate keeps the first occurrence whole',
        r.requests.length === 1 && r.requests[0].stars === 5.0 && r.requests[0].bucket === 0,
        JSON.stringify(r.requests));

// every emitted id is unique - the property the table depends on
const many = Array.from({ length: 50 }, (_, i) => ({
        id: i, versions: [v(i % 10), v(100 + i)],
}));
r = planSweep(many);
const ids = r.requests.map(x => x.beatmapId);
check('all emitted ids unique', new Set(ids).size === ids.length);

r = planSweep([{ id: 1 }]);
check('a set with no versions is fine', r.requests.length === 0);

// the star range: a window keeps only difficulties inside it, inclusive
const rated = [{ id: 1, versions: [
        v(30, 3, 4, 1.0), v(31, 3, 4, 3.0), v(32, 3, 4, 4.5), v(33, 3, 4, 6.0),
] }];
r = planSweep(rated, { min: 3, max: 5 });
check('range keeps only the window', r.requests.map(x => x.beatmapId).join(',') === '31,32',
        JSON.stringify(r.requests));
check('range counts exclusions on both ends', r.skippedRange === 2);
check('bounds are inclusive', r.requests.length === 2);

// either bound on its own
r = planSweep(rated, { min: 3 });
check('a minimum alone drops everything below', r.requests.map(x => x.stars).join(',') === '3,4.5,6');
check('a minimum alone counts the dropped', r.skippedRange === 1);
r = planSweep(rated, { max: 3 });
check('a maximum alone drops everything above', r.requests.map(x => x.stars).join(',') === '1,3');
check('a maximum alone counts the dropped', r.skippedRange === 2);

// unrated counts as 0: below any minimum, inside an open one
r = planSweep([{ id: 1, versions: [v(34, 3, 4), v(35, 3, 4, 2.0)] }], { min: 1 });
check('a minimum excludes unrated difficulties', r.requests.map(x => x.beatmapId).join(',') === '35');
check('unrated exclusions are counted', r.skippedRange === 1);
r = planSweep([{ id: 1, versions: [v(34, 3, 4), v(35, 3, 4, 2.0)] }], { max: 1 });
check('a maximum alone keeps unrated difficulties', r.requests.map(x => x.beatmapId).join(',') === '34');
check('the rated one outside the window is counted', r.skippedRange === 1);

// a range that excludes everything leaves a countable reason for the empty scan
r = planSweep(rated, { min: 8, max: 9 });
check('an empty window reports every difficulty', r.requests.length === 0 && r.skippedRange === 4);

// a zero bound is no bound at all
r = planSweep(rated, { min: 0, max: 0 });
check('zero bounds are no bounds', r.requests.length === 4 && r.skippedRange === 0);

// duplicates are counted before the range sees them
r = planSweep([
        { id: 1, versions: [v(40, 3, 4, 1.0)] },
        { id: 2, versions: [v(40, 3, 4, 1.0)] },
], { min: 3 });
check('a duplicate out of range is still a duplicate',
        r.duplicates === 1 && r.skippedRange === 1 && r.requests.length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
