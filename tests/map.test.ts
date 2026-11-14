import { assert, test } from "vitest";
import type { AddGridOptions, BBox, LineFeatureCollection, MapLike } from "../src/index";
import { addBBoxGrid, addProjectedGrid, GridError } from "../src/index";

/** A GeoJSON source recorded by the fake map. */
interface FakeSource {
  data: LineFeatureCollection;
  setData(data: LineFeatureCollection): void;
}

/**
 * Create a minimal stand-in for `mapboxgl.Map` that records what the plugin does.
 * @param options - Initial style-loaded flag and visible bounds.
 */
function createFakeMap(options: { styleLoaded?: boolean; bounds?: BBox } = {}) {
  const sources = new Map<string, FakeSource>();
  const layers = new Map<string, Record<string, unknown>>();
  const moveEndListeners = new Set<() => void>();
  const log: string[] = [];
  let loadListener: (() => void) | undefined;
  let bounds: BBox = options.bounds ?? [-180, -90, 180, 90];

  const map: MapLike = {
    addSource(id, source) {
      log.push("addSource");
      sources.set(id, {
        data: source.data,
        setData(data) {
          log.push("setData");
          this.data = data;
        },
      });
    },
    getSource: (id) => sources.get(id),
    removeSource(id) {
      log.push("removeSource");
      sources.delete(id);
    },
    addLayer(layer) {
      log.push("addLayer");
      layers.set(String(layer.id), layer);
    },
    getLayer: (id) => layers.get(id),
    removeLayer(id) {
      log.push("removeLayer");
      layers.delete(id);
    },
    setPaintProperty(_layerId, name) {
      log.push(`setPaintProperty ${name}`);
    },
    setLayoutProperty(_layerId, name) {
      log.push(`setLayoutProperty ${name}`);
    },
    isStyleLoaded: () => options.styleLoaded ?? true,
    once(_type, listener) {
      loadListener = listener;
    },
    on(_type, listener) {
      moveEndListeners.add(listener);
    },
    off(_type, listener) {
      moveEndListeners.delete(listener);
    },
    getBounds: () => ({
      getWest: () => bounds[0],
      getSouth: () => bounds[1],
      getEast: () => bounds[2],
      getNorth: () => bounds[3],
    }),
    fitBounds(b, o) {
      log.push(`fitBounds ${JSON.stringify(b)} ${JSON.stringify(o)}`);
    },
  };

  return {
    map,
    sources,
    layers,
    log,
    moveEndListeners,
    fireLoad: () => loadListener?.(),
    moveTo(next: BBox) {
      bounds = next;
      for (const listener of [...moveEndListeners]) {
        listener();
      }
    },
  };
}

/**
 * Read the data currently held by a fake source.
 * @param fake - The fake map.
 * @param id - Source id.
 */
function dataOf(fake: ReturnType<typeof createFakeMap>, id = "bboxgrid"): LineFeatureCollection {
  const source = fake.sources.get(id);
  if (!source) {
    throw new Error(`no source ${id}`);
  }
  return source.data;
}

test("adds a source and a line layer immediately when the style is loaded", () => {
  const fake = createFakeMap();
  addBBoxGrid(fake.map, { bbox: [0, 0, 1, 1], resolution: 0.5, paint: { "line-color": "#000" } });
  assert.deepEqual(fake.log, ["addSource", "addLayer"]);
  const layer = fake.layers.get("bboxgrid");
  if (!layer) {
    throw new Error("layer missing");
  }
  const paint = layer.paint as Record<string, unknown>;
  assert.equal(layer.type, "line");
  assert.equal(paint["line-color"], "#000");
  assert.ok("line-width" in paint, "default paint kept");
});

test("waits for load when the style is not ready", () => {
  const fake = createFakeMap({ styleLoaded: false });
  addBBoxGrid(fake.map, { bbox: [0, 0, 1, 1], resolution: 0.5 });
  assert.deepEqual(fake.log, []);
  fake.fireLoad();
  assert.deepEqual(fake.log, ["addSource", "addLayer"]);
});

