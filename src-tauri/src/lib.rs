use axum::{
    body::{Body, Bytes},
    extract::{Request, State},
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
    Json, Router,
};
use chrono::Local;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::Arc,
    time::Instant,
};
use tauri::{Manager, State as TauriState};
use tokio::{
    net::TcpListener,
    sync::{oneshot, RwLock},
    task::JoinHandle,
};
use tower_http::cors::{Any, CorsLayer};

const KEYRING_SERVICE: &str = "accio-switch";
const KEYRING_USER: &str = "provider-api-key";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub mode: String,
    pub provider: String,
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub api_key_configured: bool,
    pub fallback_official: bool,
    pub auto_start_bridge: bool,
    pub bridge_port: u16,
    pub official_gateway: String,
    pub accio_path: String,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            mode: "custom".into(),
            provider: "OpenAI Compatible".into(),
            base_url: "https://api.openai.com/v1".into(),
            model: "gpt-4.1-mini".into(),
            api_key: String::new(),
            api_key_configured: false,
            fallback_official: true,
            auto_start_bridge: true,
            bridge_port: 8787,
            official_gateway: "https://phoenix-gw.alibaba.com".into(),
            accio_path: default_accio_path(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    time: String,
    level: String,
    message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    config: AppConfig,
    bridge_running: bool,
    accio_running: bool,
    logs: Vec<LogEntry>,
}

#[derive(Debug, Serialize)]
struct RunningResult {
    running: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TestResult {
    ok: bool,
    latency_ms: u128,
    model_found: bool,
    message: String,
}

#[derive(Debug, Serialize)]
struct LaunchResult {
    launched: bool,
    message: String,
}

struct BridgeProcess {
    shutdown: oneshot::Sender<()>,
    task: JoinHandle<()>,
}

pub struct AppState {
    config: Arc<RwLock<AppConfig>>,
    logs: Arc<RwLock<Vec<LogEntry>>>,
    bridge: Arc<RwLock<Option<BridgeProcess>>>,
    config_path: PathBuf,
}

#[derive(Clone)]
struct BridgeState {
    config: Arc<RwLock<AppConfig>>,
    logs: Arc<RwLock<Vec<LogEntry>>>,
    client: Client,
}

fn default_accio_path() -> String {
    std::env::var("LOCALAPPDATA")
        .map(|root| format!("{root}\\Programs\\Accio\\Accio.exe"))
        .unwrap_or_else(|_| "C:\\Users\\Public\\Accio\\Accio.exe".into())
}

fn config_dir() -> PathBuf {
    std::env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("Accio Switch")
}

fn public_config(mut config: AppConfig) -> AppConfig {
    config.api_key.clear();
    config.api_key_configured = read_api_key().is_some();
    config
}

fn read_api_key() -> Option<String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .ok()
        .and_then(|entry| entry.get_password().ok())
        .filter(|key| !key.trim().is_empty())
}

fn store_api_key(key: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|error| format!("Credential Manager error: {error}"))?;
    entry
        .set_password(key)
        .map_err(|error| format!("Unable to store API key: {error}"))
}

fn load_config(path: &Path) -> AppConfig {
    fs::read_to_string(path)
        .ok()
        .and_then(|value| serde_json::from_str::<AppConfig>(&value).ok())
        .map(|mut config| {
            config.api_key.clear();
            config.api_key_configured = read_api_key().is_some();
            config
        })
        .unwrap_or_default()
}

fn persist_config(path: &Path, config: &AppConfig) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let mut stored = config.clone();
    stored.api_key.clear();
    stored.api_key_configured = read_api_key().is_some();
    let json = serde_json::to_string_pretty(&stored).map_err(|error| error.to_string())?;
    fs::write(path, json).map_err(|error| error.to_string())
}

async fn log_event(logs: &Arc<RwLock<Vec<LogEntry>>>, level: &str, message: impl Into<String>) {
    let mut entries = logs.write().await;
    entries.push(LogEntry {
        time: Local::now().format("%H:%M:%S").to_string(),
        level: level.into(),
        message: message.into(),
    });
    if entries.len() > 300 {
        entries.drain(0..100);
    }
}

