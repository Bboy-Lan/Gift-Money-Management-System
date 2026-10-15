# 礼金簿

Windows 本地离线礼金管理桌面程序。它把一个家庭的多本礼金簿保存在一个可移动的 `.giftvault` 文件中，支持人物档案、标签、跨簿比较、Excel/CSV 交换和回收站恢复。

## 使用方式

1. 从 [GitHub Releases](https://github.com/Bboy-Lan/Gift-Money-Management-System/releases) 下载 `Gift-Money-Management-System_0.4.28_x64-setup.exe` 并安装（本地交付名为 `礼金簿_0.4.28_x64-setup.exe`，内容相同）。GitHub附件沿用ASCII命名以避免中文上传截断，软件名称仍是“礼金簿”。便携使用须同时保留完整的 `webview2-fixed` 文件夹；仅复制 EXE 不能保证正常运行。
2. 首次启动会强制设置 6 至 12 位数字的管理员 PIN，并显示一次性恢复码；完成后可进入工作台新建礼金库。
3. 已有数据可在工作台中打开 `.giftvault` 礼金库；数据保存在用户选择的位置，不依赖程序目录。
4. 进入管理员模式后可在工作台修改 PIN。删除的礼金簿和记录会进入回收站；重要操作前可使用顶部备份按钮创建副本。

5. 设置页可指定新建或打开礼金库、选择导入表格时的默认文件夹；已有礼金库文件不会被自动移动。
6. 安装版启动后会在后台检查更新，也可在“设置 → 关于”手动检查。发现新版后点击“立即更新”，程序下载并验证签名；保存或关闭编辑表单后，正常退出、在原安装位置覆盖并重启。便携版请手动下载安装包。旧版本首次升级至 0.4.28 也需手动安装，旧客户端不能凭服务器配置自动获得新更新功能。

7. 本机模式默认开启“持续登记”；每条礼金保存成功后会自动打开下一条登记表单，点击按钮关闭或取消登记即可退出。

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

PowerShell 脚本策略可能阻止 `npm.ps1`，项目统一使用 `npm.cmd`。公开更新记录见 `CHANGELOG.md`；内部会话和审查状态不作为公开源码附件。

## 数据安全边界

程序不使用账号、网络同步、云端业务存储或本地 HTTP 服务。网络仅用于软件更新检查、安装包下载和用户主动打开下载页；不上传礼金库、人物、PIN或本机数据文件路径。成功检查在本次运行中缓存24小时；失败可重试。请把 `.giftvault` 文件和备份视为家庭隐私数据，不要提交到 Git 或公开分享。

## 更新渠道与维护

- 关于页保留腾讯云、GitHub、网盘三类入口，网盘细分蓝奏云和百度网盘。GitHub已配置；其余暂未配置，按钮禁用。网盘是人工下载备用入口，不把分享页面当作自动更新接口。
- `update-channels.json` 集中配置公开链接、更新清单地址和签名公钥。腾讯云上线时可使用COS托管同一版本安装包、签名和清单，无需常驻服务器；先上传安装包和签名，最后更新清单，避免客户端获取不完整发布。
- 目前腾讯云未购买或部署。新版本仍保留独立的应用标识和本机设置目录，不自动迁移旧版PIN或设置；已有礼金库可由用户手动打开。
- 发布前同步三个版本文件与CHANGELOG；`npm.cmd run release:local` 验证并将完整产物放入 `release/<版本>/`，不运行安装器。程序内更新明细在构建时从CHANGELOG生成。
- 构建者需妥善离线备份 `.local-signing/lijinbook.key`，该目录禁止提交或上传。首次可运行 `node scripts/ensure-update-signing.mjs`；以后必须使用同一私钥签名。更换密钥会使已安装客户端拒绝更新。
- GitHub发布须附带安装包、`.sig`、`latest.json`、更新说明与SHA256清单。更新签名不是Windows Authenticode证书，SmartScreen可能仍提示未知发布者。
- 发布流程：先运行 `npm.cmd run release:local`，再运行 `node scripts/publish-github.mjs` 仅验证成品；确认测试和附件后提交源码，正常推送main及指向该提交的annotated版本tag。明确获准发布后运行 `node scripts/publish-github.mjs --publish`，脚本先上传草稿、核验签名版本/附件摘要，再公开Release；不会强推或覆盖已公开版本。

## 关于与发布

- 代码仓库：<https://github.com/Bboy-Lan/Gift-Money-Management-System>
- 许可证：MIT，见项目根目录 `LICENSE`。
- 每个版本的更新说明保存在 `CHANGELOG.md`，并同步到对应 GitHub Release Notes。
