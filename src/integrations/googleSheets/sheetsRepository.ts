import { sheets_v4 } from "googleapis";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { normalizeRow } from "../../sync/rowNormalizer.js";
import { SheetRow } from "../../shared/types.js";
import { getHeaderRowIndexForMonthlyRotaSheet, sheetNameHeaderIndexMap, isMonthlyRotaSheet, SM_LIBRARY, SHEET_REGISTRY, MONTHLY_ROTA, smallSheets, ATTENDANCE } from "./utils.js";
import { reorganizeSmLibrary, reorganizeMonthlyRota, flattenSheet, groupAttendanceByMonth, attendanceMonthlyToRecords } from "./helpers.js";
import { clockService } from "../../shared/clockService.js";
import type { SpreadsheetDataService, SpreadsheetFilterOperator } from "../../agent/ports.js";
/**
 * Repository for reading and normalizing all rows from Google Sheets workbook.
 */
export class SheetsRepository implements SpreadsheetDataService {
  private readonly sheetValueCache = new Map<string, { rows: unknown[][]; expiresAt: number }>();
  private static readonly CACHE_TTL_MS = 60_000;
  private static readonly MAX_CACHE_ENTRIES = 30;

  /**
   * @param client Google Sheets API client.
   */
  public constructor(private readonly client: sheets_v4.Sheets) {}

  public async inspectSheet(sheetName: string): Promise<{
    sheetName: string;
    columns: string[];
    rowCount: number;
    sampleRows: Record<string, string>[];
  }> {
    const rows = await this.loadRawSheet(sheetName);
    return {
      sheetName: sheetName.trim(),
      columns: uniqueStrings(rows.flatMap((row) => Object.keys(row))),
      rowCount: rows.length,
      sampleRows: rows.slice(0, 5),
    };
  }

  public async querySheet(input: {
    sheetName: string;
    filters: Array<{ column: string; operator: SpreadsheetFilterOperator; value?: string }>;
    selectColumns: string[];
    limit: number;
  }): Promise<{ sheetName: string; rows: Record<string, string>[]; matchedRows: number; truncated: boolean }> {
    const rows = await this.loadRawSheet(input.sheetName);
    const columns = uniqueStrings(rows.flatMap((row) => Object.keys(row)));
    const resolveColumn = (requested: string): string => {
      const match = columns.find((column) => column.trim().toLowerCase() === requested.trim().toLowerCase());
      if (!match) throw new Error(`Column '${requested}' was not found in sheet '${input.sheetName}'.`);
      return match;
    };
    const filters = input.filters.map((filter) => ({ ...filter, column: resolveColumn(filter.column) }));
    const selected = input.selectColumns.map(resolveColumn);
    const matches = rows.filter((row) => filters.every((filter) => matchesFilter(row[filter.column] ?? "", filter.operator, filter.value)));
    return {
      sheetName: input.sheetName.trim(),
      matchedRows: matches.length,
      truncated: matches.length > input.limit,
      rows: matches.slice(0, input.limit).map((row) => Object.fromEntries(selected.map((column) => [
        column,
        projectMatchedCell(row[column] ?? "", column, filters),
      ]))),
    };
  }

  private async loadRawSheet(sheetName: string): Promise<Record<string, string>[]> {
    const normalizedName = sheetName.trim().toLowerCase();
    if (!normalizedName) throw new Error("A sheet name is required.");
    const result = await this.getAllRowsBySheet({ sheetNames: [sheetName.trim()], normalize: false });
    const exactRows = result.get(normalizedName) ?? [];
    if (exactRows.length > 0) return exactRows;

    // Natural requests commonly omit a workbook tab's year prefix or say
    // "sheet"/"tab". Only retry when one available title has the same
    // normalized label; this avoids fuzzy guesses across unrelated tabs.
    const matchingTitle = findMatchingSheetTitle(sheetName, await this.listSheetTitles());
    if (!matchingTitle || matchingTitle.toLowerCase().trim() === normalizedName) return exactRows;
    const retried = await this.getAllRowsBySheet({ sheetNames: [matchingTitle], normalize: false });
    return retried.get(matchingTitle.toLowerCase().trim()) ?? [];
  }

  private async listSheetTitles(): Promise<string[]> {
    const workbook = await this.client.spreadsheets.get({ spreadsheetId: env.GOOGLE_SPREADSHEET_ID });
    return workbook.data.sheets
      ?.map((sheet) => sheet.properties?.title)
      .filter((title): title is string => Boolean(title)) ?? [];
  }

  public clearCache(): void {
    this.sheetValueCache.clear();
  }


  /*
  Function Overloads to handle types due to the state of the normalize function
  */
  public async getAllRowsBySheet(
    options: { sheetNames?: string[]; normalize: true; bypassCache?: boolean }
  ): Promise<Map<string, SheetRow[]>>;

  public async getAllRowsBySheet(
    options: { sheetNames?: string[]; normalize: false; bypassCache?: boolean }
  ): Promise<Map<string, Record<string, string>[]>>;

