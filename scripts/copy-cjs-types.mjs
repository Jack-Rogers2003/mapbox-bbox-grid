import { copyFileSync } from "node:fs";

copyFileSync("dist/index.d.ts", "dist/index.d.cts");
