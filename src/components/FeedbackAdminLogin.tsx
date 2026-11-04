import { useEffect, useState } from "react";
import { requestFeedbackAdminCode, type FeedbackAdminCodeChallenge } from "../lib/cloudFeedback";

export function FeedbackAdminLogin({ busy, onBusyChange, onAuthenticated }: {
  busy: boolean;
  onBusyChange: (value: boolean) => void;
  onAuthenticated: () => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState<FeedbackAdminCodeChallenge | null>(null);
  const [countdown, setCountdown] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (countdown <= 0) return;
    const timer = window.setTimeout(() => setCountdown(value => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [countdown]);

  const sendCode = async () => {
    if (busy || countdown > 0) return;
    onBusyChange(true);
    setError(null);
    setNotice(null);
    try {
      setChallenge(await requestFeedbackAdminCode(email));
      setCode("");
      setCountdown(60);
      setNotice("验证码已发送，请查收邮件；未收到时可检查垃圾邮件。");
    } catch (reason) {
      setError(String(reason).replace(/^Error:\s*/, ""));
    } finally { onBusyChange(false); }
  };

  const verify = async () => {
    if (busy || !challenge) return;
    onBusyChange(true);
    setError(null);
    try {
      await challenge.verify(code);
      setCode("");
      await onAuthenticated();
    } catch (reason) {
      setError(String(reason).replace(/^Error:\s*/, ""));
    } finally { onBusyChange(false); }
  };

  return <form className="feedback-admin-login" onSubmit={event => {
    event.preventDefault();
    void (challenge ? verify() : sendCode());
  }}>
    <strong>管理员邮箱登录</strong>
    <p className="field-hint">普通反馈无需登录。首次验证后记住这台电脑，正常更新版本也会保留登录状态；仅退出、清除应用数据或会话失效时需要重新验证。</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    {notice && <p className="field-hint" role="status">{notice}</p>}
    <label>管理员邮箱<input type="email" autoComplete="email" value={email} maxLength={254} disabled={busy} required onChange={event => {
      setEmail(event.target.value);
      setChallenge(null);
      setCode("");
      setError(null);
      setNotice(null);
    }} /></label>
    <button className="secondary-button compact" type="button" disabled={!email.trim() || busy || countdown > 0} onClick={() => void sendCode()}>
      {countdown > 0 ? `${countdown} 秒后重发` : "获取验证码"}
    </button>
    {challenge && <><label>邮箱验证码<input autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={code} disabled={busy} required placeholder="6 位数字验证码" onChange={event => setCode(event.target.value.replace(/\D/g, ""))} /></label>
      <button className="primary-button compact" type="submit" disabled={!/^\d{6}$/.test(code) || busy}>{busy ? "验证中…" : "验证并登录"}</button></>}
  </form>;
}
