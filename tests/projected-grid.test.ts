import proj4 from "proj4";
import { assert, test } from "vitest";
import {
  createProjectedGrid,
  createProjectedGridFromBounds,
  fromGeoTransform,
  GridError,
  type LineFeature,
  projectedCellAt,
} from "../src/index";

/** Get the coordinate components of one projected grid feature. */
function segmentsOf(feature: LineFeature): [number, number][][] {
  return feature.geometry.type === "MultiLineString"
    ? feature.geometry.coordinates
    : [feature.geometry.coordinates];
}

/** Grid-line indices parallel to a grouped feature's coordinate components. */
function indicesOf(feature: { properties: Record<string, unknown> }): number[] {
  const indices = feature.properties.indices;
  return Array.isArray(indices) ? (indices as number[]) : [];
}

test("creates a 500 metre grid over a UK-Denmark-sized bbox in UTM zone 30", () => {
  const grid = createProjectedGrid([-8.65, 49.8, 15, 60.9], {
    resolution: 500,
    crs: "EPSG:32630",
  });

  assert.ok(grid.features.length > 0);
  assert.equal(grid.features.length, 2);
  assert.ok(
    grid.features.every((feature) => segmentsOf(feature).every((segment) => segment.length >= 2)),
  );
  assert.ok(
    grid.features.every(
      (feature) => feature.properties.axis === "x" || feature.properties.axis === "y",
    ),
  );
  const vertical = grid.features.find((feature) => feature.properties.axis === "x");
  assert.ok(vertical);
  assert.ok(grid.features.some((feature) => feature.properties.axis === "y"));
  const projection = proj4("EPSG:4326", "EPSG:32630");
  for (const [component, index] of segmentsOf(vertical).map(
    (segment, i) => [segment, indicesOf(vertical)[i]] as const,
  )) {
    const expectedX = index * 500;
    for (const coordinate of component) {
      assert.ok(Math.abs(projection.forward(coordinate)[0] - expectedX) < 0.001);
    }
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

  assert.equal(grid.features.length, 2);
  assert.equal(
    grid.features.reduce((count, feature) => count + indicesOf(feature).length, 0),
    12_462,
  );
  for (const feature of grid.features) {
    segmentsOf(feature).forEach((segment, i) => {
      const coordinate = projection.forward(segment[0]);
      const axisValue = feature.properties.axis === "x" ? coordinate[0] : coordinate[1];
      const index = indicesOf(feature)[i];
      assert.ok(
        Math.abs(axisValue - index * resolution) < 0.00001,
        `${feature.properties.axis} grid line ${index} is not aligned`,
      );
    });
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
    segmentsOf(feature).forEach((segment, i) => {
      const projected = projection.forward(segment[0]);
      const coordinate = feature.properties.axis === "x" ? projected[0] : projected[1];
      const index = indicesOf(feature)[i];
      assert.ok(
        Math.abs(coordinate - index * 500) < 0.01,
        `${feature.properties.axis} grid line ${index} is not aligned`,
      );
    });
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

  assert.equal(grid.features.length, 2);
  for (const feature of grid.features) {
    segmentsOf(feature).forEach((segment, i) => {
      const projected = projection.forward(segment[0]);
      const coordinate = feature.properties.axis === "x" ? projected[0] : projected[1];
      const index = indicesOf(feature)[i];
      assert.ok(
        Math.abs(coordinate - index * 500) < 0.01,
        `${feature.properties.axis} grid line ${index} is not aligned`,
      );
    });
  }
});

test("keeps projected lines aligned to a non-zero grid origin", () => {
  const crs = "EPSG:3857";
  const origin = [5, 15] as const;
  const resolution = 20;
  const grid = createProjectedGridFromBounds([-5, -5, 65, 65], {
    resolution,
    crs,
    origin,
  });
  const projection = proj4("EPSG:4326", crs);

  for (const feature of grid.features) {
    segmentsOf(feature).forEach((segment, i) => {
      const projected = projection.forward(segment[0]);
      const axisPosition = feature.properties.axis === "x" ? projected[0] : projected[1];
      const axisOrigin = feature.properties.axis === "x" ? origin[0] : origin[1];
      const index = indicesOf(feature)[i];
      assert.ok(Math.abs(axisPosition - (axisOrigin + index * resolution)) < 0.001);
    });
  }
});

test("does not densify default EPSG:3857 grid lines", () => {
  const grid = createProjectedGridFromBounds([-100_000, -100_000, 100_000, 100_000], {
    resolution: 50_000,
    crs: "EPSG:3857",
  });

  assert.ok(
    grid.features.every(
      (feature) =>
        feature.geometry.type === "MultiLineString" &&
        feature.geometry.coordinates.every((segment) => segment.length === 2),
    ),
  );
});

test("full projected grids are no longer rejected at the former 15,000-line default", () => {
  const grid = createProjectedGridFromBounds([-8000, -8000, 8000, 8000], {
    resolution: 1,
    crs: "EPSG:3857",
  });

  assert.equal(grid.features.length, 2);
  assert.equal(
    grid.features.reduce((count, feature) => count + indicesOf(feature).length, 0),
    32_002,
  );
});

test("converts north-up GDAL transforms and rejects rotated transforms", () => {
  assert.deepEqual(fromGeoTransform([-1000, 200, 0, 2000, 0, -500], [4, 10]), {
    bounds: [-1000, 0, 1000, 2000],
    origin: [-1000, 2000],
    resolution: [200, 500],
  });
  assert.throws(() => fromGeoTransform([0, 1, 0.1, 0, 0, -1], [1, 1]), GridError);
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

  assert.equal(grid.features.length, 2);
  assert.ok(indicesOf(grid.features[0]).includes(0));
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
    first.features.filter((feature) => feature.properties.axis === "x").flatMap(indicesOf),
  );
  assert.ok(
    second.features.some(
      (feature) =>
        feature.properties.axis === "x" &&
        indicesOf(feature).some((index) => sharedXIndices.has(index)),
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
