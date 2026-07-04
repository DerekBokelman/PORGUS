import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import type { ChannelMessage } from "../types.js";
import type { MemoryStore, RecordChannelMessageInput } from "./memoryStore.js";

interface ChannelMessageRow {
  id: string;
  channel_id: string;
  ts: string;
  thread_ts?: string;
  author_type: "human" | "agent";
  author_id: string;
  author_name: string;
  author_agent_id?: string;
  text: string;
  created_at: string;
}

export class SqliteMemoryStore implements MemoryStore {
  private readonly database: Database;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new Database(databasePath);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS channel_messages (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        ts TEXT NOT NULL,
        thread_ts TEXT,
        author_type TEXT NOT NULL,
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        author_agent_id TEXT,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(channel_id, ts)
      );

      CREATE TABLE IF NOT EXISTS daily_usage (
        day TEXT PRIMARY KEY,
        count INTEGER NOT NULL
      );
    `);
  }

  async recordChannelMessage(input: RecordChannelMessageInput): Promise<ChannelMessage | undefined> {
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

    const result = this.database
      .query(
        `INSERT OR IGNORE INTO channel_messages
          (id, channel_id, ts, thread_ts, author_type, author_id, author_name, author_agent_id, text, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        message.id,
        message.channelId,
        message.ts,
        message.threadTs ?? null,
        message.authorType,
        message.authorId,
        message.authorName,
        message.authorAgentId ?? null,
        message.text,
        message.createdAt
      );

    if (result.changes === 0) {
      return undefined;
    }

    return message;
  }

  async listRecentChannelMessages(channelId: string, limit: number): Promise<ChannelMessage[]> {
    const rows = this.database
      .query(
        `SELECT * FROM channel_messages
         WHERE channel_id = ?
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(channelId, limit) as unknown as ChannelMessageRow[];

    return rows.reverse().map(toChannelMessage);
  }

  async getDailyRealUsage(day: string): Promise<number> {
    const row = this.database
      .query("SELECT count FROM daily_usage WHERE day = ?")
      .get(day) as { count: number } | null;

    return row?.count ?? 0;
  }

  async incrementDailyRealUsage(day: string): Promise<number> {
    this.database
      .query(
        `INSERT INTO daily_usage (day, count)
         VALUES (?, 1)
         ON CONFLICT(day) DO UPDATE SET count = count + 1`
      )
      .run(day);

    return this.getDailyRealUsage(day);
  }
}

function toChannelMessage(row: ChannelMessageRow): ChannelMessage {
  return {
    id: row.id,
    channelId: row.channel_id,
    ts: row.ts,
    threadTs: row.thread_ts,
    authorType: row.author_type,
    authorId: row.author_id,
    authorName: row.author_name,
    authorAgentId: row.author_agent_id,
    text: row.text,
    createdAt: row.created_at
  };
}
