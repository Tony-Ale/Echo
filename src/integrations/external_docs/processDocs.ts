import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { promises as fs } from "fs";

export async function extractAndchunkDocuments(filepath:string){
    const text = await fs.readFile(filepath, "utf-8");
    const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 1500, chunkOverlap: 100 })
    const texts = splitter.splitText(text)
    return texts
}


/**
 * This function takes in a .txt file path, and then extracts the text and split on two or more new line characters
 * @param filePath 
 * @returns 
 */
export async function customExtractAndChunkText(filePath: string) {
    try {
        // Read the file
        const text = await fs.readFile(filePath, "utf-8");

        const normalized = text.replace(/\r\n/g, "\n");

        // Split on two or more newline characters
        const documents = normalized
        .split(/\n{3,}/)
        .map(section => section.trim())
        .filter(doc => doc.length > 0);

        return documents;
    } catch (error) {
        console.error("Error reading file:", error);
        throw error;
    }
}
