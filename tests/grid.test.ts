import { assert, test } from "vitest";
import type { BBox, GridOptions, GridUpdateOptions, MapLike } from "../src/index";
import { addBBoxGrid, BBoxGrid, createGrid, GridError } from "../src/index";

function verifyOptionTypes(map: MapLike, bbox: BBox): void {
  new BBoxGrid(bbox, { resolution: 0.25 });
  new BBoxGrid(bbox, { resolution: [0.25, 0.5] as const });
  new BBoxGrid(bbox, { cells: [4, 4] });
  new BBoxGrid(bbox, { cells: [4, 8] as const });
  addBBoxGrid(map, { bbox, resolution: 0.25 });
  createGrid(bbox, { cells: 4, mode: "cells" });
  const validUpdate: GridUpdateOptions = { cells: 4, bbox };
  void validUpdate;

  // @ts-expect-error A bounding box must contain four coordinates.
  new BBoxGrid([0, 0, 1], { resolution: 0.25 });
  // @ts-expect-error A grid requires either a resolution or a cell count.
  new BBoxGrid(bbox, {});
  // @ts-expect-error Resolution and cell count cannot be specified together.
  new BBoxGrid(bbox, { resolution: 0.25, cells: 4 });
  // @ts-expect-error Viewport rendering is only supported for line grids.
  addBBoxGrid(map, { bbox, cells: 4, viewport: true });
  // @ts-expect-error Cell grids cannot use viewport rendering.
  addBBoxGrid(map, {
    bbox,
    resolution: 0.25,
    mode: "cells",
    viewport: true,
  });
  // @ts-expect-error An update cannot set both grid shape alternatives.
  const invalidUpdate: GridUpdateOptions = { cells: 4, resolution: 0.25 };
  void invalidUpdate;
}
void verifyOptionTypes;

test("exact division in degrees", () => {
  const grid = new BBoxGrid([0, 0, 1, 1], { resolution: 0.25 });
  assert.equal(grid.cols, 4);
  assert.equal(grid.rows, 4);
  assert.deepEqual(grid.xs, [0, 0.25, 0.5, 0.75, 1]);
});

test("float noise does not add an extra cell", () => {
  assert.equal(new BBoxGrid([0, 0, 0.3, 0.3], { resolution: 0.1 }).cols, 3);
  assert.equal(new BBoxGrid([0, 0, 0.7, 0.7], { resolution: 0.1 }).rows, 7);
});

test("last cell is clipped to the bbox", () => {
  const grid = new BBoxGrid([0, 0, 1, 1], { resolution: 0.3 });
  assert.equal(grid.cols, 4);
  assert.deepEqual(grid.xs.slice(-2), [0.9, 1]);
});

test("lines: count and geometry", () => {
  const fc = new BBoxGrid([0, 0, 1, 1], { resolution: 0.5 }).lines();
  assert.equal(fc.features.length, 6);
  assert.ok(fc.features.every((f) => f.geometry.type === "LineString"));
  JSON.stringify(fc);
});

test("cells: closed rings with row/col", () => {
  const fc = new BBoxGrid([0, 0, 1, 1], { resolution: 0.5 }).cells();
  assert.equal(fc.features.length, 4);
  for (const f of fc.features) {
    const ring = f.geometry.coordinates;
    assert.deepEqual(ring[0], ring[ring.length - 1]);
    assert.equal(ring.length, 5);
  }
  const rowCols = new Set(fc.features.map((f) => `${f.properties.row},${f.properties.col}`));
  assert.deepEqual(rowCols, new Set(["0,0", "0,1", "1,0", "1,1"]));
});

test("cells option", () => {
  const grid = new BBoxGrid([10, 50, 12, 51], { cells: [4, 2] });
  assert.equal(grid.cols, 4);
  assert.equal(grid.rows, 2);
});

test("cell-count limit is disabled by default and can be opted into", () => {
  const grid = new BBoxGrid([0, 0, 2, 2], { resolution: 0.001 });
  assert.equal(grid.cellCount, 4_000_000);
  assert.throws(
    () => new BBoxGrid([0, 0, 2, 2], { resolution: 0.001, maxCells: 1_000_000 }),
    GridError,
  );
});

test("metric resolution tracks Earth curvature at high latitude", () => {
  const equator = new BBoxGrid([0, -0.5, 1, 0.5], { resolution: 10_000, units: "metres" });
  const north = new BBoxGrid([0, 59.5, 1, 60.5], { resolution: 10_000, units: "metres" });
  assert.ok(north.xStep > equator.xStep * 1.9);
  assert.ok(Math.abs(equator.yStep - north.yStep) < 0.01);
  assert.ok(Math.abs(equator.yStep - north.yStep) > 0.0001);
});

test("legacy flat-earth mode remains available", () => {
  const equator = new BBoxGrid([0, -0.5, 1, 0.5], {
    resolution: 10_000,
    units: "metres",
    geodesic: false,
  });
  const north = new BBoxGrid([0, 59.5, 1, 60.5], {
    resolution: 10_000,
    units: "metres",
    geodesic: false,
  });
  assert.ok(Math.abs(equator.yStep - north.yStep) < 1e-9);
  assert.ok(north.xStep > equator.xStep * 1.9);
});

test("US spellings of metric units remain supported", () => {
  const grid = new BBoxGrid([0, 0, 1, 1], { resolution: 1, units: "kilometers" });
  assert.ok(grid.xStep > 0);
  assert.ok(grid.yStep > 0);
});

test("invalid input throws GridError", () => {
  const badBoxes: number[][] = [
    [1, 0, 0, 1],
    [0, 1, 1, 0],
    [0, 0, 181, 1],
    [0, -91, 1, 1],
    [0, 0, 1],
    [0, 0, Number.NaN, 1],
  ];
  for (const box of badBoxes) {
    assert.throws(() => new BBoxGrid(box as unknown as BBox, { resolution: 0.1 }), GridError);
  }
  assert.throws(() => new BBoxGrid([0, 0, 1, 1], { resolution: 0 }), GridError);
  assert.throws(
    () => new BBoxGrid([0, 0, 1, 1], { resolution: 1e-6, maxCells: 1_000_000 }),
    GridError,
  );
  assert.throws(() => new BBoxGrid([0, 0, 1, 1], {} as GridOptions), GridError);
  assert.throws(
    () => new BBoxGrid([0, 0, 1, 1], { resolution: 1, cells: 2 } as unknown as GridOptions),
    GridError,
  );
});

test("createGrid shortcut", () => {
  const fc = createGrid([0, 0, 1, 1], { resolution: 0.5, mode: "cells" });
  assert.equal(fc.features.length, 4);
});
