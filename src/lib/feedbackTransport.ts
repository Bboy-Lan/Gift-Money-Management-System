import { invoke, isTauri } from "@tauri-apps/api/core";
import type cloudbase from "@cloudbase/js-sdk";

type RequestOptions = {
  url?: string;
  method?: string;
  headers?: object;
  body?: unknown;
  data?: unknown;
  signal?: { aborted: boolean };
  shouldThrowOnError?: boolean;
};

type NativeResponse = { status: number; headers: Record<string, string>; body: string };

// Register on first feedback use. The SDK still owns authentication, token renewal
// and persistent storage; only its HTTP transport crosses the native boundary.
export function installFeedbackTransport(sdk: Pick<typeof cloudbase, "useAdapters">) {
  if (!isTauri()) return;
  class DesktopRequest {
    async request(options: RequestOptions) {
      if (options.signal?.aborted) throw new Error("反馈请求已取消");
      if (!options.url) throw new Error("反馈地址无效");
      const value = options.body ?? options.data;
      const body = value == null ? null : typeof value === "string" ? value : JSON.stringify(value);
      const response = await invoke<NativeResponse>("feedback_http_request", { request: {
        url: options.url,
        method: (options.method || "GET").toUpperCase(),
        headers: Object.fromEntries(new Headers(options.headers as HeadersInit).entries()),
        body,
      } });
      let data: unknown = response.body;
      if (response.headers["content-type"]?.includes("application/json") && response.body) data = JSON.parse(response.body);
      return { data, status: response.status, statusCode: response.status, header: response.headers };
    }
    get(options: RequestOptions) { return this.request({ ...options, method: "GET" }); }
    post(options: RequestOptions) { return this.request({ ...options, method: "POST" }); }
    put(options: RequestOptions) { return this.request({ ...options, method: "PUT" }); }
    patch(options: RequestOptions) { return this.request({ ...options, method: "PATCH" }); }
    delete(options: RequestOptions) { return this.request({ ...options, method: "DELETE" }); }
    fetch(options: RequestOptions) { return this.request(options); }
    async upload() { throw new Error("反馈服务不支持文件上传"); }
    async download() { throw new Error("反馈服务不支持文件下载"); }
  }
  sdk.useAdapters({
    runtime: "web",
    isMatch: isTauri,
    genAdapter: () => ({
      type: "lijin-desktop",
      root: window,
      reqClass: DesktopRequest,
      wsClass: window.WebSocket as unknown as import("@cloudbase/adapter-interface").WebSocketContructor,
      localStorage: window.localStorage,
      sessionStorage: window.sessionStorage,
    }),
  });
}
