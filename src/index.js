/**
 * dsh-rewind as a library.
 *
 * The CLI is the product; this surface exists so that a test, a script, or
 * another agent runtime can drive the same machinery without shelling out. Every
 * export here is the exact function the CLI calls — there is no second
 * implementation to drift.
 */
export { loadConfig, isExcluded, unsafePath, parseIgnore, DEFAULT_EXCLUDED_NAMES } from "./config.js";
export { Store, StoreError } from "./store.js";
export { scanTree, sameEntry } from "./scan.js";
export { takeSnapshot, recordExistingManifest } from "./snapshot.js";
export { compareEntries, planUndo, checkManifest, isNoop } from "./plan.js";
export { rewindTo, applyPlan, readAt } from "./undo.js";
export { resolveRef, parseTimeRef, RefError } from "./refs.js";
export { unifiedDiff, diffLines, countDiff } from "./diff.js";
export { rewindExec } from "./exec.js";
export { watchDirectory } from "./watch.js";
export { pruneStore } from "./prune.js";
export { doctorStore } from "./doctor.js";
export { main, VERSION, EXIT } from "./cli.js";