  /**
   * Loads and normalizes every non-empty row from every sheet tab.
   * can optionally take in an array of sheetNames 
   * @returns Map of sheetName to normalized rows.
   */
  
  public async getAllRowsBySheet(
    options: {sheetNames?:string[], normalize:boolean, bypassCache?: boolean}={normalize:true}
  ): Promise<Map<string, SheetRow[]|Record<string, string>[]>> {

    const {sheetNames, normalize, bypassCache = false} = options;
    
    const CURRENT_YEAR = clockService.now().year;
    const SHORT_YEAR = String(CURRENT_YEAR).slice(-2);

    let sheetTitles: string[];
    if (sheetNames) {
      // A named tool query already knows its target and should not enumerate
      // every unrelated workbook tab first.
      sheetTitles = sheetNames;
    } else {
      sheetTitles = (await this.listSheetTitles())
        .filter((title) =>
          title.includes(String(CURRENT_YEAR)) ||
          new RegExp(`\\b${SHORT_YEAR}\\b`).test(title) ||
          sheetNameHeaderIndexMap.hasOwnProperty(title.toLowerCase().trim())
        );
    }

    let normalizedResult = new Map<string, SheetRow[]>();
    let reorganizedResult = new Map<string, Record<string, string>[]>();

    const processingReport: Record<string, string> = {};
    const sheetValues = await this.loadSheetValues(sheetTitles, bypassCache);

    for (const sheetname of sheetTitles) {
      const sheetName = sheetname.toLowerCase().trim()
      try {
        const rows = sheetValues.get(sheetName) ?? [];
        if (rows.length <= 1) {
          normalizedResult.set(sheetName, []);
          continue;
        }
        
        let headerRowIndex =getHeaderRowIndexForMonthlyRotaSheet(sheetName);
        if (headerRowIndex === undefined){
          headerRowIndex = sheetNameHeaderIndexMap[sheetName as keyof typeof sheetNameHeaderIndexMap] ?? 0;
        }
        const headers = rows[headerRowIndex].map((h) => String(h).trim());
        const documents: Record<string, string>[] = [];

        let currentDate = "";
        let currentTheme = "";

        for (let i = headerRowIndex+1; i < rows.length; i += 1) {
          const row = rows[i];
          const values: Record<string, string> = {};

          for (let col = 0; col < headers.length; col += 1) {
            const key = headers[col];
            if (!key) {
              continue;
            }
            const raw = row[col];
            values[key] = String(raw ?? "").trim();
          }

          const hasAnyValue = Object.values(values).some((v) => v.length > 0);
          if (!hasAnyValue) {
            continue;
          }
        
          // fill in missing dates for monthly rota sheets based on last known date
          if (isMonthlyRotaSheet(sheetName)) {
            const headerName = SHEET_REGISTRY[MONTHLY_ROTA].headers.DATE
            if (values[headerName]) {
              currentDate = values[headerName];
            } else if (currentDate) {
              values[headerName] = currentDate;
            }
          }

          // fill in missing themes for SM Library based on last known theme
          if (sheetName === SM_LIBRARY){
            const headerName = SHEET_REGISTRY[SM_LIBRARY].headers.THEME
            if (values[headerName]) {
              currentTheme = values[headerName];
            } else if (currentTheme) {
              values[headerName] = currentTheme;
            }
          }
          
          documents.push(values);
        }


        // Normalize documents into consistent content + hash format for vector indexing
        const {reorganizedDocuments, processingType} = this.reorganizeSheetData(sheetName, documents);
        if (normalize){
          const normalizedDocuments = reorganizedDocuments.map(values =>
            normalizeRow(sheetName, values)
          );

          normalizedResult.set(sheetName, normalizedDocuments);
        }else{
          reorganizedResult.set(sheetName, reorganizedDocuments);
        }
        processingReport[sheetName] = processingType;

      } catch (error) {
        logger.error({ error, sheetName }, "Failed to load sheet; continuing with next sheet");
        normalize ? normalizedResult.set(sheetName, []) : reorganizedResult.set(sheetName, []);
        processingReport[sheetName] = "Failed to load";
      }
    }
    // Print processing report if log level is info
    if (logger.level === "info") {
      logger.info({ processingReport }, "Sheet processing summary");
    }
    
    return normalize ? normalizedResult : reorganizedResult;
  }

