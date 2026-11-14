/** Thrown for invalid bounding boxes, resolutions, options or oversized grids. */
export class GridError extends Error {
  public override name: string = "GridError";

  /** Create an error with the given message. */
  public constructor(message: string) {
    super(message);
  }
}
