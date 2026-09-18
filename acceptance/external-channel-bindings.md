# 外部信道住户绑定验收（#172 / D20）

本页把 D20 和 issue #172 的出口条件翻成可重复执行的判据。正式命令：

```bash
npm run acceptance:external-channel
```

验收使用仓库里的真实 `SessionRegistry`、耐久绑定账、耐久入站账和
`PluginTransactionHost`，在临时目录从头装配；不连接 Telegram，不读取私人消息。

## EC-A　独立绑定账

- [ ] **EC-A01**　绑定的权威键是 `(residentId, scopeId)`，一个键可登记多个外部信道；
  绑定记录与持久化事件不含 `windowId` 或 session id。
- [ ] **EC-A02**　同一外部地址不能同时解析到两个住户 scope；冲突显式拒绝。
- [ ] **EC-A03**　撤销先落审计事件再改变当前视图；重启后撤销仍成立，住户身份数据不变。

## EC-B　无窗队列

- [ ] **EC-B01**　无活窗时返回 `queued` 真回执，回执含排队时间与到期时间，不声称已派发。
- [ ] **EC-B02**　条数上限与最长等待时间是构造时必填参数；满队列拒收并返回
  `QUEUE_FULL`，过期条目记为 `expired`，两者均可查。
- [ ] **EC-B03**　排队条目不进入住户记忆账；开窗前也不出现在 scope 已投递事实视图。
- [ ] **EC-B04**　住户开窗后，未过期条目按入站顺序自动交付，不要求重绑、重发或手动点火。

## EC-C　scope 事实与回应权分离

- [ ] **EC-C01**　一条入站消息只落一条 scope 事实；同 scope 的每扇活窗读取到同一事实。
- [ ] **EC-C02**　每条事实恰好签发一枚回应资格；资格使用 MV-B03 的六字段
  `(residentId, scopeId, scopeGeneration, windowId, generation, dispatchId)`。
- [ ] **EC-C03**　多活窗时选择最近活跃窗；这条平局规则与事实可见性分开测试。
- [ ] **EC-C04**　重复外部 message id 不重复落事实，也不签发第二枚回应资格。

## EC-D　生命周期与代谢

- [ ] **EC-D01**　换气、`kill(windowId)` 后重开、宿主重启、同住户多开四条路径均不修改绑定，
  下一条入站消息现场解析当前窗与 generation。
- [ ] **EC-D02**　信道通过 `PluginTransactionHost` 登记 `connection` 资源；插件 active 后才可入站，
  dispose 后立即拒绝新入站。
- [ ] **EC-D03**　宿主重启从同一绑定账和入站账恢复；旧活窗不复活，排队消息在新窗打开后自动交付。

本单没有引入向窗口主动推送的产品通道。MV-C02 的保留边界继续成立；本验收只建立
scope 事实读取与回应资格，不把事实直接推入窗口上下文。
