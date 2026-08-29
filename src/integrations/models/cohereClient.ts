import { CohereEmbeddings } from "@langchain/cohere";
import { OpenAIEmbeddings } from "@langchain/openai";
import type { ModelConfiguration } from "../../framework/models/types.js";
import { loadModelConfiguration } from "./modelConfiguration.js";

export function createConfiguredEmbeddings(configuration: ModelConfiguration = loadModelConfiguration()) {
    const embedding = configuration.embeddings;
    const provider = configuration.providers.find((candidate) => candidate.id === embedding.provider);
    if (!provider) throw new Error(`Embedding provider '${embedding.provider}' is not configured.`);

    const apiKeyEnv = provider.apiKeyEnv;
    const apiKey = process.env[apiKeyEnv]?.trim();
    if (!apiKey) throw new Error(`Embedding provider '${provider.id}' requires ${apiKeyEnv}.`);

    if (provider.type === "openai") {
        return new OpenAIEmbeddings({
            apiKey,
            model: embedding.model,
            dimensions: embedding.dimension,
            batchSize: embedding.batchSize,
            configuration: provider.baseUrl ? { baseURL: provider.baseUrl } : undefined,
        });
    }

    return new CohereEmbeddings({
        apiKey,
        batchSize: embedding.batchSize,
        model: embedding.model,
    });
}
