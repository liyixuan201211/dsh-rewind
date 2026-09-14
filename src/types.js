/**
 * Shared types. Kept in one module so every other module can reference them
 * without a circular import.
 *
 * A manifest is a flat map from a root-relative, forward-slash path to one
 * entry describing what is at that path. It is deliberately flat: comparing two
 * manifests is then a key-set diff, and there is no tree to walk, merge or get
 * wrong.
 */

/**
 * A regular file whose bytes are in the object store.
 *
 * There is deliberately no mtime here. A manifest answers one question — "what
 * is this tree made of?" — and a timestamp is not part of the answer. Keeping
 * mtime in the entry made a merely *touched* file produce a different manifest
 * hash, so `unchanged` disagreed with the diff, which compares content. The
 * mtime shortcut that avoids re-reading unchanged files lives in the store's
 * stat cache (`.rewind/stat.json`) instead, where being wrong costs a re-read
 * and nothing else.
 *
 * `mode` *is* part of the answer: an agent that chmods a script has changed the
 * tree, and an undo should put the bit back.
 *
 * @typedef {{ t: "f", h: string, s: number, mode: number }} FileEntry
 */

/** A symlink, recorded by target and never followed. @typedef {{ t: "l", to: string }} LinkEntry */

/** A directory. Recorded so that empty directories survive a rewind. @typedef {{ t: "d" }} DirEntry */

/**
 * Something that exists but whose bytes are not in the store: too large, not a
 * regular file, or unreadable. It is recorded rather than skipped so that
 * `undo` can tell the difference between "this did not exist" and "this existed
 * and I could not save it" — the difference between deleting it and refusing to.
 *
 * @typedef {{ t: "x", why: string, s?: number }} OtherEntry
 */

/** @typedef {FileEntry | LinkEntry | DirEntry | OtherEntry} Entry */

/**
 * One entry of the scan-speed cache: enough to know a file's content hash
 * without reading it, and nothing more. Advisory by construction — if it is
 * missing, stale or deleted, the next scan simply re-reads every file.
 *
 * @typedef {{ s: number, m: number, h: string }} StatEntry
 */

/** @typedef {Record<string, StatEntry>} StatCache */

/** @typedef {Record<string, Entry>} Manifest */

/**
 * @typedef {object} ScanStats
 * @property {number} files
 * @property {number} dirs
 * @property {number} links
 * @property {number} skipped
 * @property {number} bytes
 * @property {number} reused   files whose hash came from the previous manifest
 * @property {number} excluded paths pruned by the exclude rules
 */

/**
 * What a command was, for `rewind exec` records.
 *
 * @typedef {object} CommandInfo
 * @property {string} argv   the command as a single display string
 * @property {number | null} code   exit code, or null if it never ran
 * @property {number} ms     wall-clock duration
 */

/**
 * One line of the append-only log. The manifest it points at is stored
 * separately and content-addressed, so a snapshot that changed nothing costs one
 * small line rather than a full copy of the tree.
 *
 * @typedef {object} Snapshot
 * @property {1} v
 * @property {string} id            sortable, unique: `20260914T101530Z-1a2b`
 * @property {number} seq           1-based position in the log
 * @property {string} time          ISO 8601
 * @property {"snap" | "watch" | "exec" | "undo" | "prune"} kind
 * @property {string} label
 * @property {string} manifest      content hash of the manifest
 * @property {string | null} parent previous snapshot id
 * @property {string | null} parentManifest
 * @property {ScanStats} counts
 * @property {boolean} unchanged    manifest is identical to the parent's
 * @property {string} [note]
 * @property {CommandInfo} [command]
 */

export {};
