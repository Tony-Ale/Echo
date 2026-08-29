import { ChatGroq } from "@langchain/groq";
import { ChatOpenAI } from "@langchain/openai";
import { ChatCohere } from "@langchain/cohere";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type {
  ChatModelConfiguration,
  ChatModelEndpointConfig,
  ChatModelResolver,
  ChatProviderConfig,
  ChatProviderType,
  ConfiguredChatModel,
  ChatModelRole,
} from "../../framework/models/types.js";
import { ResilientChatModel } from "./resilientChatModel.js";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export interface ChatProviderAdapter {
  readonly type: ChatProviderType;
  create(provider: ChatProviderConfig, endpoint: ChatModelEndpointConfig): BaseChatModel;
}

/** Provider and role registry following NanoBrowser's provider/model separation. */
export class LangChainModelRegistry implements ChatModelResolver {
  private readonly adapters = new Map<ChatProviderType, ChatProviderAdapter>();
  private readonly models = new Map<ChatModelRole, ConfiguredChatModel>();

  public constructor(private readonly configuration: ChatModelConfiguration) {
    this.register(new GroqAdapter());
    this.register(new OpenAIAdapter());
    this.register(new OpenRouterAdapter());
    this.register(new CohereAdapter());
    this.buildRoles();
  }

  public register(adapter: ChatProviderAdapter): void {
    this.adapters.set(adapter.type, adapter);
  }

  public get(role: ChatModelRole): ConfiguredChatModel {
    const model = this.models.get(role);
    if (!model) throw new Error(`Model role '${role}' is not configured.`);
    return model;
  }

  private buildRoles(): void {
    const providers = new Map(this.configuration.providers.map((provider) => [provider.id, provider]));
    for (const [role, endpoints] of Object.entries(this.configuration.roles) as Array<[ChatModelRole, ChatModelEndpointConfig[]]>) {
      const models = endpoints.map((endpoint) => {
        const provider = providers.get(endpoint.provider);
        if (!provider) throw new Error(`Unknown model provider '${endpoint.provider}'.`);
        const adapter = this.adapters.get(provider.type);
        if (!adapter) throw new Error(`No adapter is registered for model provider type '${provider.type}'.`);
        return { config: endpoint, model: adapter.create(provider, endpoint) };
      });
      this.models.set(role, new ResilientChatModel(role, models, this.configuration.failover));
    }
  }
}

class GroqAdapter implements ChatProviderAdapter {
  public readonly type = "groq" as const;
  public create(provider: ChatProviderConfig, endpoint: ChatModelEndpointConfig): BaseChatModel {
    return new ChatGroq({
      apiKey: readApiKey(provider),
      model: endpoint.model,
      temperature: endpoint.temperature,
      topP: endpoint.topP,
      maxTokens: endpoint.maxTokens,
      maxRetries: 0,
    });
  }
}

class OpenAIAdapter implements ChatProviderAdapter {
  public readonly type = "openai" as const;
  public create(provider: ChatProviderConfig, endpoint: ChatModelEndpointConfig): BaseChatModel {
    return new ChatOpenAI({
      apiKey: readApiKey(provider),
      model: endpoint.model,
      temperature: endpoint.temperature,
      topP: endpoint.topP,
      maxTokens: endpoint.maxTokens,
      maxRetries: 0,
      configuration: provider.baseUrl ? { baseURL: provider.baseUrl } : undefined,
    });
  }
}

/**
 * OpenRouter is a first-class Echo provider. Its API uses the OpenAI wire
 * protocol, so LangChain's ChatOpenAI remains an internal transport detail.
 */
class OpenRouterAdapter implements ChatProviderAdapter {
  public readonly type = "openrouter" as const;
  public create(provider: ChatProviderConfig, endpoint: ChatModelEndpointConfig): BaseChatModel {
    return new ChatOpenAI({
      apiKey: readApiKey(provider),
      model: endpoint.model,
      temperature: endpoint.temperature,
      topP: endpoint.topP,
      maxTokens: endpoint.maxTokens,
      maxRetries: 0,
      configuration: {
        baseURL: provider.baseUrl ?? OPENROUTER_BASE_URL,
      },
    });
  }
}

class CohereAdapter implements ChatProviderAdapter {
  public readonly type = "cohere" as const;
  public create(provider: ChatProviderConfig, endpoint: ChatModelEndpointConfig): BaseChatModel {
    return new ChatCohere({
      apiKey: readApiKey(provider),
      model: endpoint.model,
      temperature: endpoint.temperature,
      maxRetries: 0,
    });
  }
}

function readApiKey(provider: ChatProviderConfig): string {
  const value = process.env[provider.apiKeyEnv]?.trim();
  if (!value) throw new Error(`Model provider '${provider.id}' requires ${provider.apiKeyEnv}.`);
  return value;
}
