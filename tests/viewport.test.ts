import { assert, test } from "vitest";
import type { LineFeatureCollection } from "../src/index";
import { BBoxGrid } from "../src/index";

/**
 * Collect the `index` property of every line on one axis.
 * @param fc - Collection to read.
 * @param axis - Which family of lines to read.
 */
function indices(fc: LineFeatureCollection, axis: "x" | "y"): number[] {
  return fc.features
    .filter((f) => f.properties.axis === axis)
    .map((f) => Number(f.properties.index));
}

test("only lines around the view are returned, clipped to the view", () => {
  const grid = new BBoxGrid([0, 0, 10, 10], { resolution: 1 });
  const fc = grid.linesInView([2.2, 2.2, 4.8, 4.8], { padding: 0 });
  assert.deepEqual(indices(fc, "x"), [2, 3, 4, 5]);
  assert.deepEqual(indices(fc, "y"), [2, 3, 4, 5]);
  const vertical = fc.features.find((f) => f.properties.axis === "x");
  assert.deepEqual(vertical?.geometry.coordinates, [
    [2, 2.2],
    [2, 4.8],
  ]);
});

test("padding widens the drawn area", () => {
  const grid = new BBoxGrid([0, 0, 10, 10], { resolution: 1 });
  const fc = grid.linesInView([4, 4, 6, 6]); // default padding 0.25 -> 3.5..6.5
  assert.deepEqual(indices(fc, "x"), [3, 4, 5, 6, 7]);
});

test("a view outside the bbox gives an empty collection", () => {
  const grid = new BBoxGrid([0, 0, 10, 10], { resolution: 1 });
  assert.equal(grid.linesInView([50, 50, 60, 60]).features.length, 0);
});

test("a view wrapping the antimeridian falls back to the full longitude range", () => {
  const grid = new BBoxGrid([0, 0, 10, 10], { resolution: 1 });
  const fc = grid.linesInView([170, 2, -170, 4], { padding: 0 });
  assert.equal(indices(fc, "x").length, 11);
});

test("too many visible lines are thinned to a stride, staying on the grid lattice", () => {
  const grid = new BBoxGrid([0, 0, 10, 10], { resolution: 0.01 });
  const fc = grid.linesInView([0, 0, 10, 10], { padding: 0, maxLines: 100 });
  assert.ok(fc.features.length <= 100);
  const stride = 21; // ceil(2002 / 100)
  const edge = grid.xs.length - 1;
  for (const i of indices(fc, "x")) {
    assert.ok(i % stride === 0 || i === edge, `unexpected line ${i}`);
  }
  assert.ok(indices(fc, "x").includes(edge), "border line is kept");
});

test("invalid viewport options throw", () => {
  const grid = new BBoxGrid([0, 0, 1, 1], { resolution: 0.5 });
  assert.throws(() => grid.linesInView([0, 0, 1, 1], { padding: -1 }));
  assert.throws(() => grid.linesInView([0, 0, 1, 1], { maxLines: 0 }));
});

test("viewport maxLines can be as low as one", () => {
  const grid = new BBoxGrid([0, 0, 1, 1], { resolution: 0.1 });
  const fc = grid.linesInView([0, 0, 1, 1], { padding: 0, maxLines: 1 });
  assert.ok(fc.features.length >= 1);
  assert.ok(fc.features.length <= 4, "only grid border lines may exceed the requested cap");
});

test("viewport grids do not materialize ticks for the full bbox", () => {
  const grid = new BBoxGrid([-180, -90, 180, 90], { resolution: 0.000001 });
  assert.equal(grid.cols, 360_000_000);
  assert.equal(grid.rows, 180_000_000);

  const fc = grid.linesInView([-0.000002, -0.000002, 0.000002, 0.000002], {
    padding: 0,
    maxLines: 20,
  });
  assert.equal(fc.features.length, 10);
  assert.deepEqual(
    indices(fc, "x"),
    [179_999_998, 179_999_999, 180_000_000, 180_000_001, 180_000_002],
  );
});