#[tauri::command]
async fn get_snapshot(state: TauriState<'_, AppState>) -> Result<Snapshot, String> {
    Ok(Snapshot {
        config: public_config(state.config.read().await.clone()),
        bridge_running: state.bridge.read().await.is_some(),
        accio_running: false,
        logs: state.logs.read().await.clone(),
    })
}

#[tauri::command]
async fn save_config(mut config: AppConfig, state: TauriState<'_, AppState>) -> Result<(), String> {
    if !config.api_key.trim().is_empty() {
        store_api_key(config.api_key.trim())?;
    }
    config.api_key.clear();
    config.api_key_configured = read_api_key().is_some();
    persist_config(&state.config_path, &config)?;
    *state.config.write().await = config;
    log_event(&state.logs, "INFO", "Configuration saved").await;
    Ok(())
}

#[tauri::command]
async fn start_bridge(state: TauriState<'_, AppState>) -> Result<RunningResult, String> {
    start_bridge_inner(&state).await?;
    Ok(RunningResult { running: true })
}

async fn start_bridge_inner(state: &AppState) -> Result<(), String> {
    if state.bridge.read().await.is_some() {
        return Ok(());
    }
    let config = state.config.read().await.clone();
    let address = format!("127.0.0.1:{}", config.bridge_port);
    let listener = TcpListener::bind(&address)
        .await
        .map_err(|error| format!("Cannot listen on {address}: {error}"))?;
    let bridge_state = BridgeState {
        config: state.config.clone(),
        logs: state.logs.clone(),
        client: Client::builder()
            .timeout(std::time::Duration::from_secs(180))
            .build()
            .map_err(|error| error.to_string())?,
    };
    let router = Router::new()
        .route("/health", any(health))
        .fallback(any(bridge_handler))
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_headers(Any)
                .allow_methods(Any),
        )
        .with_state(bridge_state);
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let logs = state.logs.clone();
    let task = tokio::spawn(async move {
        let server = axum::serve(listener, router).with_graceful_shutdown(async {
            let _ = shutdown_rx.await;
        });
        if let Err(error) = server.await {
            log_event(&logs, "ERROR", format!("Bridge server error: {error}")).await;
        }
    });
    *state.bridge.write().await = Some(BridgeProcess {
        shutdown: shutdown_tx,
        task,
    });
    log_event(&state.logs, "INFO", format!("Bridge listening on http://{address}")).await;
    Ok(())
}

#[tauri::command]
async fn stop_bridge(state: TauriState<'_, AppState>) -> Result<RunningResult, String> {
    if let Some(process) = state.bridge.write().await.take() {
        let _ = process.shutdown.send(());
        let _ = process.task.await;
        log_event(&state.logs, "INFO", "Bridge stopped").await;
    }
    Ok(RunningResult { running: false })
}

#[tauri::command]
async fn test_endpoint(state: TauriState<'_, AppState>) -> Result<TestResult, String> {
    let config = state.config.read().await.clone();
    let key = read_api_key().ok_or_else(|| "Configure an API key first".to_string())?;
    let endpoint = format!("{}/models", config.base_url.trim_end_matches('/'));
    let started = Instant::now();
    let response = Client::new()
        .get(&endpoint)
        .bearer_auth(key)
        .send()
        .await
        .map_err(|error| format!("Connection failed: {error}"))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    let model_found = body.contains(&config.model);
    let result = TestResult {
        ok: status.is_success(),
        latency_ms: started.elapsed().as_millis(),
        model_found,
        message: if status.is_success() {
            if model_found {
                "Endpoint reachable and model listed".into()
            } else {
                "Endpoint reachable; model was not present in /models".into()
            }
        } else {
            format!("Endpoint returned HTTP {status}")
        },
    };
    log_event(
        &state.logs,
        if result.ok { "INFO" } else { "ERROR" },
        format!("Endpoint test: {}", result.message),
    )
    .await;
    Ok(result)
}

