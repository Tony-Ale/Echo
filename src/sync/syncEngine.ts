import { logger } from "../config/logger.js";
import { ExternalDocumentsRepository } from "../integrations/external_docs/externalDocsRepository.js";
import { SheetsRepository } from "../integrations/googleSheets/sheetsRepository.js";
import { VectorRepository } from "../integrations/pinecone/vectorRepository.js";
import { SheetRow, SheetSyncStats, SyncResult } from "../shared/types.js";
import { toNamespace } from "../shared/utils/namespace.js";
import { sha256 } from "../shared/utils/hash.js";

/**
 * End-to-end synchronization engine from Google Sheets into Pinecone.
 */
export class SyncEngine {
  /**
   * @param sheetsRepository Source sheet repository.
   * @param vectorRepository Pinecone repository.
   * @param externalDocRepository text files docs
   */

  public constructor(
    private readonly sheetsRepository: SheetsRepository,
    private readonly vectorRepository: VectorRepository,
    private readonly externalDocRepository: ExternalDocumentsRepository
  ) {}

  /**
   * Synchronizes all rows from all sheets into Pinecone namespaces.
   *
   * @returns Aggregated synchronization result.
   */
  public async run(useNamespace = true ): Promise<SyncResult> {

    this.sheetsRepository.clearCache();
    const rowsBySheet = await this.sheetsRepository.getAllRowsBySheet({ normalize: true, bypassCache: true });
    const externalDocs = await this.externalDocRepository.getAllDocumentsByNames();

    // merge the two maps into one if sheet name is present as a name in external doc, both the sheet name data and external doc data will not be synced
    const merged = new Map([...rowsBySheet])
    const duplicates = []
    for (const [key, value] of externalDocs.entries()){
      if (merged.has(key)){
        merged.delete(key);
        duplicates.push(key)
      }else{
        merged.set(key, value)
      }
    }

    const sourceHash = sha256(
      [...merged.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .flatMap(([sheetName, rows]) => rows.map((row) => `${sheetName}:${row.rowId}:${row.contentHash}`))
        .join("\n")
    );

    const perSheet: SheetSyncStats[] = [];
    let totalInserted = 0;
    let totalUpdated = 0;
    let totalDeleted = 0;
    let totalUnchanged = 0;

    for (const [sheetName, rows] of merged.entries()) {
      try {
        const stats = await this.syncOneSheet(sheetName, rows, useNamespace);
        perSheet.push(stats);
        totalInserted += stats.inserted;
        totalUpdated += stats.updated;
        totalDeleted += stats.deleted;
        totalUnchanged += stats.unchanged;
      } catch (error) {
        logger.error({ error, sheetName }, "Failed to sync sheet");
      }
    }

    return {
      sourceHash,
      perSheet,
      inserted: totalInserted,
      updated: totalUpdated,
      deleted: totalDeleted,
      unchanged: totalUnchanged,
      duplicates: duplicates.length > 0 ? duplicates.join(", ") + " Sheet name in workbook and external doc name matched, so they wont be synced" : ""
    };
  }

  private async syncOneSheet(sheetName: string, rows: SheetRow[], useNamespace: boolean = true): Promise<SheetSyncStats> {

    const namespace = useNamespace ? toNamespace(sheetName) : undefined;
    const sourceIds = new Set(rows.map((r) => r.rowId));
    const existingIds = await this.vectorRepository.listVectorIds(namespace);
    const existingHashes = await this.vectorRepository.getContentHashesByIds([...existingIds], namespace);

    const toUpsert: SheetRow[] = [];
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;

    for (const row of rows) {
      const existingHash = existingHashes.get(row.rowId);
      if (!existingHash) {
        inserted += 1;
        toUpsert.push(row);
        continue;
      }

      if (existingHash !== row.contentHash) {
        updated += 1;
        toUpsert.push(row);
      } else {
        unchanged += 1;
      }
    }

    const staleIds = [...existingIds].filter((id) => !sourceIds.has(id) && id.startsWith(`${sheetName}-`));
    const deleted = staleIds.length;

    if (toUpsert.length > 0) {
      await this.vectorRepository.upsertRows(toUpsert, useNamespace);
    }

    if (staleIds.length > 0) {
      await this.vectorRepository.deleteByIds(staleIds, namespace);
    }

    return {
      namespace,
      sheetName,
      sourceCount: rows.length,
      inserted,
      updated,
      deleted,
      unchanged
    };
  }
}
