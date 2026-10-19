# ExDiff

[English](README.md) | **简体中文**

[Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=xaxys.ExDiff) · [GitHub 源码](https://github.com/xaxys/exdiff-vscode)

在 VS Code 的 diff 视图里保留完整的语言功能：两边的旧版本和新版本都是磁盘上的真实文件，hover、Go to Definition、Find References、Find Implementations 和诊断（lint）在**左右两侧**都能正常工作。

## 为什么需要 ExDiff

VS Code 自带的 Git diff 把旧版本作为虚拟文档（`git:` scheme）打开。它不在磁盘上，也不属于任何工作区，因此语言服务器会忽略它：

- 没有 hover，没有 `F12`，没有 Find References；
- 没有 lint 或类型诊断；
- 无法在旧版本代码里跳转。

ExDiff 把每个 revision 物化成仓库内的真实快照，并把快照目录加入工作区。diff 的两侧都成为普通的 `file://` 文档，语言服务器会把旧版本当作正常源码来索引。

```
自带 diff：  [ 虚拟 git: 文档 ]  →  没有语言服务器  →  [ 工作区文件 ]
ExDiff：     [ 真实快照文件    ]  →  语言服务器 ✅  →  [ 工作区文件 ]
```

ExDiff 只读取 Git 对象，不会修改你的工作区、index、ref 或 reflog。

## 功能

- **两侧都有语言功能**：hover、Go to Definition、Find References、Find Implementations（语言服务器支持时）和诊断。
- **单 commit 分支**：与可配置的 base（默认 `HEAD~1`）比较，或精确比较 `HEAD~1 ↔ HEAD`。
- **适合 amend 工作流**：看清上一次 `git commit --amend` 到底改了什么。
- **Rebase 复盘**：`git range-diff` 的 commit 对和逐对 patch，包括冲突是怎么解决的。
- **只看已暂存**：`HEAD ↔ index`，不混入未暂存改动。
- **任意两个 ref**：分支、远程分支、tag、最近 commit、reflog 条目。
- **Changes 视图**：状态、增删行数、rename，自动刷新。
- **只读、离线**：无遥测、无网络请求、不在后台修改 Git 状态。

## 环境要求

- VS Code **1.85** 或更新版本。
- Git 在 `PATH` 中（或通过 `exdiff.gitPath` 指定）。
- 支持 multi-root workspace 的语言服务器。TypeScript/JavaScript、Go、Python 开箱可用；Rust、C/C++ 等见「限制」。

## 安装

- **Marketplace**：从 Visual Studio Marketplace 安装 [ExDiff](https://marketplace.visualstudio.com/items?itemName=xaxys.ExDiff)。
- **VSIX**：`code --install-extension exdiff-0.2.4.vsix`

安装后重载窗口。

## 快速开始

1. 在 VS Code 中打开一个 Git 仓库。
2. 打开一个文件，右键选择 **ExDiff: Open Changes with Base**（也可以从命令面板执行）。
3. 在左侧（旧版本）使用 hover、`F12` 或 `Shift+F12`。

第一次使用时，VS Code 会询问是否把快照目录加入工作区。选择 **Add** —— 这是旧版本能获得语言功能的关键。选择会被记住。

## 命令

| 命令 | 作用 |
|---|---|
| **ExDiff: Open Changes with Base** | 当前文件 vs `exdiff.baseRef` 与 `HEAD` 的 **merge-base（分叉点）**。默认 `auto` 会自动选择 base 分支。右侧由 `exdiff.rightSide` 决定：工作区或 `HEAD`。 |
| **ExDiff: Open Changes with Previous Amend** | `HEAD@{1}` vs 当前版本。适合刚执行完 `git commit --amend` 时使用。最后一次 reflog 不是 amend 时会先确认。 |
| **ExDiff: Open Changes with Previous Commit** | `HEAD~1` vs `HEAD`。只看最新一个 commit 改了什么，不受设置和未提交改动影响。 |
| **ExDiff: Open Changes with HEAD (uncommitted)** | `HEAD` vs 工作区，包含未暂存和未跟踪改动。 |
| **ExDiff: Open Changes with HEAD (staged only)** | `HEAD` vs index，只看已暂存改动。 |
| **ExDiff: Show Changed Files** | 聚焦当前仓库的 **Changes** 视图。 |
| **ExDiff: Compare Two Refs…** | 选择任意两个分支、tag、commit 或 reflog 条目，列出改动文件。 |
| **ExDiff: Show Rebase Changes** | 推断最近一次 rebase，显示 `git range-diff` 的 commit 对和逐对 patch。 |
| **ExDiff: Open Base Version of This File** | 把 base 版本作为普通编辑器打开，获得完整语言服务器能力。 |
| **ExDiff: Swap Sides** | 交换当前比较的左右两侧。 |
| **ExDiff: Set Base Ref…** | 选择 base 分支/ref（或 **Auto-detect**）并写入 `exdiff.baseRef`。 |
| **ExDiff: Refresh** | 重新读取 Changes / Rebase 视图。 |
| **ExDiff: Attach Snapshots** | 把已存在的快照目录加入工作区。 |
| **ExDiff: Detach Snapshots** | 从工作区移除快照目录，但不删除磁盘文件。用于消除 Find References 的重复结果。 |
| **ExDiff: Delete Snapshots** | 移除并删除该仓库的所有快照。 |
| **ExDiff: Prune Stale Snapshots** | 确认后删除超过 `exdiff.snapshotRetentionDays` 的快照。 |

### 命令入口

- **命令面板**：`Ctrl+Shift+P` 输入 `ExDiff`。
- **编辑器标题栏**：与 base 比较、打开 base 版本。
- **编辑器右键**：`ExDiff` 分组。
- **资源管理器右键**：文件上可「与 base 比较」。
- **Activity Bar**：ExDiff 图标打开 **Changes** 和 **Rebase Changes** 视图。

## 视图

### Changes

列出从分叉点（`exdiff.baseRef` 与 `HEAD` 的 merge-base）以来所有改动文件，显示状态（新增、修改、删除、rename…）、增删行数和 rename 映射。点击文件打开两侧都是真实文件的 diff。保存文件、窗口重新获得焦点、配置变化和 Git ref/index 变化时自动刷新。

### Rebase Changes

rebase 之后列出 `git range-diff` 报告的 commit 对：

| 标记 | 含义 |
|---|---|
| `=` | 未改动 |
| `!` | 被改写（patch 会显示改了什么，包括冲突解决） |
| `<` | 只存在于旧范围 |
| `>` | 只存在于新范围 |

选择某一对查看 patch，或打开完整 range diff。

## 设置

| 设置 | 默认 | 说明 |
|---|---|---|
| `exdiff.baseRef` | `auto` | base 分支或 revision。`auto` 会依次检测 `origin/HEAD`、`upstream/HEAD`、`origin/main`、`origin/master`、`upstream/main`、`upstream/master`、`main`、`master`，最后回退 `HEAD~1`。diff 从它与 `HEAD` 的 merge-base（分叉点）开始。 |
| `exdiff.snapshotDir` | `${repoRoot}/.exdiff` | 快照存放位置。支持 `${repoRoot}`、`${repoParent}`、`${repoName}`、`${slot}`。默认在仓库内，并带自忽略 `.gitignore`，`git status` 保持干净。删除仓库会一并删除它。 |
| `exdiff.autoAttach` | `ask` | 是否自动把快照目录加入工作区：`ask` / `always` / `never`。 |
| `exdiff.rightSide` | `workingTree` | diff 右侧：工作区（含未提交改动）或 `HEAD` 快照。 |
| `exdiff.gitPath` | `git` | Git 可执行文件路径。 |
| `exdiff.maxFilesInTree` | `2000` | Changes 视图最多列出的文件数。 |
| `exdiff.snapshotRetentionDays` | `7` | 超过天数的快照会被清理。启动时只自动清理临时的 `ref-*` 快照；Prune 命令会清理所有过期快照。`0` 关闭自动清理。 |

## 典型工作流

### 查看分支自分叉点以来的改动

`Open Changes with Base` 从 **分叉点**（`git merge-base <baseRef> HEAD`）开始比较，因此只显示你分支上的改动，不会混入分叉后 base 分支新增的 commit。

1. 运行 **ExDiff: Open Changes with Base**。
2. 左侧是分叉点的真实快照，右侧是你的工作文件。
3. 在任意一侧使用 hover、`F12`、Find References。

默认 `auto` 会依次尝试 `origin/HEAD`、`upstream/HEAD`、`origin/main`、`origin/master`、`upstream/main`、`upstream/master`、`main`、`master`，最后回退 `HEAD~1`。也可以把 `exdiff.baseRef` 明确设为 `origin/main`、`upstream/master` 等分支。

如果想忽略未提交改动，把 `exdiff.rightSide` 设为 `ref`。

### 精确查看最新 commit

运行 **ExDiff: Open Changes with Previous Commit**。它只比较 `HEAD~1` 和 `HEAD`，不受设置和未提交编辑影响。

### Amend 循环

1. `git commit --amend`。
2. 运行 **ExDiff: Open Changes with Previous Amend**。
3. 左侧是 amend 前的 commit（`HEAD@{1}`），右侧按 `exdiff.rightSide` 决定。

### Rebase 复盘

1. `git fetch upstream && git rebase upstream/master`。
2. 运行 **ExDiff: Show Rebase Changes**。
3. 打开某个 commit 对查看 patch 的变化。标记为 `!` 的 commit 被改写，通常是冲突解决导致的。

推断出的范围按仓库缓存在 `workspaceState`，重载窗口后仍可复盘。

### 只看已暂存改动

运行 **ExDiff: Open Changes with HEAD (staged only)**。index 通过 `git write-tree` 物化，未暂存改动不会出现。

### 比较任意 revision

运行 **ExDiff: Compare Two Refs…**，选择两个分支、tag、commit 或 reflog 条目。Changes 视图会切换到该比较。

## 工作原理

- ExDiff 用临时 index 和 `git checkout-index` 把 revision 物化到 `<repoRoot>/.exdiff/<快照>`。快照里没有 `.git`，不会被识别成另一个仓库。
- 通过 `vscode.workspace.updateWorkspaceFolders()` 把快照目录加入工作区，语言服务器才会索引它。
- revision 变化时增量更新快照；revision 不变时直接复用。
- `.exdiff` 自带 `.gitignore`，所以快照、sidecar 和临时文件不会出现在 `git status` 中。
- **base 比较**使用 `exdiff.baseRef` 与 `HEAD` 的 merge-base（分叉点），不会把 base 分支后来新增的 commit 混进来。
- ExDiff 不写你的工作区、index、ref 或 reflog。`git write-tree` 只会为 staged-only 比较写入一个不可达的 tree 对象。

## 限制

1. **Find References 重复**：快照和真实仓库都包含代码，引用会出现两次。不 review 时执行 **Detach Snapshots**。
2. **Multi-root 语言服务器**：TypeScript/JavaScript、Go、Python 表现良好。Rust（`linkedProjects`）、C/C++（`compile_commands.json`）和部分 JVM/Kotlin 语言服务器需要额外配置，跨快照跳转不保证。
3. **磁盘与内存**：每个快照约等于 tracked 文件大小，挂载多个快照会有多套 LSP 索引。用 **Detach Snapshots** 或 **Delete Snapshots** 回收。
4. **首次物化较慢**：大仓库首次需要全量 checkout；之后是增量更新，revision 不变时直接复用。
5. **子模块**：不会物化，快照中对应位置是空目录。
6. **单文件夹工作区**：第一次加入快照目录时，VS Code 可能重启扩展宿主（单文件夹工作区变成 multi-root 时的既定行为）。diff 标签会恢复；如果命令被中断，重跑一次即可。保存成 multi-root `.code-workspace` 可以避免。
7. **diff 编辑器本身的限制**：peek、部分 rename 重构和部分 code action 仍不如普通编辑器。需要完整能力时使用 **Open Base Version of This File**。
8. **快照是 disposable 的**：手动修改不会被检测到。需要时删除快照重新生成。
9. **清理**：启动时自动清理超过 `exdiff.snapshotRetentionDays`（默认 7 天）的临时 `ref-*` 快照；**Prune Stale Snapshots** 可清理所有过期快照。**Detach** 只改工作区，**Delete** 才删除磁盘文件。
10. **快照位于仓库内**：扫描整个工作树的工具（部分 linter、测试运行器、构建脚本）也可能访问 `.exdiff`。必要时把 `.exdiff` 加入它们的忽略配置，或用 `exdiff.snapshotDir` 把快照放到仓库外。

## 故障排查

| 现象 | 处理 |
|---|---|
| 旧版本一侧没有 hover / `F12` / 诊断 | 快照目录不在工作区。运行 **ExDiff: Attach Snapshots**，或把 `exdiff.autoAttach` 设为 `always`。 |
| 「当前文件不在 Git 仓库中」 | 文件不在任何仓库中，或仓库是 bare。确认 `git rev-parse --show-toplevel` 可用；Git 不在 `PATH` 时设置 `exdiff.gitPath`。 |
| 「找不到 base ref」 | 仓库没有父提交，或 `exdiff.baseRef` 无效。用 **ExDiff: Set Base Ref…** 选择 `HEAD`、分支或 commit。 |
| 「还没有提交」 | 先创建第一个 commit，再执行命令。 |
| Find References 出现两次 | 正常现象：快照和真实仓库各一次。review 结束后执行 **ExDiff: Detach Snapshots**。 |
| 快照内容与 revision 不一致 | 快照被手动修改过。运行 **ExDiff: Delete Snapshots**，重新打开 diff。 |
| 「无法把快照目录加入工作区」 | 工作区文件只读、目录已存在，或工作区不受信任。手动添加目录，或让工作区可写。 |
| **ExDiff: Show Rebase Changes** 检测不到 | 需要 `ORIG_HEAD` 和 `rebase (start)` reflog 条目。后续操作可能覆盖了 `ORIG_HEAD`；此时用 **Compare Two Refs…** 手动比较两个范围。 |
| 快照占用磁盘过多 | 运行 **ExDiff: Delete Snapshots**，调小 `exdiff.snapshotRetentionDays`，或 detach 后手动删除 `<repoRoot>/.exdiff`。 |
| 大仓库第一次打开很慢 | 首次是全量物化，之后增量更新；可以用 `exdiff.snapshotDir` 指向更快的磁盘。 |

## 界面语言

ExDiff 提供英文和简体中文界面。它会跟随 VS Code 的显示语言；通过 **Configure Display Language** 切换并重启即可。其它语言回落到英文。

## 隐私

ExDiff 没有遥测、不发网络请求、不会上传代码。所有操作都在本地完成。

## 许可证

MIT © 2026 xaxys。见 [LICENSE](LICENSE)。