#[tauri::command]
async fn launch_accio(state: TauriState<'_, AppState>) -> Result<LaunchResult, String> {
    let config = state.config.read().await.clone();
    let custom = config.mode == "custom";
    if custom && config.auto_start_bridge {
        start_bridge_inner(&state).await?;
    }
    if !Path::new(&config.accio_path).exists() {
        return Err(format!("Accio executable not found: {}", config.accio_path));
    }
    let mut command = Command::new(&config.accio_path);
    if custom {
        command
            .env("GATEWAY_BASE_URL", format!("http://127.0.0.1:{}", config.bridge_port))
            .env("ADK_MODEL", &config.model);
    } else {
        command.env_remove("GATEWAY_BASE_URL").env_remove("ADK_MODEL");
    }
    command
        .spawn()
        .map_err(|error| format!("Unable to launch Accio: {error}"))?;
    let message = format!(
        "Accio Work launched in {} mode",
        if custom { "custom" } else { "official" }
    );
    log_event(&state.logs, "INFO", &message).await;
    Ok(LaunchResult { launched: true, message })
}

async fn health(State(state): State<BridgeState>) -> impl IntoResponse {
    let config = state.config.read().await;
    Json(json!({
        "ok": true,
        "mode": config.mode,
        "model": config.model,
        "provider": config.provider
    }))
}

async fn bridge_handler(State(state): State<BridgeState>, request: Request) -> Response {
    let path = request
        .uri()
        .path_and_query()
        .map(|value| value.as_str().to_string())
        .unwrap_or_else(|| request.uri().path().to_string());
    if request.uri().path() == "/api/llm/config/v2" {
        return custom_model_list(&state).await.into_response();
    }
    if request.uri().path().starts_with("/api/adk/llm") {
        let (parts, body) = request.into_parts();
        let bytes = match axum::body::to_bytes(body, 32 * 1024 * 1024).await {
            Ok(value) => value,
            Err(error) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({"error_message": format!("Invalid request body: {error}")})),
                )
                    .into_response()
            }
        };
        return handle_llm(&state, parts.method, parts.headers, &path, bytes).await;
    }
    proxy_official(&state, request).await
}

async fn custom_model_list(state: &BridgeState) -> Json<Value> {
    let config = state.config.read().await;
    Json(json!([{
        "provider": "accio-switch",
        "providerDisplayName": "Accio Switch",
        "modelList": [{
            "modelCode": config.model,
            "modelName": config.model,
            "modelDisplayName": config.model,
            "modelDesc": format!("{} via {}", config.model, config.provider),
            "visible": true,
            "isDefault": true,
            "freeUse": true,
            "multimodal": true,
            "contextWindow": 128000,
            "reasoningEfforts": ["low", "medium", "high"],
            "defaultReasoningEffort": "medium"
        }]
    }]))
}

async fn handle_llm(
    state: &BridgeState,
    method: Method,
    headers: HeaderMap,
    path: &str,
    body: Bytes,
) -> Response {
    if method != Method::POST {
        return proxy_raw(state, method, headers, path, body).await;
    }
    let input: Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(_) => {
            log_event(&state.logs, "WARN", "Unsupported non-JSON LLM frame forwarded to official gateway").await;
            return proxy_raw(state, method, headers, path, body).await;
        }
    };
    match call_openai(state, input).await {
        Ok(response) => response,
        Err(error) => {
            let config = state.config.read().await.clone();
            log_event(&state.logs, "ERROR", format!("Custom LLM failed: {error}")).await;
            if config.fallback_official {
                log_event(&state.logs, "WARN", "Retrying through official Accio gateway").await;
                proxy_raw(state, Method::POST, headers, path, body).await
            } else {
                (
                    StatusCode::BAD_GATEWAY,
                    Json(json!({"error_code": 502, "error_message": error})),
                )
                    .into_response()
            }
        }
    }
}

