import "@anthropic-ai/claude-agent-sdk";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";

declare module "@anthropic-ai/claude-agent-sdk" {
  export type SessionStoreKey = {
    projectKey: string;
    sessionId: string;
    subpath?: string;
  };

  export class InMemorySessionStore {
    constructor();
    append(key: SessionStoreKey, entries: ReadonlyArray<unknown>): Promise<void>;
    load(key: SessionStoreKey): Promise<unknown[] | null>;
    delete(key: SessionStoreKey): Promise<void>;
    list(projectKey: string): Promise<Array<{ sessionId: string; mtime: number }>>;
    listSubkeys(key: SessionStoreKey): Promise<string[]>;
    clear(): void;
    readonly size: number;
  }

  export function getSessionMessages(
    sessionId: string,
    options: {
      sessionStore: InMemorySessionStore;
      dir?: string;
      limit?: number;
      offset?: number;
      includeSystemMessages?: boolean;
    },
  ): Promise<SessionMessage[]>;
}
