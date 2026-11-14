import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createProjectedGrid } from "../src/index";

const grid = createProjectedGrid([-8.65, 49.86, 1.77, 60.86], {
  resolution: 500,
  crs: "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +datum=OSGB36 +units=m +no_defs",
  maxSegmentLength: 20_000,
});

const outputPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../playground/generated/grid.geojson",
);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(grid));
console.log(`wrote ${outputPath} (${grid.features.length} lines)`);