  private async loadSheetValues(sheetTitles: string[], bypassCache: boolean): Promise<Map<string, unknown[][]>> {
    const now = clockService.now().toMillis();
    this.pruneSheetCache(now);
    const result = new Map<string, unknown[][]>();
    const missing: string[] = [];
    for (const title of sheetTitles) {
      const key = title.toLowerCase().trim();
      const cached = bypassCache ? undefined : this.sheetValueCache.get(key);
      if (cached && cached.expiresAt > now) result.set(key, cached.rows);
      else missing.push(title);
    }
    if (missing.length === 0) return result;

    try {
      const response = await this.client.spreadsheets.values.batchGet({
        spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
        ranges: missing.map((title) => `'${title}'`),
        majorDimension: "ROWS",
      });
      const ranges = response.data.valueRanges ?? [];
      missing.forEach((title, index) => {
        const rows = (ranges[index]?.values ?? []) as unknown[][];
        this.cacheSheetValues(title, rows, now);
        result.set(title.toLowerCase().trim(), rows);
      });
    } catch (error) {
      logger.warn({ error, sheetCount: missing.length }, "Batch sheet read failed; retrying tabs individually");
      for (const title of missing) {
        try {
          const response = await this.client.spreadsheets.values.get({
            spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
            range: `'${title}'`,
            majorDimension: "ROWS",
          });
          const rows = (response.data.values ?? []) as unknown[][];
          this.cacheSheetValues(title, rows, now);
          result.set(title.toLowerCase().trim(), rows);
        } catch (sheetError) {
          logger.error({ error: sheetError, sheetName: title }, "Failed to load sheet");
          result.set(title.toLowerCase().trim(), []);
        }
      }
    }
    return result;
  }

  private cacheSheetValues(title: string, rows: unknown[][], now: number): void {
    const key = title.toLowerCase().trim();
    this.sheetValueCache.delete(key);
    this.sheetValueCache.set(key, { rows, expiresAt: now + SheetsRepository.CACHE_TTL_MS });
    while (this.sheetValueCache.size > SheetsRepository.MAX_CACHE_ENTRIES) {
      const oldest = this.sheetValueCache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.sheetValueCache.delete(oldest);
    }
  }

  private pruneSheetCache(now: number): void {
    for (const [key, cached] of this.sheetValueCache) {
      if (cached.expiresAt <= now) this.sheetValueCache.delete(key);
    }
  }

  private reorganizeSheetData(sheetName: string, documents: Record<string, string>[]){
    // Normalize documents into consistent content + hash format for vector indexing
    let reorganizedDocuments: Record<string, string>[] = [];
    let processingType = "default";

    if (sheetName === SM_LIBRARY) {
      reorganizedDocuments = reorganizeSmLibrary(documents);
      processingType = "Grouped by theme (SM Library)";
    }
    else if (isMonthlyRotaSheet(sheetName)){
      reorganizedDocuments = reorganizeMonthlyRota(documents)
      processingType = "Grouped weekly (Monthly Rota)";
    } 
    else if (smallSheets.includes(sheetName)){
      reorganizedDocuments = [flattenSheet(documents)]
      processingType = "Flattened fully (Small Sheet)";
    }
    else if (sheetName === ATTENDANCE){
      const grouped = groupAttendanceByMonth(documents)
      reorganizedDocuments = attendanceMonthlyToRecords(grouped)
      processingType = "Grouped by month (Attendance)"
    } 
    else {
      reorganizedDocuments = documents
      processingType = "Default Processing; Row by Row";
    }

    if (reorganizedDocuments.length === 0){
      processingType = "Reorganization returned an empty sheet; maybe due to incorrect header index"
    }

    return {
      reorganizedDocuments,
      processingType
    };

  }

}

function matchesFilter(
  rawValue: string,
  operator: SpreadsheetFilterOperator,
  expected?: string,
): boolean {
  const value = rawValue.trim().toLowerCase();
  const target = expected?.trim().toLowerCase() ?? "";
  if (operator === "empty") return value.length === 0;
  if (operator === "not_empty") return value.length > 0;
  if (operator === "equals") return value === target;
  if (operator === "not_equals") return value !== target;
  return value.includes(target);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

/** Keeps only matching lines when a filter targets a multiline aggregate cell. */
export function projectMatchedCell(
  value: string,
  column: string,
  filters: Array<{ column: string; operator: SpreadsheetFilterOperator; value?: string }>,
): string {
  if (!value.includes("\n")) return value;
  const containsFilters = filters.filter((filter) =>
    filter.column === column && filter.operator === "contains" && Boolean(filter.value?.trim()),
  );
  if (containsFilters.length === 0) return value;
  const matchingLines = value.split(/\r?\n/).filter((line) =>
    containsFilters.every((filter) => line.toLowerCase().includes(filter.value!.trim().toLowerCase())),
  );
  return matchingLines.length > 0 ? matchingLines.join("\n") : value;
}

export function findMatchingSheetTitle(requested: string, availableTitles: string[]): string | null {
  const requestedLabel = normalizeSheetLabel(requested);
  if (!requestedLabel) return null;
  const matches = availableTitles.filter((title) => normalizeSheetLabel(title) === requestedLabel);
  if (matches.length === 1) return matches[0];
  const currentYear = String(clockService.now().year);
  const currentYearMatches = matches.filter((title) => new RegExp(`\\b${currentYear}\\b`).test(title));
  return currentYearMatches.length === 1 ? currentYearMatches[0] : null;
}

function normalizeSheetLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(?:19|20)\d{2}\b/g, " ")
    .replace(/\b(?:sheet|tab)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
