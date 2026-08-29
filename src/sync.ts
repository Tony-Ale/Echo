import { SupabaseSyncCoordinator } from "./agent/services/syncCoordinator.js";
import { initSync } from "./sync/createSyncEngine.js";

async function runSync(): Promise<void> {
  try {
    const coordinator = new SupabaseSyncCoordinator(initSync());
    const result = await coordinator.syncIfStale({ reason: "Standalone synchronization command.", force: true });
    console.log(result.summary);
  } catch (error) {
    console.log(error, "Synchronization failed");
    process.exitCode = 1;
  }
}

void runSync();
