import { randomUUID } from "node:crypto";
import type { ChannelMessage } from "../types.js";
import type { MemoryStore, RecordChannelMessageInput } from "./memoryStore.js";

export class InMemoryMemoryStore implements MemoryStore {
  private readonly messages: ChannelMessage[] = [];
  private readonly usageByDay = new Map<string, number>();

  async recordChannelMessage(input: RecordChannelMessageInput): Promise<ChannelMessage | undefined> {
    const duplicate = this.messages.find(
      (message) => message.channelId === input.channelId && message.ts === input.ts
    );

    if (duplicate) {
      return undefined;
    }

    const message: ChannelMessage = {
      id: randomUUID(),
      channelId: input.channelId,
      ts: input.ts,
      threadTs: input.threadTs,
      authorType: input.authorType,
      authorId: input.authorId,
      authorName: input.authorName,
      authorAgentId: input.authorAgentId,
      text: input.text,
      createdAt: new Date().toISOString()
    };

    this.messages.push(message);
    return message;
  }

  async listRecentChannelMessages(channelId: string, limit: number): Promise<ChannelMessage[]> {
    return this.messages
      .filter((message) => message.channelId === channelId)
      .slice(-limit);
  }

  async getDailyRealUsage(day: string): Promise<number> {
    return this.usageByDay.get(day) ?? 0;
  }

  async incrementDailyRealUsage(day: string): Promise<number> {
    const next = (this.usageByDay.get(day) ?? 0) + 1;
    this.usageByDay.set(day, next);
    return next;
  }
}
