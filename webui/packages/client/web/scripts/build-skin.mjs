#!/usr/bin/env node
/**
 * mist 素皮生成器 —— skin.config.json 是界面长相的唯一真源（#49 验收：
 * 「界面长相由皮肤配置文件说了算」）。构建期从配置生成两份产物：
 *
 *   1. src/mist-skin.css    色板段（重定义上游 deepseek 色阶）+ 字体段，
 *                           boot.tsx 在 base.css 之后引入，层叠取胜。
 *   2. src/skin-wordmark.ts 字标段，AppRoot loading 皮的运行时消费口。
 *
 * 产物随仓提交：lane 测试直接 import boot.tsx / AppRoot.tsx，不依赖先构建。
 * 改皮肤 = 改 skin.config.json 后跑 `npm run build:skin`（根 build / dev:web
 * 入口已挂本脚本）；`--check` 只校验产物是否与配置一致（漂移即非零退出），
 * 不落盘。配置形状非法时 fail loud，不产出半个文件。
 *
 * palette 段有全集门（大审 P2）：档位必须恰好覆盖 design-platform.css 实读
 * 出的上游 deepseek 色阶全集——缺档会让该变量回退成上游品牌色值（素皮破相），
 * 多档是没有消费方的配置幻觉。`--config <path>` 是负测缝：用篡改配置真跑
 * 生成器验证门本身（校验先于任何写盘，负测不会污染产物）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 上游色阶全集的锚：ui-theme 的 design-platform.css（冻结树内实数 = 11 档）。 */
const PLATFORM_CSS_URL = new URL('../../ui-theme/src/styles/design-platform.css', import.meta.url)

// --config <path>：测试缝（负测用篡改配置真跑生成器）；缺省读包内配置。
const configFlagAt = process.argv.indexOf('--config')
const CONFIG_URL = configFlagAt > -1 && process.argv[configFlagAt + 1]
  ? pathToFileURL(process.argv[configFlagAt + 1])
  : new URL('../skin.config.json', import.meta.url)
const CSS_URL = new URL('../src/mist-skin.css', import.meta.url)
const WORDMARK_URL = new URL('../src/skin-wordmark.ts', import.meta.url)

/**
 * 上游 deepseek 色阶全集（从 design-platform.css 实读，不抄字面量——sheet 动了这里跟着变）。
 * 这是 palette 段的准入线：缺档 → 该变量回退成 sheet 里的上游 DeepSeek 色值（素皮破相，
 * 小g 大审 P2），多档 → 配置幻觉（写了没消费方的档）。缺/多都 fail loud 报具体 stop。
 */
function requiredStops() {
  const css = readFileSync(PLATFORM_CSS_URL, 'utf8')
  const stops = [...new Set([...css.matchAll(/--dsw-static-deepseek-([\w-]+):/g)].map(([, stop]) => stop))]
  if (stops.length === 0) throw new Error('design-platform.css 里读不到 --dsw-static-deepseek-* 色阶（冻结树结构变了？）')
  return stops
}

/** 读取并校验皮肤配置；任何字段形状非法都直接抛错（fail loud）。 */
function loadConfig() {
  const config = JSON.parse(readFileSync(CONFIG_URL, 'utf8'))

  const palette = config?.palette
  if (palette === null || typeof palette !== 'object' || Array.isArray(palette) || Object.keys(palette).length === 0) {
    throw new Error('skin.config.json: palette 必须是非空对象（色阶档位 → #rrggbb）')
  }
  const required = requiredStops()
  const stops = Object.keys(palette)
  const missing = required.filter(stop => !stops.includes(stop))
  const extra = stops.filter(stop => !required.includes(stop))
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `skin.config.json: palette 必须恰好覆盖上游色阶全集——缺档 [${missing.join(', ') || '无'}] 多档 [${extra.join(', ') || '无'}]`
      + '（缺档回退上游品牌色值、多档无消费方，两者都禁）',
    )
  }
  for (const [stop, hex] of Object.entries(palette)) {
    if (typeof hex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(hex)) {
      throw new Error(`skin.config.json: palette["${stop}"] 必须是 #rrggbb 形式，收到 ${JSON.stringify(hex)}`)
    }
  }

  const fonts = config?.fonts
  for (const key of ['sans', 'mono']) {
    if (typeof fonts?.[key] !== 'string' || fonts[key].trim() === '') {
      throw new Error(`skin.config.json: fonts.${key} 必须是非空字符串（font-family 栈）`)
    }
  }

  if (typeof config?.wordmark !== 'string' || config.wordmark.trim() === '' || /[\r\n]/.test(config.wordmark)) {
    throw new Error('skin.config.json: wordmark 必须是单行非空字符串')
  }

  return { palette, fonts: { sans: fonts.sans, mono: fonts.mono }, wordmark: config.wordmark }
}

