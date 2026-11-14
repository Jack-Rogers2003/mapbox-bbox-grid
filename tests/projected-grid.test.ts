import proj4 from "proj4";
import { assert, test } from "vitest";
import {
  createProjectedGrid,
  createProjectedGridFromBounds,
  GridError,
  projectedCellAt,
} from "../src/index";

test("creates a 500 metre grid over a UK-Denmark-sized bbox in UTM zone 30", () => {
  const grid = createProjectedGrid([-8.65, 49.8, 15, 60.9], {
    resolution: 500,
    crs: "EPSG:32630",
  });

  assert.ok(grid.features.length > 0);
  assert.ok(grid.features.length <= 10_000);
  assert.ok(grid.features.every((feature) => feature.geometry.coordinates.length >= 2));
  assert.ok(
    grid.features.every(
      (feature) => feature.properties.axis === "x" || feature.properties.axis === "y",
    ),
  );
  const vertical = grid.features.find((feature) => feature.properties.axis === "x");
  assert.ok(vertical);
  assert.ok(grid.features.some((feature) => feature.properties.axis === "y"));
  const projection = proj4("EPSG:4326", "EPSG:32630");
  const expectedX = Number(vertical.properties.index) * 500;
  for (const coordinate of vertical.geometry.coordinates) {
    assert.ok(Math.abs(projection.forward(coordinate)[0] - expectedX) < 0.001);
  }
});

test("generates the supplied 200 metre EPSG:32630 UK-Denmark grid within the default limit", () => {
  const resolution = 200;
  const crs = "EPSG:32630";
  const grid = createProjectedGrid([-3.341, 50.232, 15.739, 59.085], {
    resolution,
    crs,
  });
  const projection = proj4("EPSG:4326", crs);

  assert.equal(grid.features.length, 12_462);
  for (const feature of grid.features) {
    const coordinate = projection.forward(feature.geometry.coordinates[0]);
    const axisValue = feature.properties.axis === "x" ? coordinate[0] : coordinate[1];
    assert.ok(
      Math.abs(axisValue - Number(feature.properties.index) * resolution) < 0.00001,
      `${feature.properties.axis} grid line ${feature.properties.index} is not aligned`,
    );
  }
});

test("aligns a UK grid to 500 metre British National Grid coordinates", () => {
  const crs =
    "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +datum=OSGB36 +units=m +no_defs";
  const grid = createProjectedGrid([-8.65, 49.86, 1.77, 60.86], {
    resolution: 500,
    crs,
    maxSegmentLength: 20_000,
  });
  const projection = proj4("EPSG:4326", crs);

  assert.ok(grid.features.length > 0);
  for (const feature of grid.features) {
    const projected = projection.forward(feature.geometry.coordinates[0]);
    const coordinate = feature.properties.axis === "x" ? projected[0] : projected[1];
    assert.ok(
      Math.abs(coordinate - Number(feature.properties.index) * 500) < 0.01,
      `${feature.properties.axis} grid line ${feature.properties.index} is not aligned`,
    );
  }
});

test("creates exact lines from bounds already expressed in the chart CRS", () => {
  const crs =
    "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +datum=OSGB36 +units=m +no_defs";
  const grid = createProjectedGridFromBounds([-1000, 0, 1000, 2000], {
    resolution: 500,
    crs,
  });
  const projection = proj4("EPSG:4326", crs);

  assert.equal(grid.features.length, 10);
  for (const feature of grid.features) {
    const projected = projection.forward(feature.geometry.coordinates[0]);
    const coordinate = feature.properties.axis === "x" ? projected[0] : projected[1];
    assert.ok(
      Math.abs(coordinate - Number(feature.properties.index) * 500) < 0.01,
      `${feature.properties.axis} grid line ${feature.properties.index} is not aligned`,
    );
  }
});

test("uses a projected CRS's native linear units for chart bounds and resolution", () => {
  const definition =
    "+proj=tmerc +lat_0=40 +lon_0=-100 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=us-ft +no_defs";
  const crs = "TEST:US_FT";
  proj4.defs(crs, definition);
  const grid = createProjectedGridFromBounds([0, 0, 1000, 1000], {
    resolution: 100,
    crs,
  });

  assert.equal(grid.features.length, 22);
  assert.equal(grid.features[0].properties.index, 0);
  const point = proj4("EPSG:4326", crs).inverse([150, 250]) as [number, number];
  assert.deepEqual(projectedCellAt(point, { resolution: 100, crs }), { col: 1, row: 2 });
});

test("creates a 20 metre grid over Andorra in UTM zone 31 and identifies cells", () => {
  const bbox = [1.4, 42.43, 1.79, 42.66] as const;
  const options = { resolution: 20, crs: "EPSG:32631" };
  const grid = createProjectedGrid(bbox, options);
  const point: [number, number] = [1.5, 42.5];
  const index = projectedCellAt(point, options);
  const projected = proj4("EPSG:4326", options.crs).forward(point);

  assert.ok(grid.features.length > 0);
  assert.ok(grid.features.length <= 10_000);
  assert.ok(Number.isInteger(index.col));
  assert.ok(Number.isInteger(index.row));
  assert.equal(index.col, Math.floor(projected[0] / options.resolution));
  assert.equal(index.row, Math.floor(projected[1] / options.resolution));
});

test("projected grids share a fixed origin across bbox extents", () => {
  const first = createProjectedGrid([1.4, 42.43, 1.5, 42.5], {
    resolution: 20,
    crs: "EPSG:32631",
  });
  const second = createProjectedGrid([1.45, 42.45, 1.6, 42.55], {
    resolution: 20,
    crs: "EPSG:32631",
  });
  const sharedXIndices = new Set(
    first.features
      .filter((feature) => feature.properties.axis === "x")
      .map((feature) => feature.properties.index),
  );
  assert.ok(
    second.features.some(
      (feature) => feature.properties.axis === "x" && sharedXIndices.has(feature.properties.index),
    ),
  );
});

test("supports a custom origin for grid alignment", () => {
  const options = { resolution: 20, crs: "EPSG:32631", origin: [100, 200] as const };
  const point: [number, number] = [1.5, 42.5];
  const projected = proj4("EPSG:4326", options.crs).forward(point);
  const index = projectedCellAt(point, options);

  assert.equal(index.col, Math.floor((projected[0] - options.origin[0]) / options.resolution));
  assert.equal(index.row, Math.floor((projected[1] - options.origin[1]) / options.resolution));
});

test("assigns points on grid boundaries to the positive-side cell", () => {
  const projection = proj4("EPSG:4326", "EPSG:32631");
  const onBoundary = projection.inverse([200_000, 4_700_000]) as [number, number];

  assert.deepEqual(projectedCellAt(onBoundary, { resolution: 20, crs: "EPSG:32631" }), {
    col: 10_000,
    row: 235_000,
  });
});

test("rejects geographic CRSs even when the definition claims metre units", () => {
  assert.throws(
    () =>
      createProjectedGrid([1.4, 42.43, 1.79, 42.66], {
        resolution: 20,
        crs: "+proj=longlat +datum=WGS84 +units=m",
      }),
    GridError,
  );
});
