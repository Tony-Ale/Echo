import { Index } from "@pinecone-database/pinecone";
import { SheetRow } from "../../shared/types.js";
import { toNamespace } from "../../shared/utils/namespace.js";
import { createVectorStore } from "./pineconeClient.js";
import type { Document } from "@langchain/core/documents";

const MAX_BATCH = 100;

/**
 * Repository that encapsulates all Pinecone operations.
 */
export class VectorRepository {
  /**
   * @param index Pinecone index instance.
   */
  public constructor(private readonly index: Index) {}

  /**
   * Returns all vector IDs currently present in a namespace.
   *
   * @param namespace Pinecone namespace.
   * @returns Set of vector IDs.
   */
  public async listVectorIds(namespace?: string): Promise<Set<string>> {
    let ns;
    if (namespace) {
      ns = this.index.namespace(namespace);
    } else {
      ns = this.index;
    }
    const ids = new Set<string>();
    let paginationToken: string | undefined;

    while (true) {
      const page = (await (ns as unknown as {
        listPaginated: (args: {
          limit: number;
          paginationToken?: string;
        }) => Promise<{
          vectors?: Array<{ id?: string }>;
          pagination?: { next?: string };
        }>;
      }).listPaginated({
        limit: 100,
        paginationToken
      })) as {
        vectors?: Array<{ id?: string }>;
        pagination?: { next?: string };
      };

      for (const vector of page.vectors ?? []) {
        if (vector.id) {
          ids.add(vector.id);
        }
      }

      const next = page.pagination?.next;
      if (!next) {
        break;
      }
      paginationToken = next;
    }

    return ids;
  }

  /**
   * Fetches metadata hash by vector IDs from one namespace.
   *
   * @param namespace Pinecone namespace.
   * @param ids Vector IDs.
   * @returns Map from ID to content hash.
   */
  public async getContentHashesByIds(ids: string[], namespace?: string): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (ids.length === 0) {
      return result;
    }

    let ns;
    if (namespace) {
      ns = this.index.namespace(namespace);
    } else {
      ns = this.index;
    }

    for (let i = 0; i < ids.length; i += MAX_BATCH) {
      const batch = ids.slice(i, i + MAX_BATCH);
      const response = await ns.fetch(batch);
      const records = response.records ?? {};

      for (const id of Object.keys(records)) {
        const metadata = records[id]?.metadata as { contentHash?: string } | undefined;
        if (metadata?.contentHash) {
          result.set(id, metadata.contentHash);
        }
      }
    }

    return result;
  }

  public convertSheetRowToDocument(row:SheetRow){
    const metadata = {
      sheetName: row.sheetName,
      rowId: row.rowId,
      contentHash: row.contentHash,
      ...row.metadata
    };

    return {
      pageContent: row.content,
      metadata
    } as Document;
  }

  /**
   * Upserts rows with embeddings into one namespace.
   *
   * @param rows Source rows.
   */
  public async upsertRows(rows: SheetRow[], useNamespace: boolean = true): Promise<void> {

    if (rows.length === 0) {
      return;
    }

    const byNamespace = new Map<string, Array<{doc:Document, id:string}>>();
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const namespace = toNamespace(row.sheetName);
      const current = byNamespace.get(namespace) ?? [];
      const doc = this.convertSheetRowToDocument(row);
      current.push({doc, id: row.rowId});
      byNamespace.set(namespace, current);
    }

    for (const [namespace, grouped] of byNamespace.entries()) {
      // will not be using namespace
      const ns = useNamespace ? namespace : undefined;
      const vectorStore = await createVectorStore(this.index, ns);
      await vectorStore.addDocuments(grouped.map(x => x.doc), {ids: grouped.map(x => x.id)});
    }
  }

  /**
   * Deletes vectors by IDs from a namespace.
   *
   * @param namespace Pinecone namespace.
   * @param ids IDs to delete.
   */
  public async deleteByIds(ids: string[], namespace?: string): Promise<void> {
    if (ids.length === 0) {
      return;
    }


    const vectorStore = await createVectorStore(this.index, namespace);
    await vectorStore.delete({ ids });
  }

  /**
   * Executes semantic retrieval across all provided namespaces.
   *
   * @param query user query.
   * @param topK Number of results per namespace.
   * @returns Sorted list of retrieval hits.
   */
  public async query(
    query: string,
    topK: number = 5
  ) {

    const vectorStore = await createVectorStore(this.index);
    const retriever = vectorStore.asRetriever({
      k: topK,
    });

    const result = await retriever.invoke(query);
    return result
  }

}