async fn call_openai(state: &BridgeState, input: Value) -> Result<Response, String> {
    let config = state.config.read().await.clone();
    let api_key = read_api_key().ok_or_else(|| "API key is not configured".to_string())?;
    let endpoint = format!("{}/chat/completions", config.base_url.trim_end_matches('/'));
    let started = Instant::now();
    let response = state
        .client
        .post(endpoint)
        .bearer_auth(api_key)
        .json(&accio_to_openai(&input, &config.model))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status();
    let payload: Value = response
        .json()
        .await
        .map_err(|error| format!("Invalid provider JSON: {error}"))?;
    if !status.is_success() {
        return Err(format!("Provider HTTP {status}: {}", redact_value(&payload)));
    }
    let converted = openai_to_accio(&payload, &config.model);
    log_event(
        &state.logs,
        "INFO",
        format!(
            "{} completed through {} in {} ms",
            config.model,
            config.provider,
            started.elapsed().as_millis()
        ),
    )
    .await;
    Ok(Json(converted).into_response())
}

fn accio_to_openai(input: &Value, model: &str) -> Value {
    let mut messages: Vec<Value> = Vec::new();
    if let Some(parts) = input
        .get("systemInstruction")
        .or_else(|| input.get("system_instruction"))
        .and_then(|value| value.get("parts"))
        .and_then(Value::as_array)
    {
        let text = parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n");
        if !text.is_empty() {
            messages.push(json!({"role": "system", "content": text}));
        }
    }
    if let Some(contents) = input.get("contents").and_then(Value::as_array) {
        for content in contents {
            let role = match content.get("role").and_then(Value::as_str).unwrap_or("user") {
                "model" => "assistant",
                "function" => "tool",
                other => other,
            };
            let mut text = Vec::new();
            let mut images = Vec::new();
            if let Some(parts) = content.get("parts").and_then(Value::as_array) {
                for part in parts {
                    if let Some(value) = part.get("text").and_then(Value::as_str) {
                        text.push(value.to_string());
                    }
                    if let Some(data) = part.get("inlineData").or_else(|| part.get("inline_data")) {
                        if let (Some(mime), Some(raw)) = (
                            data.get("mimeType").or_else(|| data.get("mime_type")).and_then(Value::as_str),
                            data.get("data").and_then(Value::as_str),
                        ) {
                            images.push(json!({
                                "type": "image_url",
                                "image_url": {"url": format!("data:{mime};base64,{raw}")}
                            }));
                        }
                    }
                }
            }
            if images.is_empty() {
                messages.push(json!({"role": role, "content": text.join("\n")}));
            } else {
                let mut content_parts = vec![json!({"type": "text", "text": text.join("\n")})];
                content_parts.extend(images);
                messages.push(json!({"role": role, "content": content_parts}));
            }
        }
    }
    if messages.is_empty() {
        if let Some(input_messages) = input.get("messages").and_then(Value::as_array) {
            messages.extend(input_messages.iter().cloned());
        }
    }
    let tools = input
        .get("tools")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .flat_map(|item| {
                    item.get("functionDeclarations")
                        .or_else(|| item.get("function_declarations"))
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default()
                })
                .map(|declaration| {
                    json!({
                        "type": "function",
                        "function": {
                            "name": declaration.get("name").cloned().unwrap_or(Value::String("tool".into())),
                            "description": declaration.get("description").cloned().unwrap_or(Value::String(String::new())),
                            "parameters": declaration.get("parameters").cloned().unwrap_or(json!({"type":"object","properties":{}}))
                        }
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let generation = input
        .get("generationConfig")
        .or_else(|| input.get("generation_config"))
        .cloned()
        .unwrap_or(Value::Null);
    let mut output = json!({
        "model": model,
        "messages": messages,
        "stream": false,
        "temperature": generation.get("temperature").cloned().unwrap_or(json!(0.7)),
        "max_tokens": generation.get("maxOutputTokens")
            .or_else(|| generation.get("max_output_tokens"))
            .cloned()
            .unwrap_or(json!(16384))
    });
    if !tools.is_empty() {
        output["tools"] = Value::Array(tools);
        output["tool_choice"] = json!("auto");
    }
    output
}

fn openai_to_accio(payload: &Value, model: &str) -> Value {
    let choice = payload
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .cloned()
        .unwrap_or(Value::Null);
    let message = choice.get("message").cloned().unwrap_or(Value::Null);
    let mut parts = Vec::new();
    if let Some(content) = message.get("content").and_then(Value::as_str) {
        parts.push(json!({"text": content}));
    }
    if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
        for call in calls {
            let function = call.get("function").cloned().unwrap_or(Value::Null);
            let args = function
                .get("arguments")
                .and_then(Value::as_str)
                .and_then(|value| serde_json::from_str::<Value>(value).ok())
                .unwrap_or_else(|| json!({}));
            parts.push(json!({
                "functionCall": {
                    "id": call.get("id").cloned().unwrap_or(Value::Null),
                    "name": function.get("name").cloned().unwrap_or(Value::String("tool".into())),
                    "args": args
                }
            }));
        }
    }
    let usage = payload.get("usage").cloned().unwrap_or(Value::Null);
    json!({
        "content": {"role": "model", "parts": parts},
        "finishReason": if choice.get("finish_reason").and_then(Value::as_str) == Some("length") { "MAX_TOKENS" } else { "STOP" },
        "usageMetadata": {
            "promptTokenCount": usage.get("prompt_tokens").cloned().unwrap_or(json!(0)),
            "candidatesTokenCount": usage.get("completion_tokens").cloned().unwrap_or(json!(0)),
            "totalTokenCount": usage.get("total_tokens").cloned().unwrap_or(json!(0))
        },
        "customMetadata": {
            "model_name": payload.get("model").cloned().unwrap_or(Value::String(model.into())),
            "bridge": "accio-switch"
        },
        "turnComplete": true,
        "partial": false
    })
}

fn redact_value(value: &Value) -> String {
    let mut text = value.to_string();
    if text.len() > 500 {
        text.truncate(500);
    }
    text.replace("sk-", "sk-[redacted]")
}

async fn proxy_official(state: &BridgeState, request: Request) -> Response {
    let path = request
        .uri()
        .path_and_query()
        .map(|value| value.as_str().to_string())
        .unwrap_or_else(|| request.uri().path().to_string());
    let (parts, body) = request.into_parts();
    let bytes = match axum::body::to_bytes(body, 64 * 1024 * 1024).await {
        Ok(value) => value,
        Err(error) => {
            return (StatusCode::BAD_REQUEST, format!("Unable to read request body: {error}"))
                .into_response()
        }
    };
    proxy_raw(state, parts.method, parts.headers, &path, bytes).await
}

async fn proxy_raw(
    state: &BridgeState,
    method: Method,
    headers: HeaderMap,
    path: &str,
    body: Bytes,
) -> Response {
    let config = state.config.read().await.clone();
    let url = format!("{}{}", config.official_gateway.trim_end_matches('/'), path);
    let mut request = state.client.request(method, &url).body(body);
    for (name, value) in &headers {
        if name.as_str().eq_ignore_ascii_case("host")
            || name.as_str().eq_ignore_ascii_case("content-length")
        {
            continue;
        }
        request = request.header(name, value);
    }
    match request.send().await {
        Ok(upstream) => {
            let status = upstream.status();
            let headers = upstream.headers().clone();
            let stream = upstream.bytes_stream();
            let mut response = Response::new(Body::from_stream(stream));
            *response.status_mut() = status;
            for (name, value) in headers {
                if let Some(name) = name {
                    if name.as_str().eq_ignore_ascii_case("content-length")
                        || name.as_str().eq_ignore_ascii_case("content-encoding")
                    {
                        continue;
                    }
                    response.headers_mut().insert(name, value);
                }
            }
            response
        }
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({"error_message": format!("Official gateway proxy failed: {error}")})),
        )
            .into_response(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let config_path = config_dir().join("config.json");
    let state = AppState {
        config: Arc::new(RwLock::new(load_config(&config_path))),
        logs: Arc::new(RwLock::new(vec![LogEntry {
            time: Local::now().format("%H:%M:%S").to_string(),
            level: "INFO".into(),
            message: "Accio Switch initialized".into(),
        }])),
        bridge: Arc::new(RwLock::new(None)),
        config_path,
    };
    tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            save_config,
            start_bridge,
            stop_bridge,
            test_endpoint,
            launch_accio
        ])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_min_size(Some(tauri::LogicalSize::new(1000.0, 700.0)));
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Accio Switch");
}
