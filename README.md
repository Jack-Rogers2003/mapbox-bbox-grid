# mapbox-bbox-grid

Give it a bounding box and a resolution; it builds GeoJSON **LineStrings** for the grid cells and draws them on a **Mapbox GL JS** map. TypeScript, ESM + CommonJS. `proj4` is a runtime dependency for projected grids; Mapbox GL JS is an optional peer dependency.

```bash
pnpm add mapbox-bbox-grid     # or: npm install / yarn add
# mapbox-gl is an optional peer dependency: you already have it if you use Mapbox
```

## Draw a grid on your map

```ts
import mapboxgl from "mapbox-gl";
import { addBBoxGrid } from "mapbox-bbox-grid";

const map = new mapboxgl.Map({ container: "map", accessToken: "pk.YOUR_TOKEN" });

const grid = addBBoxGrid(map, {
  bbox: [-2.7, 51.4, -2.5, 51.5], // [west, south, east, north]
  resolution: 2,
  units: "kilometres",
  viewport: true, // only draw what's on screen (see Performance)
  fit: true, // zoom the map to the bbox
  paint: { "line-color": "#0077ff" }, // any Mapbox line paint props
});

grid.update({ resolution: 1 }); // redraw
grid.remove(); // remove layer, source and listeners
```

Safe to call before the map's style has loaded; it waits for `load`.

## Just the GeoJSON

```ts
import { createGrid, BBoxGrid } from "mapbox-bbox-grid";
import {
  addProjectedGrid,
  createProjectedGrid,
  createProjectedGridFromBounds,
  projectedCellAt,
} from "mapbox-bbox-grid";

createGrid([-2.7, 51.4, -2.5, 51.5], { resolution: 0.05 }); // one LineString per grid line
createGrid([-2.7, 51.4, -2.5, 51.5], { resolution: 0.05, mode: "cells" }); // one closed ring per cell, with row/col
const projected = createProjectedGrid([1.4, 42.43, 1.79, 42.66], {
  resolution: 20,
  crs: "EPSG:32631",
}); // WGS84 bbox in, projected grid aligned to CRS origin, WGS84 GeoJSON out
const chartGrid = createProjectedGridFromBounds([400000, 100000, 500000, 200000], {
  resolution: 500,
  crs: "EPSG:32631",
  origin: [0, 0],
}); // bounds, resolution and origin are in the chart CRS
projectedCellAt([1.5, 42.5], { resolution: 20, crs: "EPSG:32631" }); // { col, row }

const g = new BBoxGrid([-2.7, 51.4, -2.5, 51.5], { cells: [20, 10] });
g.cols;
g.rows;
g.xs;
g.ys;
g.linesInView([-2.6, 51.42, -2.55, 51.45]); // only the lines in a given view
```

## Draw a chart-CRS grid on the map

When the chart provides its bbox in its own projected CRS, use `addProjectedGrid`. Grid spacing and
alignment are calculated in that CRS before the lines are transformed to WGS84 GeoJSON for Mapbox
or MapLibre rendering:

```ts
const grid = addProjectedGrid(
  map,
  [400000, 100000, 500000, 200000], // [minX, minY, maxX, maxY] in chart CRS coordinates
  {
    crs: "EPSG:32631",
    resolution: 500, // native CRS units (metres for EPSG:32631)
    origin: [0, 0], // use the chart's actual grid origin
    maxSegmentLength: 20_000,
  },
);

grid.remove();
```

For a custom CRS, register its Proj4 definition before calling the API, or pass the definition
string as `crs`. `proj4` is an external runtime dependency so CRS definitions and grid-shift files
registered through Proj4js are available to the library:

```ts
import proj4 from "proj4";

proj4.defs("CHART:LOCAL", "+proj=... +units=m +no_defs");
const grid = addProjectedGrid(map, chartBounds, {
  crs: "CHART:LOCAL",
  resolution: 500,
});
```

CRS bounds must be projected and use supported linear units. Datum-transformation accuracy depends
on the selected CRS definition and available transformation grids; the library does not
automatically download CRS databases or datum grids. Mapbox/MapLibre renders the result in Web
Mercator, so a grid may look curved on screen even though it is straight and aligned in the chart
CRS.

## Options

