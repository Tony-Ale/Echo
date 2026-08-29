import { Index, Pinecone, RecordMetadata } from "@pinecone-database/pinecone";
import { env } from "../../config/env.js";
import { PineconeStore } from "@langchain/pinecone";
import { createConfiguredEmbeddings } from "../models/cohereClient.js";
import { loadModelConfiguration } from "../models/modelConfiguration.js";

const validatedIndexes = new WeakSet<object>();

/**
 * Get Existing Pinecone Index
 *
 * @returns Pinecone index object.
 */
export function getPineconeIndex() {
  const client = new Pinecone({ apiKey: env.PINECONE_API_KEY });
  return client.index(env.PINECONE_INDEX_NAME);
}

export async function createVectorStore(index: Index<RecordMetadata>, namespace?:string){
  const modelConfiguration = loadModelConfiguration();
  await validateEmbeddingCompatibility(index, modelConfiguration.embeddings.dimension);
  const embeddings = createConfiguredEmbeddings(modelConfiguration);

  const vectorStore = await PineconeStore.fromExistingIndex(
    embeddings,
    {
      pineconeIndex:index,
      // Maximum number of batch requests to allow at once. Each batch is 1000 vectors.
      maxConcurrency: 5,
      namespace: namespace,
    }
  );

  return vectorStore;
}

/** Prevents silently writing vectors from an incompatible embedding model. */
async function validateEmbeddingCompatibility(index: Index<RecordMetadata>, configuredDimension: number): Promise<void> {
  if (validatedIndexes.has(index)) return;
  const stats = await index.describeIndexStats();
  if (stats.dimension !== configuredDimension) {
    throw new Error(
      `Pinecone index dimension ${stats.dimension ?? "unknown"} does not match configured embedding dimension ${configuredDimension}. `
      + "Use a compatible embedding model or rebuild the index.",
    );
  }
  validatedIndexes.add(index);
}
