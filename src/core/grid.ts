import { GridError } from "../errors";
import type {
  BBox,
  GridMode,
  GridOptions,
  LineFeature,
  LineFeatureCollection,
  ViewportOptions,
} from "../types";
import { lineFeature } from "./features";
import { buildTicks, countCells } from "./ticks";
import { resolveSteps } from "./units";
import { validateBBox } from "./validate";
import { viewportLinesByStep } from "./viewport";

/**
 * A regular lon/lat grid over a bounding box.
 *
 * Cells are anchored at the south-west corner. If the box isn't an exact multiple of the
 * resolution, the last row and column are clipped to the box.
 */
export class BBoxGrid {
  /** The validated bounding box `[west, south, east, north]`. */
  public readonly bbox: BBox;
  /** Cell width in degrees of longitude. */
  public readonly xStep: number;
  /** Cell height in degrees of latitude. */
  public readonly yStep: number;
  /** Longitudes of the vertical grid lines, west to east. */
  private xTicks?: number[];
  /** Latitudes of the horizontal grid lines, south to north. */
  private yTicks?: number[];
  private readonly columnCount: number;
  private readonly rowCount: number;

  /** Longitudes of the vertical grid lines, west to east. Materialized on first access. */
  public get xs(): readonly number[] {
    if (!this.xTicks) {
      this.xTicks = buildTicks(this.bbox[0], this.bbox[2], this.xStep);
    }
    return this.xTicks;
  }

  /** Latitudes of the horizontal grid lines, south to north. Materialized on first access. */
  public get ys(): readonly number[] {
    if (!this.yTicks) {
      this.yTicks = buildTicks(this.bbox[1], this.bbox[3], this.yStep);
    }
    return this.yTicks;
  }

  /**
   * Create a grid.
   * @param bbox - `[west, south, east, north]` in degrees.
   * @param options - Provide exactly one of `resolution` or `cells`.
   * @throws {GridError} For invalid input or a grid larger than `maxCells`.
   */
  public constructor(bbox: BBox, options: GridOptions) {
    this.bbox = validateBBox(bbox);
    const { maxCells } = options;
    const [xStep, yStep] = resolveSteps(this.bbox, options);
    const [west, south, east, north] = this.bbox;

    const cols = countCells(west, east, xStep);
    const rows = countCells(south, north, yStep);
    if (maxCells !== undefined && cols * rows > maxCells) {
      throw new GridError(
        `grid would have ${(cols * rows).toLocaleString("en-US")} cells (limit ${maxCells.toLocaleString("en-US")}); ` +
          "use a coarser resolution or raise maxCells",
      );
    }
    if (!Number.isSafeInteger(cols) || !Number.isSafeInteger(rows)) {
      throw new GridError("grid dimensions must be safe integers; use a coarser resolution");
    }

    this.xStep = xStep;
    this.yStep = yStep;
    this.columnCount = cols;
    this.rowCount = rows;
  }

  /** Number of columns. */
  public get cols(): number {
    return this.columnCount;
  }

  /** Number of rows. */
  public get rows(): number {
    return this.rowCount;
  }

  /** Total number of cells. */
  public get cellCount(): number {
    return this.cols * this.rows;
  }

  /** One LineString per grid line (efficient: no duplicated edges). */
  public lines(): LineFeatureCollection {
    const [west, south, east, north] = this.bbox;
    const features: LineFeature[] = [];
    for (let index = 0; index < this.xs.length; index++) {
      const x = this.xs[index];
      features.push(
        lineFeature(
          [
            [x, south],
            [x, north],
          ],
          { axis: "x", index },
        ),
      );
    }
    for (let index = 0; index < this.ys.length; index++) {
      const y = this.ys[index];
      features.push(
        lineFeature(
          [
            [west, y],
            [east, y],
          ],
          { axis: "y", index },
        ),
      );
    }
    return { type: "FeatureCollection", features };
  }

  /**
   * One closed LineString ring per cell, with `row` and `col` properties (0,0 is the south-west
   * cell). Adjacent cells share edges, so this is heavier than {@link BBoxGrid.lines}; use it when
   * you need per-cell properties.
   */
  public cells(): LineFeatureCollection {
    const features: LineFeature[] = [];
    for (let row = 0; row < this.rows; row++) {
      const y0 = this.ys[row];
      const y1 = this.ys[row + 1];
      for (let col = 0; col < this.cols; col++) {
        const x0 = this.xs[col];
        const x1 = this.xs[col + 1];
        features.push(
          lineFeature(
            [
              [x0, y0],
              [x1, y0],
              [x1, y1],
              [x0, y1],
              [x0, y0],
            ],
            { row, col },
          ),
        );
      }
    }
    return { type: "FeatureCollection", features };
  }

  /**
   * Grid lines for the visible area only, thinned out when too many would be on screen.
   * @param view - Visible bounds `[west, south, east, north]`.
   * @param options - Padding and line cap.
   */
  public linesInView(view: BBox, options?: ViewportOptions): LineFeatureCollection {
    return viewportLinesByStep(
      this.bbox,
      this.xStep,
      this.yStep,
      this.cols,
      this.rows,
      view,
      options,
    );
  }

  /**
   * The whole grid as GeoJSON.
   * @param mode - `"lines"` (default) or `"cells"`.
   */
  public toGeoJSON(mode: GridMode = "lines"): LineFeatureCollection {
    if (mode === "lines") {
      return this.lines();
    }
    return this.cells();
  }
}
