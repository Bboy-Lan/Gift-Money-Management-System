use reqwest::{header::HeaderMap, Method, Url};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;

const HOST: &str = "cloud-ynnu-d6gs8ekf7dbcbe80e.api.tcloudbasegateway.com";
const CLASSIC_HOST: &str = "cloud-yunda-d5gxrar1s14b2ee0d.api.tcloudbasegateway.com";
const MAX_BODY: usize = 32 * 1024;
const MAX_RESPONSE: usize = 4 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeedbackRequest {
    pub url: String,
    pub method: String,
    pub headers: HashMap<String, String>,
    pub body: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: String,
}

fn validate_request(input: &FeedbackRequest) -> Result<(Url, Method, HeaderMap), String> {
    let url = Url::parse(&input.url).map_err(|_| "反馈地址无效")?;
    let old_allowed = url.host_str() == Some(HOST)
        && (url.path().starts_with("/auth/v1/")
            || matches!(
                url.path(),
                "/v1/rdb/rest/feedback"
                    | "/v1/rdb/rest/feedback_replies"
                    | "/v1/rdb/rest/rpc/feedback_admin_status"
                    | "/v1/rdb/rest/rpc/feedback_recycle"
                    | "/v1/rdb/rest/rpc/feedback_recycled_list"
                    | "/v1/rdb/rest/announcements"
                    | "/v1/rdb/rest/announcement_drafts"
                    | "/v1/rdb/rest/rpc/save_announcement_draft"
                    | "/v1/rdb/rest/rpc/publish_announcement"
            ));
    let classic_allowed = url.host_str() == Some(CLASSIC_HOST)
        && (url.path().starts_with("/auth/v1/") || url.path() == "/v1/functions/lijin_feedback_v1");
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port_or_known_default() != Some(443)
        || url.fragment().is_some()
        || !(old_allowed || classic_allowed)
        || input.url.len() > 16 * 1024
    {
        return Err("反馈地址超出允许范围".into());
    }
    let method = Method::from_bytes(input.method.as_bytes()).map_err(|_| "反馈请求方式无效")?;
    if !matches!(
        method,
        Method::GET | Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    ) || input
        .body
        .as_ref()
        .is_some_and(|body| body.len() > MAX_BODY)
        || input.headers.len() > 32
    {
        return Err("反馈请求超出允许范围".into());
    }
    let mut headers = HeaderMap::new();
    for (name, value) in &input.headers {
        let lower = name.to_ascii_lowercase();
        if matches!(
            lower.as_str(),
            "host"
                | "origin"
                | "cookie"
                | "referer"
                | "proxy-authorization"
                | "content-length"
                | "connection"
                | "transfer-encoding"
        ) || lower.starts_with("proxy-")
            || lower.starts_with("sec-")
            || value.len() > 16 * 1024
        {
            return Err("反馈请求头不受支持".into());
        }
        headers.insert(
            reqwest::header::HeaderName::from_bytes(name.as_bytes())
                .map_err(|_| "反馈请求头无效")?,
            reqwest::header::HeaderValue::from_str(value).map_err(|_| "反馈请求头无效")?,
        );
    }
    Ok((url, method, headers))
}

#[tauri::command]
pub async fn feedback_http_request(request: FeedbackRequest) -> Result<FeedbackResponse, String> {
    let (url, method, headers) = validate_request(&request)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(25))
        .build()
        .map_err(|_| "无法初始化反馈网络连接")?;
    let mut outgoing = client.request(method, url).headers(headers);
    if let Some(body) = request.body {
        outgoing = outgoing.body(body);
    }
    let mut response = outgoing
        .send()
        .await
        .map_err(|_| "反馈网络连接失败，请检查网络后重试")?;
    if response.status().is_redirection() {
        return Err("反馈服务重定向已拒绝".into());
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE as u64)
    {
        return Err("反馈响应过大".into());
    }
    let status = response.status().as_u16();
    let headers = response
        .headers()
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.to_string(), value.to_string()))
        })
        .collect();
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "读取反馈响应失败，请稍后重试")?
    {
        if bytes.len() + chunk.len() > MAX_RESPONSE {
            return Err("反馈响应过大".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let body = String::from_utf8(bytes).map_err(|_| "反馈响应格式无效")?;
    Ok(FeedbackResponse {
        status,
        headers,
        body,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(path: &str) -> FeedbackRequest {
        FeedbackRequest {
            url: format!("https://{HOST}{path}"),
            method: "GET".into(),
            headers: HashMap::new(),
            body: None,
        }
    }

    #[test]
    fn only_feedback_gateway_routes_are_accepted() {
        for path in [
            "/v1/rdb/rest/announcements",
            "/v1/rdb/rest/announcement_drafts",
            "/v1/rdb/rest/rpc/save_announcement_draft",
            "/v1/rdb/rest/rpc/publish_announcement",
            "/auth/v1/user/me",
            "/auth/v1/token",
            "/v1/rdb/rest/feedback?select=id",
            "/v1/rdb/rest/feedback_replies",
            "/v1/rdb/rest/rpc/feedback_admin_status",
            "/v1/rdb/rest/rpc/feedback_recycle",
            "/v1/rdb/rest/rpc/feedback_recycled_list",
        ] {
            assert!(validate_request(&request(path)).is_ok(), "{path}");
        }
        let mut classic = request("/v1/functions/lijin_feedback_v1");
        classic.url = format!("https://{CLASSIC_HOST}/v1/functions/lijin_feedback_v1");
        assert!(validate_request(&classic).is_ok());
        classic.url = format!("https://{CLASSIC_HOST}/v1/functions/another_app");
        assert!(validate_request(&classic).is_err());
        for url in [
            "http://cloud-ynnu-d6gs8ekf7dbcbe80e.api.tcloudbasegateway.com/auth/v1/token",
            "https://evil.example/auth/v1/token",
            "https://cloud-ynnu-d6gs8ekf7dbcbe80e.api.tcloudbasegateway.com:8443/auth/v1/token",
            "https://user@cloud-ynnu-d6gs8ekf7dbcbe80e.api.tcloudbasegateway.com/auth/v1/token",
        ] {
            let mut input = request("/auth/v1/token");
            input.url = url.into();
            assert!(validate_request(&input).is_err());
        }
        for path in [
            "/v1/rdb/rest/feedback_admins",
            "/v1/rdb/rest/feedback/../feedback_admins",
            "/v1/rdb/rest/%66eedback",
            "/auth/v1/../admin",
            "/auth/v1/user/me#fragment",
        ] {
            assert!(validate_request(&request(path)).is_err(), "{path}");
        }
    }

    #[test]
    fn requests_have_bounded_bodies_and_cannot_override_transport_identity() {
        let mut input = request("/v1/rdb/rest/feedback");
        input.body = Some("x".repeat(MAX_BODY + 1));
        assert!(validate_request(&input).is_err());
        input.body = None;
        for header in ["Host", "Origin", "Cookie", "Referer", "Proxy-Authorization"] {
            input.headers.clear();
            input.headers.insert(header.into(), "override".into());
            assert!(validate_request(&input).is_err());
        }
        input.headers.clear();
        input.method = "CONNECT".into();
        assert!(validate_request(&input).is_err());
    }
}
