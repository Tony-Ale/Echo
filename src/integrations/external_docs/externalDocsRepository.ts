import { SheetRow } from "../../shared/types";
import { customExtractAndChunkText, extractAndchunkDocuments } from "./processDocs";
import { docNames } from "./utils";
import { normalizeRow } from "../../sync/rowNormalizer";
import { logData } from "../../logger/execLogger";

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

                const normalizedDocuments = documents.map(doc=>(
                    normalizeRow(docName, {content: doc})
                ))

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
