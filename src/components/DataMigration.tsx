import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export function DataMigration() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  async function run(command: "export_migration" | "import_migration" | "import_migration_file") {
    setBusy(true); setResult("");
    try { const message = await invoke<string | null>(command); if (message) setResult(message); }
    catch (error) { setResult(String(error)); }
    finally { setBusy(false); }
  }
  return <section className="migration-page">
    <div className="migration-intro"><strong>数据迁移</strong><p>备份当前礼金库，或从其他电脑导入礼金库。</p></div>
    <div className="migration-grid">
      <section className="settings-panel migration-card"><div><strong>导出当前礼金库</strong><p>选择保存位置，生成完整的礼金库副本。</p><button className="primary-button compact" disabled={busy} onClick={() => void run("export_migration")}>导出礼金库</button></div></section>
      <section className="settings-panel migration-card"><div><strong>导入礼金库</strong><p>选择礼金库文件，并指定新文件的保存位置。</p><div className="toolbar-actions"><button className="secondary-button compact" disabled={busy} onClick={() => void run("import_migration_file")}>导入礼金库</button><button className="secondary-button compact" disabled={busy} onClick={() => void run("import_migration")}>导入旧版迁移文件夹</button></div></div></section>
    </div>
    <p className="migration-note">操作需要管理员解锁，不会覆盖已有文件。软件设置、PIN 和反馈身份不包含在礼金库中。</p>
    {result && <p className="migration-result" role="status">{result}</p>}
  </section>;
}
