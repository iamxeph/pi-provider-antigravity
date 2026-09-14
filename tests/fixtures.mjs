import path from "node:path";

export const CAPTURE_DIR = "tests/fixtures";

/** Path to a fixture inside tests/fixtures. */
export const newestCapture = (file) => path.join(CAPTURE_DIR, file);
