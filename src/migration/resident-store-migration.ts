/** P1 ResidentStore 与 P2 MessageTreeStore 对 P5 迁移服务的窄适配口。 */

import type { MessageTreeStore } from "../message-tree/store.ts";
import type { ResidentStore } from "../store/resident-store.ts";
import {
  type ResidentImportM0,
  type ResidentMigrationPort,
  ResidentMigrationService,
} from "./resident-migration.ts";

export class ResidentStoreMigrationPort implements ResidentMigrationPort {
  constructor(
    private readonly store: ResidentStore,
    private readonly tree: MessageTreeStore,
  ) {}

  async snapshotResident(residentId: string) {
    const snapshot = this.store.exportRoom(residentId);
    return {
      residentId,
      resident: { name: snapshot.name, createdAt: snapshot.createdAt },
      commitments: snapshot.commitments,
      memories: snapshot.memories,
      history: this.tree.exportTree(residentId),
    };
  }

  /**
   * 先让 P1 原子导入房（树不进 P1，nodes 传空数组），再把 history 写入 P2。
   *
   * importTree 失败时 destroyResident 拆掉刚导的 P1 房，并拆掉本方法 createRoom
   * 建出的 P2 空房，再向上抛。这是同进程 M0 补偿式回滚，不是分布式事务：
   * 两家 store 没有共享提交；P1 已成功的水位（id/时间戳）不会退回。
   */
  async commitImportedResident(snapshot: ResidentImportM0): Promise<string> {
    const residentId = this.store.importRoom(
      {
        name: snapshot.resident.name,
        createdAt: snapshot.resident.createdAt,
        commitments: snapshot.commitments,
        memories: snapshot.memories,
        nodes: [],
      },
      { sourceResidentId: snapshot.sourceResidentId },
    );

    let treeRoomCreated = false;
    try {
      this.tree.createRoom(residentId);
      treeRoomCreated = true;
      this.tree.importTree(residentId, snapshot.history);
      return residentId;
    } catch (error) {
      this.store.destroyResident(residentId);
      if (treeRoomCreated) {
        this.tree.destroyRoom(residentId);
      }
      throw error;
    }
  }
}

export function createResidentMigrationService(
  store: ResidentStore,
  tree: MessageTreeStore,
): ResidentMigrationService {
  return new ResidentMigrationService(new ResidentStoreMigrationPort(store, tree));
}
