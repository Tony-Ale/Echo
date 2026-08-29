/**
 * Map-like record that represents one normalized row from Google Sheets.
 */
export interface SheetRow {
  /** Name of the source sheet tab. */
  sheetName: string;
  /** Deterministic identifier derived from stable row fields. */
  rowId: string;
  /** Canonical key/value content for the row. */
  values: Record<string, string>;
  /** Canonical plain-text content used for embeddings and prompting. */
  content: string;
  /** SHA256 hash of canonical row JSON for change detection. */
  contentHash: string;

  // optional metadata of the sheet that you will like to store
  metadata?: Record<string, string>;
}

/**
 * Summary of synchronization changes for one namespace/sheet.
 */
export interface SheetSyncStats {
  /** Namespace (sheet) name. */
  namespace?: string;
  sheetName: string;
  /** Number of rows detected in source sheet. */
  sourceCount: number;
  /** Number of vectors created. */
  inserted: number;
  /** Number of vectors updated. */
  updated: number;
  /** Number of vectors deleted. */
  deleted: number;
  /** Number of vectors unchanged based on hash comparison. */
  unchanged: number;
}

/**
 * Result returned by the end-to-end synchronization engine.
 */
export interface SyncResult {
  /** Deterministic hash of the normalized source snapshot. */
  sourceHash?: string;
  /** Stats grouped by sheet namespace. */
  perSheet: SheetSyncStats[];
  /** Total created vectors across all sheets. */
  inserted: number;
  /** Total updated vectors across all sheets. */
  updated: number;
  /** Total deleted vectors across all sheets. */
  deleted: number;
  /** Total unchanged vectors across all sheets. */
  unchanged: number;

  /** contains sheet names that appears in doc names. they wont be synced in order to avoid issues */
  duplicates: string;
}
