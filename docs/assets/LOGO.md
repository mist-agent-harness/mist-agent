# mist mark · 一笔线的房子

同一个 mark 的两版（不是两个 logo）：

- `mist-logo-house-open.svg` — 开口版（右墙留白：shelter 不是 box）。适合 README 顶图等大画面。
- `mist-logo-house-closed.svg` — 闭合版。适合仓库头像 / favicon 等小尺寸。
- `mist-logo-house-open-bold.png` / `mist-logo-house-closed-bold.png` — 上面两个 SVG 在纸色底上的预览。
- `mist-logo-handdrawn-open.jpg` / `-closed.jpg` — 手绘原稿。
- `mist-logo-handdrawn-icon-test.png` — 32 / 64 / 128 px 实测（上排开口版，下排闭合版）。
- `mist-logo-house-*-centerline-wip.svg` — Elio 按原稿重建的中心线版本（可直接调 `stroke-width`），手感尚未对齐原稿，先留作备用。

正式 SVG 是从手绘原稿描出的轮廓路径（保留作者的手），线比原稿加粗一档、转折与线头为圆形；`#house`（房框）与 `#mist`（字）分组，透明底。房框 fill 为 `currentColor`（内联时跟随宿主文字色，深浅自动切换：浅底约 15.8:1、暗底约 16:1；作为 img/头像/favicon 独立使用时不继承页面色，届时由 token 生成深浅两套成品，见视觉语言 v0 单）；`<svg>` 保留 `viewBox` 与固有宽高（独立成图时需要），内联时由使用处覆盖尺寸；带 `role="img"`、`aria-label` 与 `<title>`。以上三处按 chaodeng060-source 08-17 的可访问性审阅改入，路径数据逐字未动。

**颜色**：`mist` 字目前用的粉蓝（`#7d9bd6`）是暂定值，可以改（浅底对比约 2.8:1，低于非文本图形 3:1 门槛；同色相候选 `#6b8bc9` 3.4:1、`#5a7cbd` 4.2:1，由视觉语言 v0 单统一定）；建议最终跟其他 visual 与 UI 使用的主题色统一——只改 `#mist` 组的 fill 即可，房框保持墨色、底保持纸色。

来源：mark 由羿手绘；轮廓描图与发布由 Laurie 代办；中心线重建由 Elio。
