# WebUI 视觉与动效规范

本文固定 Web UI 的形状、状态和过渡规则。颜色、间距、圆角与动效的数值权威位置是
[`web/src/styles.css`](../web/src/styles.css) 的 `:root` token；本文只写规则、状态与验收方法，不复制 token 表。

## 圆角

- 圆角阶梯：`--radius-sm` / `--radius-md` / `--radius-lg` 分别用于内嵌小件、控件、表面；`--radius-full` 只用于胶囊和圆点。数值与语义见 `styles.css` 的 `:root` 注释。
- 嵌套贴角：内层半径 = 外层半径 − 贴边距离（外层 padding + border），两边共用圆心。不要把内外层都写成同一个 `--radius-lg`。
- 浏览器支持时，全局 `@supports (corner-shape: squircle)` 统一启用连续曲率；胶囊（chip、provider tag、状态 pill）和圆点保持 `corner-shape: round`。

## Provider / 模型面板的底盖

Provider 面板与触发按钮共用一条外轮廓。面板展开期间，触发按钮不再是胶囊，而是面板的底盖（向上展开）或顶盖（向下展开）：

| 面板方向 | 展开时按钮的 `border-radius`（TL TR BR BL） | 收起后 |
| --- | --- | --- |
| `up`（从输入框向上长） | `0 0 var(--radius-lg) var(--radius-lg)` | 15px（胶囊） |
| `down`（向下展开） | `var(--radius-lg) var(--radius-lg) 0 0` | 15px（胶囊） |

- 两侧共用 28px 圆弧：按钮底角与面板底角的外沿、圆心重合，底部只能看到一条弧。
- 按钮通过 `data-cap="up" | "down"` 暴露该状态；面板开始关闭（`closing`）时属性立即移除，按钮同时开始回胶囊。
- **补间起点必须是 15px**（约等于 30px 控件高的一半），不能从 `--radius-full`（999px）起步：计算半径在过渡的大部分时间里都会被钳在 15px，视觉上等于最后几毫秒突然跳变。
- 展开用 `--motion-expand` + `--ease-out`（与面板入场同长），收起用 `--motion-base` + `--ease-out`；四个角走同一条曲线、同时到达（评审方案 V1“同步补间”），不做顶角先平、底角延迟的分段过渡。开、合时长不同，靠目标状态的 `transition` 声明区分。
- 面板宽度跟随按钮：按钮横向 padding 为 `calc(0.7em + var(--space-2))`（左右各多 8px，面板约 220px），让最长行（模型名 + meta + 勾选）留有约 16px 余量。行 `title` 用 `模型名 · meta`，因为行仍可能被省略。
- 面板从按钮边缘长入：`clip-path` 从按钮高度那条边补间到 `inset(0)`；关键帧必须显式写 `to`（补间到 `none` 在 Chromium 不插值）。动画结束后组件置 `data-revealed` 去掉 clip，恢复面板阴影；关闭时先清 `data-revealed`，再反向收回到按钮高度。

## 动效

- 时长令牌：`--motion-fast` / `--motion-base` / `--motion-expand` / `--motion-slide`；缓动令牌：`--ease-out` / `--ease-spring`。
- 浮层（面板、菜单、弹窗）入场走 `surface-in` 或 `provider-panel-*`；provider 面板的 220ms 揭示、圆角补间与盒子阴影恢复必须落在同一段动画里。`prefers-reduced-motion` 由全局规则统一降到 0.01ms，不为单个组件重复实现。
- 只动画颜色、圆角、透明度和 transform；不要动画按钮宽高——输入框行内的尺寸变化会推开相邻控件。

## 状态与可访问性

- 触发按钮保留 `aria-expanded`、`aria-controls`、`aria-activedescendant`；`data-cap` 只服务视觉，不进入可访问性名称。
- 键盘焦点环沿用全局 `outline: 2px solid var(--focus-ring)` + `outline-offset: 3px`；形状变化不能改变按钮的焦点区域。

## 验收

- 展开后截图（125% 缩放）确认按钮底角与面板底角只有一条弧、没有并排的两条边；收起后按钮恢复胶囊，接缝处没有残留方角。
- 展开过程能看到面板从按钮边缘长出（不是纯淡入），动画结束后面板阴影完整、没有被 `clip-path` 裁掉。
- 键盘展开、`Esc` 关闭、点选模型三条路径都要走同一段圆角过渡；关闭过程中不能出现面板的 28px 角露在按钮外面。
- 前端改动运行 `pnpm typecheck`、`pnpm test`、`pnpm build`。

## 已知取舍

- 入场动画的 220ms 内面板阴影随 `clip-path` 被裁，动画结束才恢复；关闭开始时阴影也会先被裁掉。这是用 `clip-path` 做揭示的代价。
- 行仍以省略号兜底（模型名 + meta + 勾选过长时），`title` 提供“模型名 · meta”的完整信息。
