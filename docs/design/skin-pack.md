# mist 皮肤包协议 v0（草案）

2026-08-14 望舒起草。起因：群友提议 web ui 的自定义皮肤「开个口子可拓展就行，弄个协议或 JSON 配置格式，大家按格式让 AI 随便弄」。这份草案把这句话落成格式。

## 0. 三条定调

1. **皮肤是数据，不是代码。** 皮肤包只允许声明式 token 和白名单资源，不允许任意 CSS/JS。群友拿 AI 生成皮肤的前提是「生成错了也坏不到哪去」——一个 JSON 最坏情况是丑，不能是 XSS 载体。
2. **皮肤只改皮，不改信息架构。** mist 首页是住户状态（谁醒着/第几次醒来/上次心跳），这个结构不归皮肤管。皮肤管颜色、字体、质感、装饰、动效。
3. **AI 是一等作者。** schema 的每个字段带中文 description，仓库附带示例皮肤和一张「喂给 AI 的提示卡」，让「随便弄」有下限。

## 1. 包形态

一个皮肤 = 一个目录：

```
my-skin/
  skin.json        # 必需，全部声明都在这
  assets/          # 可选，图片/字体文件，相对路径引用
    hero.png
    paper-texture.jpg
```

两种分发方式：

- **整包**：目录 zip 或 git 仓库，适合带素材的精致皮肤。
- **单文件**：只有一个 skin.json，素材全部用 HTTPS URL 或 data URI 内联，适合 AI 即生成即用、粘贴导入。

## 2. skin.json 格式

```jsonc
{
  "spec_version": "0.1",
  "id": "yue-mo",                 // 小写字母数字连字符，全局唯一
  "name": "月墨",
  "author": "望舒",
  "version": "1.0.0",
  "min_app_version": "0.1.0",
  "description": "宣纸底，墨骨，梅粉点缀。",

  "slots": {                      // 日/夜双槽，可只给 day
    "day":   { "tokens": { /* ... */ } },
    "night": { "tokens": { /* ... */ } }
  },

  "tokens": {                     // 不在 slots 里的 token 是公共底座
    "color": {
      "bg":        "#f7f3ea",     // 必填：页面底
      "surface":   "#fffdf6",     // 必填：卡片/气泡底
      "fg":        "#2b2b2b",     // 必填：主文字
      "fg_muted":  "#8a8578",
      "accent":    "#c45f6e",     // 必填：强调色
      "border":    "#e3dccb",
      "danger":    "#b3402f"
    },
    "font": {
      "body":      "\"Noto Serif SC\", serif",
      "heading":   "\"Noto Serif SC\", serif",
      "mono":      "\"JetBrains Mono\", monospace",
      "scale":     1.0            // 全局字号倍率 0.85–1.25
    },
    "shape": {
      "radius":    "10px",
      "border_width": "1px"
    },
    "texture": {
      "type":      "image",       // none | noise | image
      "image":     "assets/paper-texture.jpg",
      "opacity":   0.35
    },
    "decor": {
      "hero":      "assets/hero.png",   // 首页/空状态主视觉
      "motif":     "none"               // 预留：内置装饰母题名
    },
    "motion": {
      "level":     "standard"     // none | reduced | standard
    }
  },

  "surfaces": {                   // 可选：按界面分区覆盖 token
    "chat":    { "color": { "surface": "#fdf8ee" } },
    "sidebar": { "color": { "bg": "#efe9db" } }
  }
}
```

规则：

- `color.bg` / `color.surface` / `color.fg` / `color.accent` 四个必填，其余缺省回落到内置默认皮。
- `slots.night` 存在时 app 按系统深浅色或用户手动切换；不存在则日夜同皮。
- `surfaces` 的分区名是闭集（chat / sidebar / resident-status / settings），随 spec 小版本扩充；写错名字校验报警告但不拒装。
- 所有相对路径只在包内解析，`..` 直接拒装。远程资源只准 HTTPS。

## 3. 渲染层怎么挂（对 M1 的接口要求）

- 前端只设一个 `SkinProvider`：启动时加载内置默认皮的 token 为 CSS 变量（`--mist-color-bg` 这种命名），用户皮肤进来做深合并（公共底座 ← slot ← surfaces），再整体替换变量。
- 组件一律消费 CSS 变量，不硬编码色值。这条是皮肤的承重墙，写进 M1 图纸。
- 纹理和 hero 以 `<img>`/background-image 挂，失败静默回落无底图，不阻塞渲染。
- 字体 URL 走 CSP 白名单（fonts.googleapis.com 等），包内字体文件随包加载。

## 4. 安装与校验

- 入口三个：本地文件拖入 / 粘贴单个 JSON / 输入 URL。
- 安装前过 JSON Schema 校验：spec_version 不兼容、必填缺失、路径越界，拒装并给出人话错误。
- 未知字段一律忽略（向前兼容），warning 列表在「关于这个皮肤」里可见。
- 皮肤存在本地，不进账号同步（v0 不做）。

## 5. 给 AI 作者的提示卡（随仓库附）

一段固定文案，大意：「这是 mist 皮肤协议的 JSON Schema 和两个示例。请生成一个符合 schema 的 skin.json，只用已声明的字段，颜色给足四个必填项，风格要求如下：______。」schema 的 description 写得够细，AI 不需要看第二份文档。

## 6. 明确不做（v0 边界）

- 不做任意 CSS 注入口子。等真有人被 token 体系憋死，再议受控扩展（比如白名单属性级 CSS），v0 不开。
- 不做皮肤市场/在线索引。群友先靠 repo 目录和群文件流转。
- 不做 per-住户皮肤（不同住户不同皮）。M7 住户感真长到那一步再说。

## 7. 和 mist 图纸的对齐

- 挂点是 M1（平台与客户端），但 token 闭集和「组件只消费变量」的纪律要在 M1 动工前先钉进图纸，否则后补皮肤等于重做前端。
- 「皮肤是数据不是代码」与原则里的证据纪律同构：可校验、可回落、可审计。
- 若 #8 的 Capability Contract 落地，皮肤安装动作可以挂成 effect=read 级别的能力，不占权限闸预算。