| Option                                     | Meaning                                                                                                                                                     |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bbox`                                     | `[west, south, east, north]` in degrees                                                                                                                     |
| `resolution`                               | cell size: `number` or `[x, y]`                                                                                                                             |
| `units`                                    | `"degrees"` (default), `"metres"`, `"kilometres"`; US spellings `"meters"` and `"kilometers"` are also accepted                                             |
| `geodesic`                                 | `true` (default for metric resolutions): use a WGS84 ellipsoid approximation for metric-to-degree conversion; `false` keeps the legacy flat-Earth behaviour |
| `cells`                                    | instead of `resolution`: `[cols, rows]` or one number                                                                                                       |
| `mode`                                     | `"lines"` (default, efficient) or `"cells"` (per-cell properties)                                                                                           |
| `viewport`                                 | `true` or `{ padding, maxLines }`: draw only the visible area, thinned when zoomed out                                                                      |
| `id`, `paint`, `layout`, `beforeId`, `fit` | layer id, styling, layer order, fit-to-bbox                                                                                                                 |
| `maxCells`                                 | optional safety limit on cell count for full-grid output; unset by default and not applied in viewport mode                                                  |

TypeScript callers must specify exactly one of `resolution` or `cells`. The bounding box is a four-number tuple, and viewport mode cannot be combined with cell mode. Runtime validation remains for invalid numeric values and untyped JavaScript callers.

`createGrid` and `addBBoxGrid` create longitude/latitude grids; their metric `units` option converts metres at the bbox's centre latitude and is only an approximation. For a WGS84 geographic bbox with a projected grid, use `createProjectedGrid`. For chart bounds already expressed in the chart CRS, use `createProjectedGridFromBounds` or `addProjectedGrid`, with bounds ordered `[minX, minY, maxX, maxY]`. These chart-bounds APIs align to resolution multiples in the CRS's native linear units, from `[0, 0]` by default; provide the chart's `origin` if it differs. Line features include `axis` and integer `index` properties. Use `projectedCellAt` with the same CRS, resolution and origin to look up a point's `{ col, row }`; points exactly on a grid line belong to the positive x/y side. Output coordinates are transformed back to WGS84 for Mapbox GeoJSON.

## Performance

- Use `mode: "lines"` (the default) for visuals. It creates one feature per grid line instead of one per cell.
- For large areas or fine resolutions turn on `viewport: true`. It finds visible line indices directly from the grid steps, without creating or retaining tick arrays for the full bbox. Only visible lines (plus padding) are generated; after a pan/zoom, the source is updated on `moveend`. When more than `maxLines` (default 1000) would be visible, every n-th line is drawn instead. Lines stay on the real grid and never shift while panning. This works with `lines` mode only.
- In viewport mode, memory and GeoJSON work are proportional to the displayed lines rather than the total grid size. `maxLines` is a target; bbox border lines can add a small number beyond it.
- The grid dimensions (`cols`, `rows`, `cellCount`) are inexpensive to read. Accessing `xs`/`ys`, or requesting full output with `lines()`, `cells()`, `createGrid()` or `toGeoJSON()`, materializes or returns the entire grid. Those APIs can use substantial time and memory for fine resolutions or large extents. Use viewport mode for map display and set `maxCells` when producing full-grid output.
- Cell mode creates one feature per cell with duplicated shared edges, so avoid it for large grids unless per-cell properties are needed. A `maxCells` limit applies to full-grid generation, not viewport rendering.
- `addProjectedGrid` draws the full chart grid; it does not viewport-filter or thin lines. Its `maxLines` limit defaults to 15,000. Large areas at fine resolutions can create large GeoJSON sources and may be slow on low-spec devices.
- Default line width and opacity fade with zoom so far-out views stay light.

## Notes

For `createGrid` and `addBBoxGrid`, metric sizes are converted to degrees at the bbox's centre latitude using a WGS84 ellipsoid approximation when `geodesic` is enabled (the default for metric resolutions), so cells are only exactly square on the ground there. Set `geodesic: false` to keep the legacy flat-Earth approximation. Projected chart grids instead use exact resolution multiples in the supplied CRS; their geographic rendering accuracy depends on the CRS's datum transformation. If a bbox isn't an exact multiple of the resolution, its outer extent can clip the last cell. Geographic boxes crossing the antimeridian aren't supported; split them in two.

Projected grids use the selected CRS's alignment, not Mapbox's display projection. `createProjectedGrid` accepts a WGS84 bbox and uses a metre-based grid CRS. `createProjectedGridFromBounds` and `addProjectedGrid` accept chart bounds already in the projected CRS; their resolution and origin use that CRS's native linear units. Choose the exact CRS and datum operation used by the chart. The library does not provide a global EPSG database or automatically fetch datum-shift grids: register custom definitions and any required grids with Proj4js. A CRS only has meaningful accuracy in its intended area, and no single projected CRS is distortion-free worldwide.

## Development

```bash
pnpm install
pnpm check     # typecheck (tsc strict) + lint (Biome) + JSDoc check + tests
pnpm test      # run tests with Vitest
pnpm lint:fix  # auto-format and fix lint issues
pnpm build
```

## Local playground

The ignored `playground/` folder is for local demos and generated data. With Bash and pnpm installed, run this from the project root:

```bash
bash scripts/playground.sh
```

The script builds the package, writes `playground/generated/grid.geojson`, and starts a server. The demo uses a 500 m grid aligned to British National Grid (EPSG:27700) coordinates, converted to WGS84 GeoJSON for display. Open `http://localhost:8000/playground/demo.html`; stop the server with Ctrl+C. The demo uses MapLibre and OpenFreeMap, so it does not need a Mapbox token. The playground and generated GeoJSON are intentionally not included in version control.

MIT licence.
