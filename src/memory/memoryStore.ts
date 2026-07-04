import type { ChannelMessage } from "../types.js";

export interface RecordChannelMessageInput {
  channelId: string;
  ts: string;
  threadTs?: string;
  authorType: "human" | "agent";
  authorId: string;
  authorName: string;
  authorAgentId?: string;
  text: string;
}

export interface MemoryStore {
  recordChannelMessage(input: RecordChannelMessageInput): Promise<ChannelMessage | undefined>;
  listRecentChannelMessages(channelId: string, limit: number): Promise<ChannelMessage[]>;
  getDailyRealUsage(day: string): Promise<number>;
  incrementDailyRealUsage(day: string): Promise<number>;
}
