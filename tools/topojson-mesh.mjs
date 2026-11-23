#!/usr/bin/env node
/**
 * topojson-mesh.mjs — export the shared-border mesh of a world-atlas TopoJSON
 * object as GeoJSON (LineString features) for the Python map-art builder.
 *
 * Usage: node tools/topojson-mesh.mjs <topojson> <object> <out.geojson>
 *   node tools/topojson-mesh.mjs node_modules/world-atlas/countries-50m.json countries .tmp/ne/countries-50m-mesh.geojson
 *
 * Mesh(a, b) keeps only arcs shared by two different features with both
 * sides defined, so coastlines are excluded (no duplicates).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { mesh } from 'topojson-client';

const [, , topoPath, objectName, outPath] = process.argv;
if (!topoPath || !objectName || !outPath) {
  console.error('usage: node tools/topojson-mesh.mjs <topojson> <object> <out.geojson>');
  process.exit(2);
}
const topo = JSON.parse(readFileSync(topoPath, 'utf8'));
const object = topo.objects[objectName];
if (!object) throw new Error(`object "${objectName}" not found in ${topoPath}`);
const line = mesh(topo, object, (a, b) => a !== undefined && b !== undefined && a !== b);
const features = [];
const pushLine = (coords) => features.push({
  type: 'Feature',
  properties: {},
  geometry: { type: 'LineString', coordinates: coords },
});
const visit = (coords) => {
  if (!Array.isArray(coords) || coords.length === 0) return;
  if (Array.isArray(coords[0]) && typeof coords[0][0] === 'number') pushLine(coords);
  else for (const c of coords) visit(c);
};
visit(line.coordinates);
writeFileSync(outPath, JSON.stringify({ type: 'FeatureCollection', features }));
console.log(`mesh: ${features.length} lines -> ${outPath}`);