/** #rrggbb → "r, g, b"（rgb() 函数体内）。 */
function hexToRgb(hex) {
  return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(', ')
}

/**
 * 色阶档位排序键：按前导数字升序（700-delete 归 700 与 800 之间）。
 * 不能靠 Object.entries 顺序——JS 把整数形态键提前重排，"700-delete"
 * 这类带后缀的键会被甩到所有数字键之后。
 */
function stopSortKey(stop) {
  const match = /^(\d+)/.exec(stop)
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY
}

/** 由配置渲染 mist-skin.css 全文。注释里的机制说明随生成物走，审 CSS diff 时自解释。 */
function renderCss({ palette, fonts }) {
  const stops = Object.entries(palette)
    .sort(([a], [b]) => stopSortKey(a) - stopSortKey(b) || a.localeCompare(b))
    .map(([stop, hex]) => `  --dsw-static-deepseek-${stop}: rgb(${hexToRgb(hex)});`)
    .join('\n')

  return `/* GENERATED FROM skin.config.json by scripts/build-skin.mjs —— 请勿手改。
 * 改皮肤请改配置后跑 npm run build:skin（根 build / dev:web 已挂生成钩）。
 *
 * mist 素皮 · 品牌 accent 换色层
 *
 * 上游 dsh 的品牌色全走 --dsw-static-deepseek-* 色阶：alias 层的按钮/业务
 * 主色指向它，ChatView 的 shimmer 渐变和 StateDot 的进行中点也直读它。
 * 自定义属性按层叠取胜，本表由 boot.tsx 在 base.css 之后引入，把整条
 * deepseek 色阶重定义为雾灰蓝（保持各档明度角色不变，深浅的语义映射
 * 在暗色块里自动跟随），一次换色覆盖所有消费方，组件零改动。
 *
 * 不从 base.css @import：该表有契约测试（base-styles.client.spec）要求
 * 每个 sheet 都来自 ui-theme 包。本表是 shell 自有的 fork 皮肤层，
 * 不进上游 token 包；归属桶（包名/LICENSE/注释）原样保留。
 */
body {
${stops}

  /* 字体两段：初值与 base.css 的 :root 默认一致（视觉零变化），改配置
     即全局换字体；body 比 :root 继承链更近，同值定义即接管所有权。 */
  --dsw-font-family: ${fonts.sans};
  --ds-font-family-code: ${fonts.mono};

  /* 品牌藏青标题色退化为普通主文字色（素皮不留品牌色相）；
     label-primary 本身随明暗主题切换，本行两主题通用。 */
  --dsw-alias-label-primary-bluish: var(--dsw-alias-label-primary);
}

/* 暗色块在 body[data-ds-dark-theme] 上重定义过 label-primary-bluish
   （specificity 0,1,1 高于上面的 body 行），这里同权重后手压掉。 */
body[data-ds-dark-theme] {
  --dsw-alias-label-primary-bluish: var(--dsw-alias-label-primary);
}
`
}

/** 由配置渲染 skin-wordmark.ts 全文。 */
function renderWordmark({ wordmark }) {
  return `/* GENERATED FROM skin.config.json by scripts/build-skin.mjs —— 请勿手改。
 * 字标段的运行时消费口：AppRoot loading 皮字标。 */
export const SKIN_WORDMARK = ${quoteWordmark(wordmark)}
`
}

/** 单引号字面量（@stylistic/quotes 要 single；JSON.stringify 出双引号过不了 lint）。 */
function quoteWordmark(value) {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

const config = loadConfig()
const outputs = [
  [CSS_URL, renderCss(config)],
  [WORDMARK_URL, renderWordmark(config)],
]

if (process.argv.includes('--check')) {
  const drift = outputs
    .filter(([url, text]) => readFileSync(url, 'utf8') !== text)
    .map(([url]) => fileURLToPath(url))
  if (drift.length > 0) {
    console.error(`skin 产物与 skin.config.json 漂移：\n  ${drift.join('\n  ')}\n跑 npm run build:skin 重新生成。`)
    process.exit(1)
  }
  console.log('skin 产物与配置一致。')
} else {
  for (const [url, text] of outputs) writeFileSync(url, text)
  console.log(`skin 已生成：${outputs.map(([url]) => fileURLToPath(url)).join(', ')}`)
}
