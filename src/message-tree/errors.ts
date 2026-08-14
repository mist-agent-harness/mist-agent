/**
 * 消息树的拒绝出口 —— 故意只有一种。
 *
 * 跨房 nodeId 和真不存在的 nodeId 用同一个类、同一句文案拒绝：
 * 错误若可区分，「存在但不是你的」就成了 node-id 存在性探针，
 * 隔离反而漏了一条缝（会议室 20e54efd 六楼裁定，M0 口径）。
 * 将来若主笔拍板要区分 forbidden/missing，在这里加，不在调用点散写。
 */

/** 统一文案：对住户外的世界，「没有」和「不是你的」长得一模一样。 */
export const NODE_UNAVAILABLE = "节点不可及";

/** 房间级失败（住户不存在 / 重复建房）与节点级失败共用这一个类。 */
export class MessageTreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MessageTreeError";
  }
}

/** 节点级拒绝的唯一构造口：保证文案不因调用点分叉。 */
export function nodeUnavailable(): MessageTreeError {
  return new MessageTreeError(NODE_UNAVAILABLE);
}
