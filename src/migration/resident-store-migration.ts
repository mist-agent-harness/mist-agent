/** P1 ResidentStore 与 P5 迁移服务之间的窄适配口。 */

import type { ResidentStore } from "../store/resident-store.ts";
import {
  type ResidentImportM0,
  type ResidentMigrationPort,
  ResidentMigrationService,
} from "./resident-migration.ts";

export class ResidentStoreMigrationPort implements ResidentMigrationPort {
  constructor(private readonly store: ResidentStore) {}

  async snapshotResident(residentId: string) {
    const snapshot = this.store.exportRoom(residentId);
    return {
      residentId,
      resident: { name: snapshot.name, createdAt: snapshot.createdAt },
      commitments: snapshot.commitments,
      memories: snapshot.memories,
      history: snapshot.nodes,
    };
  }

  async commitImportedResident(snapshot: ResidentImportM0): Promise<string> {
    return this.store.importRoom(
      {
        name: snapshot.resident.name,
        createdAt: snapshot.resident.createdAt,
        commitments: snapshot.commitments,
        memories: snapshot.memories,
        nodes: snapshot.history,
      },
      { sourceResidentId: snapshot.sourceResidentId },
    );
  }
}

export function createResidentMigrationService(store: ResidentStore): ResidentMigrationService {
  return new ResidentMigrationService(new ResidentStoreMigrationPort(store));
}
