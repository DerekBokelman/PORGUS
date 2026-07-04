export type AgentRole = "system" | "user" | "assistant";
export type ProviderName = "mock" | "gemini" | "groq" | "openrouter" | "ollama";
export type RespondsWhen = "always" | "mentioned" | "mentioned-or-relevant";
export type CompressionStyle = "normal" | "caveman";

export interface ChatMessage {
  role: AgentRole;
  content: string;
}

export interface AgentDefinition {
  id: string;
  displayName: string;
  role: string;
  personality: string;
  provider: ProviderName;
  model: string;
  temperature: number;
  compressionStyle: CompressionStyle;
  respondsWhen: RespondsWhen;
  cooldownMs: number;
  slack: AgentSlackConfig;
  relevanceKeywords: string[];
}

export interface AgentDefaults {
  provider: ProviderName;
  model: string;
  temperature: number;
  compressionStyle: CompressionStyle;
  respondsWhen: RespondsWhen;
  cooldownMs: number;
}

export interface AgentSlackConfig {
  botTokenEnv: string;
  appTokenEnv: string;
  signingSecretEnv?: string;
}

export interface BudgetConfig {
  dailyRealCallLimit: number;
}

export interface CoordinationConfig {
  maxConsecutiveAgentTurns: number;
  responseDelayMs: number;
  maxResponsesPerMessage: number;
  recentMessageLimit: number;
}

export interface AgentNetworkConfig {
  defaults: AgentDefaults;
  budget: BudgetConfig;
  coordination: CoordinationConfig;
  agents: AgentDefinition[];
}

export interface ChannelMessage {
  id: string;
  channelId: string;
  ts: string;
  threadTs?: string;
  authorType: "human" | "agent";
  authorId: string;
  authorName: string;
  authorAgentId?: string;
  text: string;
  createdAt: string;
}

export interface LlmCompletionInput {
  agent: AgentDefinition;
  messages: ChatMessage[];
  temperature?: number;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmCompletionResult {
  text: string;
  usage?: LlmUsage;
}

export interface LlmProvider {
  complete(input: LlmCompletionInput): Promise<LlmCompletionResult>;
}
