# lint 执行环境记录（大审④ lint 项）

`pnpm run lint`（oxlint 1.76.0，经 `scripts/run-oxlint.ts`）在 LA 生产 VPS 上无法运行：

```
thread 'tokio-rt-worker' panicked at crates/oxc_allocator/src/pool/fixed_size.rs:112:67:
called `Result::unwrap()` on an `Err` value: ()
（RUST_BACKTRACE=1 全文与环境见维护145票楼附件 oxlint-crash-evidence.txt）
```

环境：Linux 6.17.0-20-generic · AMD EPYC 9654 · **2 vCPU / 3.8G RAM**（DMIT 小机）· Node 22.21.1。
`--threads 2`、缩小扫描范围均无效——崩在启动期固定尺寸分配池预留，疑与小内存/虚拟内存预留限制相性。

结论：lint 门走 **GitHub Actions CI**（`.github/workflows/ci.yml`，ubuntu-latest 标准 runner）执行；本机不豁免 lint，只是换执行环境。CI 若同样崩溃则降版本另议（届时更新本文）。
