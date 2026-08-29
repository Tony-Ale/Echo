import { SyncEngine } from "./syncEngine";
import { createGoogleSheetsClient } from "../integrations/googleSheets/googleSheetsClient.js";
import { SheetsRepository } from "../integrations/googleSheets/sheetsRepository.js";
import { getPineconeIndex } from "../integrations/pinecone/pineconeClient.js";
import { VectorRepository } from "../integrations/pinecone/vectorRepository.js";
import { ExternalDocumentsRepository } from "../integrations/external_docs/externalDocsRepository";

export function initSync(sheetsRepository = new SheetsRepository(createGoogleSheetsClient())): SyncEngine {
    const pineconeIndex = getPineconeIndex();
    const vectorRepository = new VectorRepository(pineconeIndex);
    const externalDocRepository = new ExternalDocumentsRepository()
    return new SyncEngine(sheetsRepository, vectorRepository, externalDocRepository);
}
