# 验收清单：有意的隔离第一刀（B1＋B3）

对应 issue #108 与总单 #66。B5 的重开语义仍等主笔拍 Q2，本页不施工、
不点亮 B5。判卷从生产模块的公开 `IntentionalIsolation.create` 进入，并用
真实 `MessageTreeService.say` 走模型开工链；直接手拼 scope 或只调用 presence
store 不算交卷。

- [x] **IS-B1 可开可进**：从一扇现役来源 viewport 创建隔离 session；只有住户
  身份存在、新 viewport 建立、住户级共享状态登记全部成功后才返回 `ready`。
  来源窗无效、住户不存在、名称为空或登记失败均显式拒绝；登记失败不会留下可接收
  用户输入的活窗。[单测＋宿主子进程集成]
- [x] **IS-B3 存在可知、内容不通**：创建返回时共享状态已同步可见；创建发生在
  另一扇 viewport 正在生成期间时不改变或打断该回合，只有下一次 dispatch 收到
  只含名称、状态、scopeId 与来源的存在信封。信封不写进 user transcript，失败回合
  不确认，下一轮重送；成功确认后不重复注入。[单测＋宿主子进程集成]

## 未在本页声称

- B5：scopeId 重开、scopeGeneration 与旧代回执拒收；Q2 未拍，保持未施工。
- B1a 携带包、working folder 原子创建；属于第二刀。
- B2 内容／文件／工具／进程隔离；本页只保证存在信封不夹带局部内容。
- #79 的 window generation：本页不修改 SessionRegistry 的 windowId/generation
  语义，也不拿它冒充 scopeGeneration。
