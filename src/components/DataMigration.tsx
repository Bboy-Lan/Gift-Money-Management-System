import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export function DataMigration() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  async function run(command: "export_migration" | "import_migration") {
    setBusy(true); setResult("");
    try { const message = await invoke<string | null>(command); if (message) setResult(message); }
    catch (error) { setResult(String(error)); }
    finally { setBusy(false); }
  }
  return <section className="settings-panel"><div>
    <strong>数据迁移</strong>
    <p>请选择需要迁移的全部礼金库文件，导出后请完整保存整个迁移文件夹（包含清单和所有礼金库）。新电脑导入后，使用“打开礼金库”选择导入文件。操作需要礼金库管理员解锁，原文件不会被覆盖。</p>
    <p>此迁移包含所选礼金库内的记录及历史；软件设置、管理员 PIN 和云端反馈身份不包含在内。</p>
    <div className="toolbar-actions"><button className="secondary-button compact" disabled={busy} onClick={() => void run("export_migration")}>导出礼金库</button><button className="secondary-button compact" disabled={busy} onClick={() => void run("import_migration")}>导入礼金库</button></div>
    {result && <p role="status">{result}</p>}
  </div></section>;
}