test("update reuses the source and swaps resolution for cells", () => {
  const fake = createFakeMap();
  const handle = addBBoxGrid(fake.map, { bbox: [0, 0, 1, 1], resolution: 0.5 });
  handle.update({ cells: [4, 4] });
  assert.equal(handle.grid.cols, 4);
  assert.deepEqual(fake.log, ["addSource", "addLayer", "setData"]);
  assert.equal(dataOf(fake).features.length, 10);
});

test("a bad update throws and leaves the map untouched", () => {
  const fake = createFakeMap();
  const handle = addBBoxGrid(fake.map, { bbox: [0, 0, 1, 1], resolution: 0.5 });
  assert.throws(() => handle.update({ resolution: -1 }), GridError);
  assert.equal(handle.grid.cols, 2);
  assert.deepEqual(fake.log, ["addSource", "addLayer"]);
});

test("update with paint restyles the existing layer", () => {
  const fake = createFakeMap();
  const handle = addBBoxGrid(fake.map, { bbox: [0, 0, 1, 1], resolution: 0.5 });
  handle.update({ paint: { "line-color": "#00f" } });
  assert.ok(fake.log.includes("setPaintProperty line-color"));
});

test("remove deletes layer and source; later updates draw nothing", () => {
  const fake = createFakeMap();
  const handle = addBBoxGrid(fake.map, { bbox: [0, 0, 1, 1], resolution: 0.5 });
  handle.remove();
  assert.equal(fake.layers.size + fake.sources.size, 0);
  handle.update({ resolution: 0.25 });
  assert.equal(fake.layers.size + fake.sources.size, 0);
});

test("fit: true calls fitBounds with padding", () => {
  const fake = createFakeMap();
  addBBoxGrid(fake.map, { bbox: [0, 1, 2, 3], resolution: 1, fit: true });
  assert.ok(fake.log.includes('fitBounds [[0,1],[2,3]] {"padding":40}'));
});

test("invalid options throw before touching the map", () => {
  const fake = createFakeMap();
  assert.throws(
    () => addBBoxGrid(fake.map, { bbox: [0, 0, 1, 1] } as unknown as AddGridOptions),
    GridError,
  );
  assert.deepEqual(fake.log, []);
});

test("viewport mode draws only the visible lines and follows the camera", () => {
  const fake = createFakeMap({ bounds: [1, 1, 3, 3] });
  const handle = addBBoxGrid(fake.map, {
    bbox: [0, 0, 80, 80],
    resolution: 1,
    viewport: { padding: 0 },
  });
  const first = dataOf(fake).features.length;
  assert.ok(first > 0 && first < 20, `expected a handful of lines, got ${first}`);

  fake.moveTo([50, 50, 60, 60]);
  const second = dataOf(fake);
  const xs = second.features
    .filter((f) => f.properties.axis === "x")
    .map((f) => f.geometry.coordinates[0][0]);
  assert.deepEqual(xs, [50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60]);

  handle.remove();
  assert.equal(fake.moveEndListeners.size, 0, "moveend listener removed");
});

test("viewport mode lifts the cell cap for lines", () => {
  const fake = createFakeMap({ bounds: [0, 0, 1, 1] });
  // 100 m cells over ~10 degrees is ~10 billion cells, far over the default cap.
  const handle = addBBoxGrid(fake.map, {
    bbox: [0, 0, 10, 10],
    resolution: 0.001,
    viewport: true,
  });
  assert.ok(handle.grid.cols > 5000);
  assert.ok(dataOf(fake).features.length <= 1000);
});

test("viewport mode rejects cells mode", () => {
  const fake = createFakeMap();
  assert.throws(
    () =>
      addBBoxGrid(fake.map, {
        bbox: [0, 0, 1, 1],
        resolution: 0.5,
        mode: "cells",
        viewport: true,
      } as unknown as AddGridOptions),
    GridError,
  );
  assert.deepEqual(fake.log, []);
});

test("adds and removes a projected grid aligned to chart-CRS bounds", () => {
  const fake = createFakeMap();
  const handle = addProjectedGrid(fake.map, [-1000, 0, 1000, 2000], {
    resolution: 500,
    crs: "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +datum=OSGB36 +units=m +no_defs",
  });

  assert.equal(dataOf(fake).features.length, 10);
  assert.deepEqual(fake.log, ["addSource", "addLayer"]);
  handle.remove();
  assert.equal(fake.layers.size + fake.sources.size, 0);
});
