# 礼金簿管理

Windows 本地离线礼金管理桌面程序。它把一个家庭的多本礼金簿保存在一个可移动的 `.giftvault` 文件中，支持人物档案、标签、跨簿比较、Excel/CSV 交换和回收站恢复。

## 使用方式

1. 安装发布目录中的 `礼金簿管理_0.3.84_x64-setup.exe`，或直接运行其中的 `礼金簿管理.exe`。
2. 首次启动会强制设置 6 至 12 位数字的管理员 PIN，并显示一次性恢复码；完成后可进入工作台新建礼金库。
3. 已有数据可在工作台中打开 `.giftvault` 礼金库；数据保存在用户选择的位置，不依赖程序目录。
4. 进入管理员模式后可在工作台修改 PIN。删除的礼金簿和记录会进入回收站；重要操作前可使用顶部备份按钮创建副本。

5. 设置页可指定新建或打开礼金库、选择导入表格时的默认文件夹；已有礼金库文件不会被自动移动。
6. 在“设置 → 关于”中点击“检查更新”。检测到经过三段版本号和 SHA-256 校验的更高 GitHub Release 后，查看更新明细并确认安装；程序会使用正式安装包覆盖更新并重启。

Excel 是导入导出格式，不是事实数据源。主数据保存在 SQLite 礼金库文件中；金额以分的整数保存，避免浮点误差。在线更新需要网络连接和 GitHub 上已发布的安装包。

## 用户使用指南

- **礼金库**是独立的 `.giftvault` 数据文件；每个礼金库可包含多本**礼金簿**。新建、导入和登记都以当前礼金库及当前礼金簿为准。
- 在“礼金明细”登记或导入记录，在“人物与标签”维护人物标签，在“回礼明细”查看和修改回礼金额、备注；回礼发生时间首次保存后不会被编辑覆盖。
- “跨簿比较”默认只列出当前礼金库的礼金簿。需要比较其他来源时手动添加；删除选中仅移出比较范围，不会删除源文件。
- 管理员模式默认锁定编辑。解锁后可执行删除、批量操作和重要编辑；回收站与历史改动支持选择、恢复和追溯。
- 关闭软件后会保留打开的礼金库和礼金簿选择，但再次启动固定进入“礼金明细”。
- Excel 用于交换数据；跨设备完整迁移或备份请使用“导出库”。

## 开发

运行要求：Windows 10/11。发布目录和安装包已包含固定版 WebView2 运行时，程序启动时会自动调用同目录运行时，普通用户无需另行安装 WebView2。

开发构建要求：Node.js、Rust stable MSVC 和 Visual Studio C++ Build Tools。

```powershell
npm.cmd install
npm.cmd run build

# 需要在 Visual Studio Developer Command Prompt 中执行
cargo fmt --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
npm.cmd run tauri -- build
```

PowerShell 脚本策略可能阻止 `npm.ps1`，项目统一使用 `npm.cmd`。详细里程碑、约束和已知问题见 `AGENTS.md`、`task_plan.md`、`findings.md`、`progress.md` 与 `docs/PROJECT_STATE.md`。

## 数据安全边界

程序不使用账号、网络同步、云端业务存储或本地 HTTP 服务。网络仅用于用户主动点击“检查更新”时读取 GitHub Releases；礼金业务数据仍保存在本机 `.giftvault` 文件中。请把 `.giftvault` 文件和备份视为家庭隐私数据，不要提交到 Git 或公开分享。

## 关于与发布

- 代码仓库：<https://github.com/Bboy-Lan/Gift-Money-Management-System>
- 许可证：MIT，见项目根目录 `LICENSE`。
- 每个版本的更新说明保存在 `CHANGELOG.md`，并同步到对应 GitHub Release Notes。
