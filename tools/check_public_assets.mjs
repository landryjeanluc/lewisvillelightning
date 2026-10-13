/** Fail the build if child names or media paths enter unauthenticated bundles. */
import { readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const roster = JSON.parse(await readFile(path.join(root, 'data/roster.json'), 'utf8'));
const dist = path.join(root, 'site/dist');
// Astro copies public/ verbatim. Privacy opt-out must remove the bytes too.
if (!roster.privacy.publishPhotos) {
  for (const dir of ['photos', 'team']) await rm(path.join(dist, dir), {recursive:true, force:true});
}
const needles = roster.players.map(p => `${p.firstName} ${p.lastName}`);
for (const filename of await readdir(path.join(dist, '_astro'))) {
  if (!/\.(js|css|json|map)$/.test(filename)) continue;
  const content = await readFile(path.join(dist, '_astro', filename), 'utf8');
  if (needles.some(name => content.includes(name)) || /assets\/photos\//.test(content))
    throw new Error(`Private roster data found in public bundle ${filename}`);
}
console.log('Public bundles contain no full player names or private asset paths.');
