/** Metres per degree of latitude (spherical approximation). */
export const METRES_PER_DEGREE_LAT = 111_320;

/** Tolerance that stops float noise (e.g. 0.3 / 0.1) from creating an extra cell. */
export const EPSILON = 1e-9;

/** Coordinates are rounded to 8 decimal places (about 1 mm). */
export const COORD_SCALE = 1e8;

/** Default id of the map source and layer. */
export const DEFAULT_LAYER_ID = "bboxgrid";

/** Default cap on lines drawn at once in viewport mode. */
export const DEFAULT_MAX_LINES = 1000;

/** Default viewport padding, as a fraction of the visible size. */
export const DEFAULT_VIEWPORT_PADDING = 0.25;

/** Default padding (px) used by `fit: true`. */
export const DEFAULT_FIT_PADDING_PX = 40;

/** Default line paint. Width and opacity scale with zoom so far-out views stay light. */
export const DEFAULT_PAINT: Readonly<Record<string, unknown>> = {
  "line-color": "#e63946",
  "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.3, 12, 1.2],
  "line-opacity": ["interpolate", ["linear"], ["zoom"], 3, 0.5, 10, 0.9],
};

/** Default line layout. */
export const DEFAULT_LAYOUT: Readonly<Record<string, unknown>> = {
  "line-join": "round",
  "line-cap": "round",
};
