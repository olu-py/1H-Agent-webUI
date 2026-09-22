import type { MemoryDto } from "../types";
import type { Transport } from "../transport/transport";
import type { Store } from "../state/store";
import { errorMessage } from "./shared";

export function createMemoryActions(transport: Transport, store: Store) {
  const loadMemories = async (query?: string, includeDeleted = false): Promise<void> => {
    try {
      store.dispatch({ type: "memories", memories: await transport.memories(query, includeDeleted) });
    } catch (error) {
      store.dispatch({ type: "error", message: errorMessage(error) });
    }
  };

  const saveMemory = async (title: string, content: string, candidate = false): Promise<MemoryDto | null> => {
    try {
      const memory = await transport.saveMemory(title, content, candidate);
      await loadMemories(undefined, true);
      return memory;
    } catch (error) {
      store.dispatch({ type: "error", message: errorMessage(error) });
      return null;
    }
  };

  const confirmMemory = async (id: number): Promise<void> => {
    try {
      await transport.confirmMemory(id);
      await loadMemories(undefined, true);
    } catch (error) {
      store.dispatch({ type: "error", message: errorMessage(error) });
    }
  };

  const updateMemory = async (id: number, title: string, content: string): Promise<void> => {
    try {
      await transport.updateMemory(id, title, content);
      await loadMemories(undefined, true);
    } catch (error) {
      store.dispatch({ type: "error", message: errorMessage(error) });
    }
  };

  const deleteMemory = async (id: number): Promise<void> => {
    try {
      await transport.deleteMemory(id);
      await loadMemories(undefined, true);
    } catch (error) {
      store.dispatch({ type: "error", message: errorMessage(error) });
    }
  };
  return { loadMemories, saveMemory, confirmMemory, updateMemory, deleteMemory };
}
