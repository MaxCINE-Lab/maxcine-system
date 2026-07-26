# MaxCINE Design System V1

后台视觉令牌集中在 `apps/web/src/theme.ts`，启动时由 `installTheme()` 写入 CSS 自定义属性。新增或修改后台样式时，应优先使用 `--mc-*` 变量，而不是在组件或样式中重复写入视觉值。

## 基础令牌

- 导航：`navigation`、`navigationHover`、`navigationActive`
- 页面与表面：`canvas`、`surface`、`surfaceMuted`
- 文本与边框：`text`、`textSecondary`、`placeholder`、`border`、`borderStrong`
- 反馈：`success`、`warning`、`danger`、`info` 及对应 surface
- 尺寸：`spacing`、`radius`、`typography`、`shadow`

## 组件约定

- 输入框和下拉框统一为 44px 高、白底、深色文字；多行输入框保留更高的可读编辑区域。
- 按钮使用 `.button`、`.button--secondary`、`.button--danger` 和 `.button--link`。
- 内容分区使用 `.panel`；列表使用 `.table-wrap`；状态使用 `.status`；空与加载状态使用 `.empty-state`、`.loading-state`。
- 后台页面遵循：面包屑（需要时）→ 页面标题与说明 → 操作区 → 卡片分区。

## 响应式规则

桌面端保留固定侧栏；980px 以下侧栏改为抽屉，通过“菜单”打开。工具栏、筛选区和 GSX 快捷入口会在窄屏垂直排列，表格保持可横向浏览。
