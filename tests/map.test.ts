import { assert, test } from "vitest";
import type {
  AddGridOptions,
  BBox,
  LineFeatureCollection,
  MapLike,
  ProjectedGridWorkerMessageEvent,
  ProjectedGridWorkerScope,
} from "../src/index";
import {
  addBBoxGrid,
  addProjectedGrid,
  addTilePixelGrid,
  GridError,
  installProjectedGridWorker,
  type ProjectedGridWorker,
} from "../src/index";

/** A GeoJSON source recorded by the fake map. */
interface FakeSource {
  data: LineFeatureCollection;
  setData(data: LineFeatureCollection): void;
}

/**
 * Create a minimal stand-in for `mapboxgl.Map` that records what the plugin does.
 * @param options - Initial style-loaded flag and visible bounds.
 */
function createFakeMap(options: {
  styleLoaded?: boolean;
  bounds?: BBox;
  pixelsPerDegree?: number;
} = {}) {
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
    setLayerZoomRange(_layerId, minzoom, maxzoom) {
      log.push(`setLayerZoomRange ${minzoom} ${maxzoom}`);
    },
    setSlot(_layerId, slot) {
      log.push(`setSlot ${slot}`);
    },
    moveLayer(_id, beforeId) {
      log.push(`moveLayer ${beforeId}`);
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
    project: (coordinate) => {
      const scale = options.pixelsPerDegree ?? 1;
      return { x: coordinate[0] * scale, y: coordinate[1] * scale };
    },
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

/** Connect a fake main-thread Worker to the package's worker message handler. */
function createGridWorker(): ProjectedGridWorker {
  const workerListeners = new Set<(event: ProjectedGridWorkerMessageEvent) => void>();
  const scopeListeners = new Set<(event: ProjectedGridWorkerMessageEvent) => void>();
  const scope: ProjectedGridWorkerScope = {
    addEventListener(_type, listener) {
      scopeListeners.add(listener);
    },
    postMessage(message) {
      for (const listener of [...workerListeners]) {
        listener({ data: message });
      }
    },
  };
  installProjectedGridWorker(scope);
  return {
    postMessage(message) {
      for (const listener of [...scopeListeners]) {
        listener({ data: message });
      }
    },
    addEventListener(_type, listener) {
      workerListeners.add(listener);
    },
    removeEventListener(_type, listener) {
      workerListeners.delete(listener);
    },
  };
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

test("viewport minSpacingPx thins geographic lines by grid-index multiples", () => {
  const fake = createFakeMap({ bounds: [0, 0, 1, 1], pixelsPerDegree: 100 });
  addBBoxGrid(fake.map, {
    bbox: [0, 0, 1, 1],
    resolution: 0.01,
    viewport: { padding: 0, minSpacingPx: 4 },
  });

  const data = dataOf(fake);
  for (const axis of ["x", "y"]) {
    const indices = data.features
      .filter((feature) => feature.properties.axis === axis)
      .map((feature) => Number(feature.properties.index));
    assert.ok(indices.length < 30, `expected pixel thinning on ${axis}`);
    assert.ok(
      indices.slice(1, -1).every((index, position) => {
        return index - indices[position] >= 4;
      }),
    );
    assert.ok(indices.includes(0));
    assert.ok(indices.includes(100));
  }
});

test("projected viewport minSpacingPx thins MultiLineString components", () => {
  const fake = createFakeMap({ bounds: [-1, -1, 1, 1], pixelsPerDegree: 100 });
  addProjectedGrid(fake.map, [-100_000, -100_000, 100_000, 100_000], {
    crs: "EPSG:3857",
    resolution: 1000,
    viewport: { padding: 0, minSpacingPx: 4 },
  });

  const data = dataOf(fake);
  assert.ok(data.features.length > 0);
  for (const feature of data.features) {
    assert.equal(feature.geometry.type, "MultiLineString");
    const indices = feature.properties.indices as number[];
    assert.ok(indices.length < 100);
    assert.ok(
      indices.slice(1, -1).every((index, position) => {
        return index - indices[position] >= 4;
      }),
    );
  }
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

  assert.equal(dataOf(fake).features.length, 2);
  assert.deepEqual(fake.log, ["addSource", "addLayer"]);
  handle.remove();
  assert.equal(fake.layers.size + fake.sources.size, 0);
});

test("projected viewport grids thin on the origin-aligned lattice and skip unchanged views", () => {
  const fake = createFakeMap({ bounds: [-1, -1, 1, 1] });
  const handle = addProjectedGrid(fake.map, [-1_000_000, -1_000_000, 1_000_000, 1_000_000], {
    crs: "EPSG:3857",
    resolution: 1000,
    maxLines: 1,
    viewport: { padding: 0, maxLines: 10 },
  });
  const features = dataOf(fake).features;
  assert.ok(features.length <= 2);
  for (const feature of features) {
    const indices = feature.properties.indices as number[];
    assert.ok(indices.every((index) => index % 45 === 0));
    assert.ok(feature.geometry.type === "MultiLineString");
    if (feature.geometry.type === "MultiLineString") {
      assert.ok(feature.geometry.coordinates.every((segment) => segment.length === 2));
    }
  }

  const updateCount = fake.log.filter((entry) => entry === "setData").length;
  fake.moveTo([-1, -1, 1, 1]);
  assert.equal(fake.log.filter((entry) => entry === "setData").length, updateCount);
  fake.moveTo([10, 10, 12, 12]);
  assert.equal(fake.log.filter((entry) => entry === "setData").length, updateCount + 1);
  handle.remove();
});

test("projected grid handles show, hide and update layer settings in place", () => {
  const fake = createFakeMap();
  const handle = addProjectedGrid(fake.map, [-1000, -1000, 1000, 1000], {
    crs: "EPSG:3857",
    resolution: 500,
  });
  handle.hide();
  handle.show();
  handle.update({ paint: { "line-color": "#00f" }, minzoom: 2, maxzoom: 8, slot: "middle" });
  handle.update({ beforeId: "labels" });
  assert.ok(fake.log.includes("setLayoutProperty visibility"));
  assert.ok(fake.log.includes("setLayerZoomRange 2 8"));
  assert.ok(fake.log.includes("setSlot middle"));
  assert.ok(fake.log.includes("moveLayer labels"));
  assert.equal(fake.log.filter((entry) => entry === "setData").length, 0);
});

test("accepts GDAL transform input and derives raster alignment", () => {
  const fake = createFakeMap();
  const handle = addProjectedGrid(
    fake.map,
    { affine_transform: [-1000, 200, 0, 2000, 0, -500], shape: [4, 10] },
    { crs: "EPSG:3857" },
  );
  assert.equal(dataOf(fake).features.length, 2);
  const x = dataOf(fake).features.find((feature) => feature.properties.axis === "x");
  assert.ok(x && x.geometry.type === "MultiLineString");
  assert.deepEqual(x.properties.indices, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  handle.remove();
});

test("tile-pixel helper derives Web Mercator pixel resolution", () => {
  const fake = createFakeMap();
  const handle = addTilePixelGrid(
    fake.map,
    [-20_037_508.342789244, -20_037_508.342789244, 20_037_508.342789244, 20_037_508.342789244],
    { zoom: 0 },
  );
  const features = dataOf(fake).features;
  assert.equal(features.length, 2);
  assert.ok(features.every((feature) => feature.geometry.type === "MultiLineString"));
  assert.ok(
    features.every((feature) => {
      const indices = feature.properties.indices;
      return (
        Array.isArray(indices) && indices.length === 257 && indices[0] === 0 && indices[256] === 256
      );
    }),
  );
  handle.remove();
});

test("worker viewport lines use screen-space thinning and refresh the source", () => {
  const fake = createFakeMap({ bounds: [-1, -1, 1, 1], pixelsPerDegree: 100 });
  const worker = createGridWorker();
  const handle = addProjectedGrid(fake.map, [-1_000_000, -1_000_000, 1_000_000, 1_000_000], {
    crs: "EPSG:3857",
    resolution: 1000,
    viewport: { padding: 0, minSpacingPx: 4 },
    worker,
  });
  const features = dataOf(fake).features;
  assert.equal(features.length, 2);
  assert.ok(features.every((feature) => {
    return feature.geometry.type === "MultiLineString" &&
      Array.isArray(feature.properties.indices) &&
      feature.properties.indices.length < 60;
  }));

  fake.moveTo([10, 10, 12, 12]);
  assert.equal(fake.log.filter((entry) => entry === "setData").length, 1);
  handle.remove();
});
