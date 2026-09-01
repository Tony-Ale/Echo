import { SheetRow } from "../../shared/types";
import { customExtractAndChunkText, extractAndchunkDocuments } from "./processDocs";
import { docNames } from "./utils";
import { normalizeRow } from "../../sync/rowNormalizer";
import { logData } from "../../logger/execLogger";
import { sha256 } from "../../shared/utils/hash";

export class ExternalDocumentsRepository{

    public async getAllDocumentsByNames(){

        let normalizedResult = new Map<string, SheetRow[]>();
        const processingReport: Record<string, string> = {};


        // Iterate through the sheet names, extract and normalize data
        for (const docName of Object.values(docNames)) {
            try{
                const filePath = `./src/externalDocuments/${docName}.txt`
                let documents:string[];
                if (docName === docNames.oha_originals){
                    documents = await customExtractAndChunkText(filePath)
                }else{
                    documents = await extractAndchunkDocuments(filePath)
                }

                const normalizedDocuments = documents.map((doc, index) => {
                    const normalized = normalizeRow(docName, {content: doc})
                    const chunkIndex = String(index).padStart(6, "0")
                    return {
                        ...normalized,
                        // Ordered IDs and chunk metadata make complete indexed
                        // reads restart-safe and independent of vector ranking.
                        rowId: `${docName}-chunk-${chunkIndex}`,
                        contentHash: sha256(`${normalized.contentHash}|${chunkIndex}|${documents.length}`),
                        metadata: {
                            sourceType: "external_document",
                            documentName: docName,
                            chunkIndex,
                            chunkCount: String(documents.length),
                        },
                    }
                })

                processingReport[docName] = "Success, Num of Chunks: " + normalizedDocuments.length

                normalizedResult.set(docName, normalizedDocuments);
                
            }catch (error){
                logData({error, docName}, "Failed to load document; continuing with next document")
                normalizedResult.set(docName, []);

            }
        }

        logData(processingReport, "Document processing summary");

        return normalizedResult

    }
}
