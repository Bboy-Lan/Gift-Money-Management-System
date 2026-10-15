import { useContext } from "react";
import { ChevronDown, CloudDownload, Download, ExternalLink, Gift, Github, HardDriveDownload, RefreshCw } from "lucide-react";
import { SoftwareUpdateContext } from "../hooks/useSoftwareUpdates";
import { downloadPercent, formatDownloadSize, updateStatusMessage, type UpdatePhase } from "../lib/softwareUpdates";
import { CURRENT_RELEASE_NOTES } from "../releaseNotes";
import type { DownloadChannel, SoftwareUpdateStatus } from "../types";

type Props = {
  updatePhase: UpdatePhase;
  updateStatus: SoftwareUpdateStatus | null;
  checkedAt: string;
  updateMessage?: string;
  onCheckUpdate: () => void;
  onInstallUpdate: () => void;
  onShowLicense: () => void;
  licenseOpen: boolean;
  licenseText: string | null;
};

export function AboutSettings(props: Props) {
  const controller = useContext(SoftwareUpdateContext);
  const candidate = props.updateStatus?.candidate;
  const active = !["idle", "ready"].includes(props.updatePhase);
  const progress = controller?.progress ?? null;
  const percent = downloadPercent(progress);
  const channels = props.updateStatus?.channels ?? [];
  const open = (id: string) => void controller?.openChannel(id);
  const channelButton = (id: DownloadChannel["id"], label: string) => {
    const channel = channels.find(item => item.id === id);
    return <button className="secondary-button compact download-channel-button" type="button" disabled={!channel?.url} aria-label={label} title={channel?.url ?? "暂未配置下载链接"} onClick={() => open(id)}>{label}<ExternalLink size={13} /></button>;
  };
  const action = props.updatePhase === "downloading" ? "正在下载…" : props.updatePhase === "verifying" ? "正在校验…" : props.updatePhase === "installing" ? "正在安装…" : props.updatePhase === "ready" ? "重启并安装" : "立即更新";

  return <section className="about-page about-updates" aria-label="关于礼金簿">
    <section className="about-card about-version-card">
      <div className="about-product"><span className="about-product-icon"><Gift size={25} /></span><div><h3>礼金簿</h3><p>把每一份心意，妥善记在本地</p></div><span className="about-version">v{__APP_VERSION__}</span></div>
      <div className="about-update-heading"><div><h4>软件更新</h4><p>更新程序，保留你的礼金库和设置。</p></div><button type="button" className="secondary-button compact" disabled={active} onClick={props.onCheckUpdate}><RefreshCw size={14} className={props.updatePhase === "checking" ? "is-spinning" : undefined} />{props.updatePhase === "checking" ? "检查中…" : "检查更新"}</button></div>
      <div className={`about-update-result ${candidate ? "has-update" : ""}`} role="status"><span className={`status-dot ${candidate ? "status-dot-update" : ""}`} /><span>{updateStatusMessage(props.updateStatus)}</span>{candidate && <button type="button" className="primary-button compact" disabled={active || !props.updateStatus?.installed || !candidate.id} onClick={props.onInstallUpdate}><Download size={14} />{action}</button>}</div>
      {progress && <div className="about-download-progress"><progress aria-label="更新下载进度" max={100} {...(percent === null ? {} : { value: percent })} /><span>{props.updatePhase === "verifying" ? "下载完成，正在验证安装包" : `${formatDownloadSize(progress.received)}${progress.total ? ` / ${formatDownloadSize(progress.total)}` : ""}`}</span></div>}
      {controller?.error && <p className="about-update-error" role="alert">{controller.error}</p>}
      {props.updateStatus?.error && candidate && <p className="about-meta">{props.updateStatus.error}</p>}
      <div className="about-update-footnote"><span>最近检查：{props.checkedAt}</span><span>{props.updateStatus?.installed ? "安装版 · 支持一键更新" : "便携运行 · 安装版支持一键更新"}</span></div>
    </section>

    <section className="about-card"><div className="about-section-title"><h4>下载方式</h4><span>选择方便的方式，下载同一个版本</span></div><div className="download-channel-grid">
      <article className="download-channel-card"><CloudDownload size={21} /><strong>腾讯云</strong><p>{channels.find(item => item.id === "cloud")?.url ? "国内下载入口" : "暂未配置，测试期间无需开通"}</p>{channelButton("cloud", "腾讯云下载")}</article>
      <article className="download-channel-card"><Github size={21} /><strong>GitHub</strong><p>查看正式发布、版本说明与安装包</p>{channelButton("github", "GitHub 下载")}</article>
      <article className="download-channel-card"><HardDriveDownload size={21} /><strong>网盘</strong><p>浏览器打开分享页，手动下载安装包</p><div className="netdisk-buttons">{channelButton("lanzou", "蓝奏云")}{channelButton("baidu", "百度网盘")}</div></article>
    </div><p className="about-meta">一键更新会自动下载并安装；通过下载页面获取安装包后，双击安装即可。</p></section>

    {candidate?.releaseNotes && <section className="about-card"><details className="release-notes-details" open><summary>新版本 v{candidate.version} 更新明细</summary><pre>{candidate.releaseNotes}</pre></details></section>}
    <section className="about-card"><details className="release-notes-details" open><summary className="about-card-heading"><div><span className="about-label">当前版本与历史记录</span><strong>更新明细</strong></div><ChevronDown size={16} /></summary><pre>{CURRENT_RELEASE_NOTES}</pre></details></section>
    <section className="about-card about-project-info"><span>作者 Bboy-Lan</span><button className="text-link" type="button" onClick={() => open("github")}>项目发布页<ExternalLink size={12} /></button><button className="text-link" type="button" onClick={props.onShowLicense}>MIT License · 查看许可</button>{props.licenseOpen && props.licenseText && <pre className="license-preview">{props.licenseText}</pre>}</section>
  </section>;
}
