const { app, BrowserWindow, ipcMain, safeStorage, shell } = require("electron");
const { execFile, spawn } = require("node:child_process");
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { Readable } = require("node:stream");
const packageInfo = require("../package.json");
const {
  accioToOpenAI,
  buildToolRepairRequest,
  extractImageRequest,
  findInvalidToolCalls,
  imageFrame,
  imageSizeForOpenAI,
  isImageOutputRequest,
  openAIToAccio,
  parseProviderBody,
  sseResponse,
} = require("./protocol.cjs");

const DEFAULT_CONFIG = {
  mode: "custom",
  provider: "OpenAI Compatible",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4.1-mini",
  cachedModels: [],
  modelsLastFetchedAt: "",
  apiKey: "",
  apiKeyConfigured: false,
  imageEnabled: false,
  imageProtocol: "chat-completions",
  imageBaseUrl: "",
  imageModel: "",
  cachedImageModels: [],
  imageModelsLastFetchedAt: "",
  imageApiKey: "",
  imageApiKeyConfigured: false,
  imageReuseChatKey: false,
  autoStartBridge: true,
  bridgePort: 8787,
  officialGateway: "https://phoenix-gw.alibaba.com",
  accioPath: path.join(process.env.LOCALAPPDATA || "", "Programs", "Accio", "Accio.exe"),
  updateFeedUrl: "",
  updateCheckOnStart: false,
};

let config = { ...DEFAULT_CONFIG };
let apiKey = "";
let imageApiKey = "";
let bridgeServer = null;
let logs = [];
let mainWindow = null;
const execFileAsync = promisify(execFile);

const allowMultipleInstances = Boolean(process.env.ACCIO_SWITCH_CAPTURE || process.env.ACCIO_SWITCH_SMOKE);
const singleInstanceLock = allowMultipleInstances || app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
}

function now() {
  return new Date().toLocaleTimeString("en-GB", { hour12: false });
}

function log(level, message) {
  const safeMessage = String(message).replace(/sk-[A-Za-z0-9_-]+/g, "sk-[redacted]");
  logs.push({ time: now(), level, message: safeMessage });
  logs = logs.slice(-300);
  try {
    if (app.isReady()) {
      fs.appendFileSync(storagePaths().log, `${JSON.stringify({ at: new Date().toISOString(), level, message: safeMessage })}\n`);
    }
  } catch {}
}

function storagePaths() {
  const root = app.getPath("userData");
  return {
    config: path.join(root, "config.json"),
    key: path.join(root, "provider-key.bin"),
    imageKey: path.join(root, "image-provider-key.bin"),
    log: path.join(root, "bridge.log"),
    updates: path.join(root, "updates"),
  };
}

function loadConfig() {
  const paths = storagePaths();
  try {
    config = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(paths.config, "utf8")), apiKey: "" };
  } catch {
    config = { ...DEFAULT_CONFIG };
  }
  try {
    const encrypted = fs.readFileSync(paths.key);
    apiKey = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(encrypted) : "";
  } catch {
    apiKey = "";
  }
  try {
    const encrypted = fs.readFileSync(paths.imageKey);
    imageApiKey = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(encrypted) : "";
  } catch {
    imageApiKey = "";
  }
  config.apiKeyConfigured = Boolean(apiKey);
  config.imageApiKeyConfigured = Boolean(imageApiKey);
  log("INFO", "Accio Switch initialized");
}

function saveConfig(next) {
  config = { ...config, ...next };
  if (next.apiKey?.trim()) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows secure storage is not available");
    apiKey = next.apiKey.trim();
    fs.mkdirSync(path.dirname(storagePaths().key), { recursive: true });
    fs.writeFileSync(storagePaths().key, safeStorage.encryptString(apiKey));
  }
  if (next.imageApiKey?.trim()) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows secure storage is not available");
    imageApiKey = next.imageApiKey.trim();
    fs.mkdirSync(path.dirname(storagePaths().imageKey), { recursive: true });
    fs.writeFileSync(storagePaths().imageKey, safeStorage.encryptString(imageApiKey));
  }
  config.apiKey = "";
  config.imageApiKey = "";
  config.apiKeyConfigured = Boolean(apiKey);
  config.imageApiKeyConfigured = Boolean(imageApiKey);
  fs.mkdirSync(path.dirname(storagePaths().config), { recursive: true });
  fs.writeFileSync(storagePaths().config, JSON.stringify(config, null, 2));
  log("INFO", "Configuration saved");
}

async function isAccioRunning() {
  const imageName = path.basename(config.accioPath || "Accio.exe");
  try {
    const { stdout } = await execFileAsync("tasklist.exe", ["/FI", `IMAGENAME eq ${imageName}`, "/FO", "CSV", "/NH"], {
      windowsHide: true,
    });
    return stdout.toLowerCase().includes(`"${imageName.toLowerCase()}"`);
  } catch {
    return false;
  }
}

function jsonResponse(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "access-control-allow-origin": "*",
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024 * 1024) throw new Error("Request body exceeds 64 MB");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function modelList() {
  const configuredModels = Array.isArray(config.cachedModels) && config.cachedModels.length
    ? config.cachedModels
    : [{ id: config.model, displayName: config.model }];
  const models = configuredModels
    .map((model) => (typeof model === "string" ? { id: model, displayName: model } : model))
    .filter((model) => model?.id);

  return [{
    provider: "accio-switch",
    providerDisplayName: "Accio Switch",
    modelList: models.map((model) => ({
      modelCode: model.id,
      modelName: model.id,
      modelDisplayName: model.displayName || model.id,
      modelDesc: model.ownedBy ? `${model.id} via ${model.ownedBy}` : `${model.id} via ${config.provider}`,
      visible: true,
      isDefault: model.id === config.model,
      freeUse: true,
      multimodal: true,
      contextWindow: 128000,
      reasoningEfforts: ["low", "medium", "high"],
      defaultReasoningEffort: "medium",
    })),
  }];
}

function normalizedBaseUrl(value = "") {
  return String(value || "").replace(/\/$/, "");
}

async function fetchProviderModels() {
  if (!apiKey) throw new Error("Configure an API key first");
  if (!config.baseUrl) throw new Error("Configure a Base URL first");
  const started = Date.now();
  const response = await fetch(`${normalizedBaseUrl(config.baseUrl)}/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Model list response parse failed: ${text.slice(0, 240)}`);
  }
  if (!response.ok) {
    throw new Error(`Model list HTTP ${response.status}: ${payload?.error?.message || payload?.message || text.slice(0, 240)}`);
  }
  const rawModels = Array.isArray(payload?.data) ? payload.data : [];
  const seen = new Set();
  const models = rawModels
    .map((item) => ({
      id: item?.id || item?.model || item?.name,
      displayName: item?.id || item?.model || item?.name,
      ownedBy: item?.owned_by || item?.ownedBy || item?.provider || "",
    }))
    .filter((model) => model.id && !seen.has(model.id) && seen.add(model.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (!models.length) throw new Error("Model list endpoint returned no models");
  const selectedExists = models.some((model) => model.id === config.model);
  config.cachedModels = models;
  config.modelsLastFetchedAt = new Date().toISOString();
  if (!config.model || !selectedExists) config.model = models[0].id;
  saveConfig({});
  log("INFO", `Fetched ${models.length} upstream model(s) in ${Date.now() - started} ms`);
  return {
    models,
    selectedModel: config.model,
    fetchedAt: config.modelsLastFetchedAt,
  };
}

function looksLikeApiKey(value = "") {
  return /^sk-[A-Za-z0-9_-]{16,}/.test(String(value).trim());
}

function imageModelValue() {
  const model = String(config.imageModel || "").trim();
  if (looksLikeApiKey(model)) {
    throw new Error("Image model looks like an API key. Put the key in API key, and choose a real image model name.");
  }
  if (!model) {
    throw new Error("Image model is not configured. Choose an image-capable model; chat models are not reused automatically.");
  }
  return model;
}

async function fetchImageProviderModels() {
  const key = config.imageReuseChatKey ? apiKey : imageApiKey;
  if (!key) throw new Error("Configure an image API key first");
  const baseUrl = normalizedBaseUrl(config.imageBaseUrl || config.baseUrl);
  if (!baseUrl) throw new Error("Configure an image Base URL first");
  const started = Date.now();
  const response = await fetch(`${baseUrl}/models`, {
    headers: { authorization: `Bearer ${key}` },
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Image model list response parse failed: ${text.slice(0, 240)}`);
  }
  if (!response.ok) {
    throw new Error(`Image model list HTTP ${response.status}: ${payload?.error?.message || payload?.message || text.slice(0, 240)}`);
  }
  const rawModels = Array.isArray(payload?.data) ? payload.data : [];
  const seen = new Set();
  const models = rawModels
    .map((item) => ({
      id: item?.id || item?.model || item?.name,
      displayName: item?.id || item?.model || item?.name,
      ownedBy: item?.owned_by || item?.ownedBy || item?.provider || "",
    }))
    .filter((model) => model.id && !seen.has(model.id) && seen.add(model.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (!models.length) throw new Error("Image model list endpoint returned no models");
  const selected = (() => {
    try {
      return imageModelValue();
    } catch {
      return "";
    }
  })();
  const selectedExists = models.some((model) => model.id === selected);
  config.cachedImageModels = models;
  config.imageModelsLastFetchedAt = new Date().toISOString();
  if (!selected || !selectedExists) config.imageModel = models[0].id;
  saveConfig({});
  log("INFO", `Fetched ${models.length} upstream image model(s) in ${Date.now() - started} ms`);
  return {
    models,
    selectedModel: config.imageModel,
    fetchedAt: config.imageModelsLastFetchedAt,
  };
}

async function requestProvider(providerRequest) {
  const requestBody = JSON.stringify(providerRequest);
  const url = `${normalizedBaseUrl(config.baseUrl)}/chat/completions`;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: requestBody,
    });
    const responseText = await response.text();
    const contentType = response.headers.get("content-type") || "";
    if (!response.ok) {
      const title = responseText.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim();
      const cloudflareCode = responseText.match(/(?:Error|error code:?)\s*(5\d\d)/i)?.[1];
      const upstreamError = responseText.match(/"type"\s*:\s*"upstream_error"/i);
      const upstreamStatus = responseText.match(/"message"\s*:\s*"(5\d\d)"/i)?.[1];
      const providerError = parseProviderErrorMessage(responseText);
      const detail = providerError || title || (cloudflareCode ? `Cloudflare error ${cloudflareCode}` : responseText.slice(0, 240));
      const transient = (response.status >= 500 && response.status <= 599)
        || (response.status === 429 && upstreamError && upstreamStatus);
      if (transient && attempt === 1) {
        log("WARN", `Provider HTTP ${response.status}${upstreamStatus ? ` upstream ${upstreamStatus}` : ""}; retrying custom endpoint once (${requestBody.length} request chars)`);
        await new Promise((resolve) => setTimeout(resolve, 1200));
        continue;
      }
      throw new Error(`Provider HTTP ${response.status}: ${detail}`);
    }
    try {
      return parseProviderBody(responseText, contentType);
    } catch (error) {
      const looksHtml = /^\s*(?:<!doctype|<html)/i.test(responseText);
      const title = responseText.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim();
      throw new Error(
        looksHtml
          ? `Provider returned HTML instead of JSON${title ? `: ${title}` : ""}`
          : `Provider response parse failed: ${error.message}; body=${responseText.slice(0, 240)}`,
      );
    }
  }
  throw new Error("Provider request failed after retry");
}

function parseProviderErrorMessage(responseText = "") {
  try {
    const payload = JSON.parse(responseText);
    return payload?.error?.message || payload?.message || payload?.errorMessage || "";
  } catch {
    return "";
  }
}

function summarizeToolResults(messages = []) {
  const nameById = new Map();
  for (const message of messages) {
    for (const call of message.tool_calls || []) {
      if (call.id) nameById.set(call.id, call.function?.name || "tool");
    }
  }
  const toolMessages = messages.filter((message) => message.role === "tool");
  if (!toolMessages.length) return "";
  const totalChars = toolMessages.reduce((sum, message) => sum + String(message.content || "").length, 0);
  const longest = toolMessages.reduce((best, message) => {
    const length = String(message.content || "").length;
    return length > best.length
      ? { id: message.tool_call_id || "", name: nameById.get(message.tool_call_id) || "tool", length }
      : best;
  }, { id: "", name: "tool", length: 0 });
  return `, toolResults=${toolMessages.length}, toolResultChars=${totalChars}, longestToolResult=${longest.name}:${longest.length}`;
}

function valueLength(value) {
  if (value === undefined || value === null) return 0;
  return typeof value === "string" ? value.length : JSON.stringify(value).length;
}

function summarizeAccioToolInputs(input = {}) {
  const records = [];
  for (const [index, item] of (input.contents || input.messages || []).entries()) {
    const itemKeys = Object.keys(item || {}).join("|") || "none";
    const flatToolId = item?.toolCallId || item?.tool_call_id || item?.callId || item?.call_id;
    if (item?.role === "tool" || flatToolId) {
      records.push({
        kind: "flat",
        index: index + 1,
        name: item.name || "tool",
        keys: itemKeys,
        contentChars: valueLength(item.content),
        responseChars: valueLength(item.response),
        dataChars: valueLength(item.data),
      });
    }
    for (const [partIndex, part] of (item?.parts || []).entries()) {
      const response = part.functionResponse || part.function_response;
      if (!response) continue;
      records.push({
        kind: "part",
        index: index + 1,
        part: partIndex + 1,
        name: response.name || "tool",
        keys: itemKeys,
        contentChars: valueLength(response.content),
        responseChars: valueLength(response.response ?? response.responseJson ?? response.response_json),
        dataChars: valueLength(response.data),
      });
    }
  }
  if (!records.length) return "";
  const totalChars = records.reduce((sum, record) => (
    sum + record.contentChars + record.responseChars + record.dataChars
  ), 0);
  const longest = records.reduce((best, record) => {
    const length = Math.max(record.contentChars, record.responseChars, record.dataChars);
    return length > best.length ? { name: record.name, kind: record.kind, length } : best;
  }, { name: "tool", kind: "flat", length: 0 });
  const shapes = records
    .slice(0, 4)
    .map((record) => `${record.kind}:${record.name}:content=${record.contentChars}:response=${record.responseChars}:data=${record.dataChars}:keys=${record.keys}`)
    .join("; ");
  return `Accio input tool payloads: count=${records.length}, totalValueChars=${totalChars}, longest=${longest.kind}:${longest.name}:${longest.length}, shapes=${shapes}`;
}

async function callCustomLLM(input) {
  if (!apiKey) throw new Error("API key is not configured");
  const started = Date.now();
  const accioToolSummary = summarizeAccioToolInputs(input);
  if (accioToolSummary) log("INFO", accioToolSummary);
  let providerRequest = accioToOpenAI(input, config.model);
  let requestChars = JSON.stringify(providerRequest).length;
  if (requestChars > 180000) {
    providerRequest = accioToOpenAI(input, config.model, { maxToolContentChars: 12 * 1024 });
    const compactedChars = JSON.stringify(providerRequest).length;
    log("WARN", `Large LLM request compacted from ${requestChars} to ${compactedChars} chars before upstream call`);
    requestChars = compactedChars;
  }
  log("INFO", `LLM request: model=${config.model}, messages=${providerRequest.messages.length}, tools=${providerRequest.tools?.length || 0}, requestChars=${requestChars}${summarizeToolResults(providerRequest.messages)}`);
  let payload = await requestProvider(providerRequest);
  let converted = openAIToAccio(payload, config.model);
  const invalidCalls = findInvalidToolCalls(converted, providerRequest.tools);
  if (invalidCalls.length) {
    const invalid = invalidCalls[0];
    const repairRequest = buildToolRepairRequest(providerRequest, invalid);
    if (!repairRequest) throw new Error(`Cannot repair unknown tool call: ${invalid.name}`);
    log("WARN", `Repairing ${invalid.name} tool call; missing arguments: ${invalid.missing.join(", ")}`);
    payload = await requestProvider(repairRequest);
    converted = openAIToAccio(payload, config.model);
    const repairedCalls = converted.content.parts.filter((part) => part.functionCall?.name === invalid.name);
    const remainingInvalid = findInvalidToolCalls(converted, repairRequest.tools);
    if (!repairedCalls.length || remainingInvalid.length) {
      throw new Error(`Provider could not produce valid arguments for ${invalid.name}`);
    }
  }
  const textLength = converted.content.parts.reduce((sum, part) => sum + (part.text?.length || 0), 0);
  const toolCalls = converted.content.parts.filter((part) => part.functionCall);
  const toolSummary = toolCalls.map((part) => {
    let args = {};
    try {
      args = JSON.parse(part.functionCall.argsJson || "{}");
    } catch {}
    const keys = Object.keys(args);
    return `${part.functionCall.name}(${keys.join(",") || "no args"})`;
  }).join(", ");
  log("INFO", `${config.model} completed through ${config.provider} in ${Date.now() - started} ms (${textLength} text chars, ${toolCalls.length} tool calls${toolSummary ? `: ${toolSummary}` : ""})`);
  return converted;
}

function imageCredentials() {
  return {
    baseUrl: normalizedBaseUrl(config.imageBaseUrl || config.baseUrl),
    model: imageModelValue(),
    key: config.imageReuseChatKey ? apiKey : imageApiKey,
  };
}

function compareVersions(a = "", b = "") {
  const left = String(a).replace(/^v/i, "").split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const right = String(b).replace(/^v/i, "").split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if ((left[index] || 0) > (right[index] || 0)) return 1;
    if ((left[index] || 0) < (right[index] || 0)) return -1;
  }
  return 0;
}

async function checkForUpdate(feedUrl = config.updateFeedUrl) {
  if (!feedUrl) throw new Error("Configure an update feed URL first");
  const response = await fetch(`${feedUrl}${feedUrl.includes("?") ? "&" : "?"}t=${Date.now()}`, {
    headers: { accept: "application/json" },
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Update feed parse failed: ${text.slice(0, 240)}`);
  }
  if (!response.ok) throw new Error(`Update feed HTTP ${response.status}: ${payload?.message || text.slice(0, 240)}`);
  if (!payload?.version || !payload?.url) throw new Error("Update feed must include version and url");
  const hasUpdate = compareVersions(payload.version, packageInfo.version) > 0;
  const belowMinimum = payload.minVersion ? compareVersions(packageInfo.version, payload.minVersion) < 0 : false;
  return {
    currentVersion: packageInfo.version,
    hasUpdate,
    mandatory: Boolean(payload.mandatory || belowMinimum),
    version: payload.version,
    channel: payload.channel || "stable",
    url: payload.url,
    sha256: payload.sha256 || "",
    notes: payload.notes || payload.changelog || "",
    minVersion: payload.minVersion || "",
  };
}

async function downloadUpdate(feedUrl = config.updateFeedUrl) {
  const update = await checkForUpdate(feedUrl);
  if (!update.hasUpdate) return { ...update, downloaded: false };
  const response = await fetch(update.url);
  if (!response.ok) throw new Error(`Update download HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  if (update.sha256 && sha256.toLowerCase() !== update.sha256.toLowerCase()) {
    throw new Error(`Update checksum mismatch: expected ${update.sha256}, got ${sha256}`);
  }
  const updatesDir = storagePaths().updates;
  fs.mkdirSync(updatesDir, { recursive: true });
  const fileName = path.basename(new URL(update.url).pathname) || `Accio-Switch-${update.version}.exe`;
  const filePath = path.join(updatesDir, fileName);
  fs.writeFileSync(filePath, bytes);
  log("INFO", `Downloaded update ${update.version} to ${filePath}`);
  return {
    ...update,
    downloaded: true,
    filePath,
    sha256,
    size: bytes.length,
  };
}

function launchDownloadedUpdate(filePath) {
  const updatesDir = path.resolve(storagePaths().updates);
  const resolved = path.resolve(filePath || "");
  if (!resolved.startsWith(updatesDir + path.sep)) throw new Error("Update file is outside the updates directory");
  if (!fs.existsSync(resolved)) throw new Error(`Update file not found: ${resolved}`);
  spawn(resolved, [], { detached: true, stdio: "ignore", windowsHide: false }).unref();
  log("INFO", `Launching downloaded update: ${path.basename(resolved)}`);
  setTimeout(() => app.quit(), 500);
  return { launched: true };
}

async function fetchImageAsBase64(url, authorization) {
  const response = await fetch(url, {
    headers: authorization ? { authorization } : {},
  });
  if (!response.ok) throw new Error(`Image download failed with HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") || "image/png";
  const bytes = Buffer.from(await response.arrayBuffer());
  return { data: bytes.toString("base64"), mimeType: contentType.split(";")[0] };
}

function dataUrlImage(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/^data:([^;,]+);base64,(.+)$/s);
  return match ? { mimeType: match[1], data: match[2] } : null;
}

async function imageFromProviderPayload(payload, authorization) {
  const candidates = [
    ...(Array.isArray(payload?.data) ? payload.data : []),
    ...(Array.isArray(payload?.output) ? payload.output : []),
    ...(Array.isArray(payload?.choices) ? payload.choices : []),
  ];
  for (const item of candidates) {
    const message = item?.message || item;
    const content = Array.isArray(message?.content) ? message.content : [];
    const values = [
      item?.b64_json,
      item?.base64,
      item?.result,
      item?.image,
      item?.url,
      message?.image,
      message?.images?.[0]?.image_url?.url,
      message?.images?.[0]?.url,
      ...content.flatMap((part) => [
        part?.image_url?.url,
        part?.image_url,
        part?.inline_data?.data,
        part?.inlineData?.data,
        part?.data,
      ]),
    ].filter(Boolean);
    for (const value of values) {
      const parsed = dataUrlImage(value);
      if (parsed) return parsed;
      if (typeof value === "string" && /^https?:\/\//i.test(value)) {
        return fetchImageAsBase64(value, authorization);
      }
      if (typeof value === "string" && value.length > 256) {
        return {
          data: value,
          mimeType: item?.mime_type || item?.mimeType
            || content.find((part) => part?.inline_data || part?.inlineData)?.inline_data?.mime_type
            || content.find((part) => part?.inlineData)?.inlineData?.mimeType
            || "image/png",
        };
      }
    }
  }
  throw new Error(`Image provider returned no image data: ${JSON.stringify(payload).slice(0, 500)}`);
}

async function callChatImage(input, credentials) {
  const request = accioToOpenAI(input, credentials.model);
  request.modalities = ["text", "image"];
  request.generation_config = generationConfigFromInputSafe(input);
  delete request.tools;
  delete request.tool_choice;
  const authorization = `Bearer ${credentials.key}`;
  const response = await fetch(`${credentials.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization },
    body: JSON.stringify(request),
  });
  const text = await response.text();
  let payload;
  try {
    payload = parseProviderBody(text, response.headers.get("content-type") || "");
  } catch {
    throw new Error(`Image provider response parse failed: ${text.slice(0, 500)}`);
  }
  if (!response.ok) throw new Error(`Image provider HTTP ${response.status}: ${JSON.stringify(payload).slice(0, 500)}`);
  const image = await imageFromProviderPayload(payload, authorization);
  return imageFrame({ ...image, model: credentials.model });
}

function generationConfigFromInputSafe(input) {
  const direct = input.generationConfig || input.generation_config;
  if (direct) return direct;
  try {
    return JSON.parse(input.properties?.generationConfig || input.properties?.generation_config || "{}");
  } catch {
    return {};
  }
}

async function resolveImageInput(image, authorization) {
  if (image.data) return Buffer.from(image.data, "base64");
  const response = await fetch(image.url, { headers: authorization ? { authorization } : {} });
  if (!response.ok) throw new Error(`Reference image download failed with HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function callOpenAIImages(input, credentials) {
  const imageRequest = extractImageRequest(input);
  const authorization = `Bearer ${credentials.key}`;
  const isEdit = imageRequest.images.length > 0;
  let response;
  if (isEdit) {
    const form = new FormData();
    form.set("model", credentials.model);
    form.set("prompt", imageRequest.prompt);
    form.set("size", imageSizeForOpenAI(imageRequest.aspectRatio));
    for (const [index, image] of imageRequest.images.entries()) {
      const bytes = await resolveImageInput(image, authorization);
      form.append("image", new Blob([bytes], { type: image.mimeType }), `reference-${index}.png`);
    }
    response = await fetch(`${credentials.baseUrl}/images/edits`, {
      method: "POST",
      headers: { authorization },
      body: form,
    });
  } else {
    response = await fetch(`${credentials.baseUrl}/images/generations`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify({
        model: credentials.model,
        prompt: imageRequest.prompt,
        n: 1,
        size: imageSizeForOpenAI(imageRequest.aspectRatio),
      }),
    });
  }
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Image provider response parse failed: ${text.slice(0, 500)}`);
  }
  if (!response.ok) throw new Error(`Image provider HTTP ${response.status}: ${JSON.stringify(payload).slice(0, 500)}`);
  const image = await imageFromProviderPayload(payload, authorization);
  return imageFrame({ ...image, model: credentials.model });
}

async function callCustomImage(input) {
  if (!config.imageEnabled) throw new Error("Image routing is not configured in Accio Switch");
  const credentials = imageCredentials();
  if (!credentials.key) throw new Error("Image API key is not configured");
  if (!credentials.model) throw new Error("Image model is not configured");
  const started = Date.now();
  log("INFO", `Image request: model=${looksLikeApiKey(credentials.model) ? "sk-[redacted]" : credentials.model}, protocol=${config.imageProtocol}`);
  const result = config.imageProtocol === "openai-images"
    ? await callOpenAIImages(input, credentials)
    : await callChatImage(input, credentials);
  log("INFO", `${credentials.model} image completed in ${Date.now() - started} ms through custom provider`);
  return result;
}

async function proxyOfficial(req, res, body) {
  const target = `${config.officialGateway.replace(/\/$/, "")}${req.url}`;
  const headers = { ...req.headers };
  delete headers.host;
  delete headers["content-length"];
  const response = await fetch(target, {
    method: req.method,
    headers,
    body: ["GET", "HEAD"].includes(req.method) ? undefined : body,
    duplex: "half",
  });
  const responseHeaders = {};
  response.headers.forEach((value, key) => {
    if (!["content-length", "content-encoding"].includes(key.toLowerCase())) responseHeaders[key] = value;
  });
  res.writeHead(response.status, responseHeaders);
  if (response.body) Readable.fromWeb(response.body).pipe(res);
  else res.end();
}

async function handleBridge(req, res) {
  if (req.method === "OPTIONS") return jsonResponse(res, 204, {});
  if (req.url === "/health") return jsonResponse(res, 200, { ok: true, model: config.model, provider: config.provider });
  if (req.url.split("?")[0] === "/api/llm/config/v2") return jsonResponse(res, 200, modelList());
  const body = await readBody(req);
  if (req.url.startsWith("/api/adk/llm") && req.method === "POST") {
    try {
      const input = JSON.parse(body.toString("utf8"));
      if (isImageOutputRequest(input)) {
        return sseResponse(res, 200, [await callCustomImage(input)]);
      }
      return sseResponse(res, 200, [await callCustomLLM(input)]);
    } catch (error) {
      log("ERROR", `Custom LLM failed: ${error.message}`);
      return sseResponse(res, 502, [{
        errorCode: "502",
        errorMessage: error.message,
        turnComplete: true,
        partial: false,
      }]);
    }
  }
  await proxyOfficial(req, res, body);
}

async function startBridge() {
  if (bridgeServer) return;
  await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      handleBridge(req, res).catch((error) => {
        log("ERROR", error.message);
        if (!res.headersSent) jsonResponse(res, 502, { error_message: error.message });
        else res.end();
      });
    });
    server.once("error", reject);
    server.listen(config.bridgePort, "127.0.0.1", () => {
      bridgeServer = server;
      log("INFO", `Bridge listening on http://127.0.0.1:${config.bridgePort}`);
      resolve();
    });
  });
}

async function stopBridge() {
  if (!bridgeServer) return;
  const server = bridgeServer;
  bridgeServer = null;
  await new Promise((resolve) => server.close(resolve));
  log("INFO", "Bridge stopped");
}

function registerIpc() {
  ipcMain.handle("accio-switch:get_snapshot", async () => ({
    config: {
      ...config,
      apiKey: "",
      imageApiKey: "",
      apiKeyConfigured: Boolean(apiKey),
      imageApiKeyConfigured: Boolean(imageApiKey),
    },
    bridgeRunning: Boolean(bridgeServer),
    accioRunning: await isAccioRunning(),
    appVersion: packageInfo.version,
    logs,
  }));
  ipcMain.handle("accio-switch:save_config", (_event, { config: next }) => {
    saveConfig(next);
    return { ok: true };
  });
  ipcMain.handle("accio-switch:start_bridge", async () => {
    await startBridge();
    return { running: true };
  });
  ipcMain.handle("accio-switch:stop_bridge", async () => {
    await stopBridge();
    return { running: false };
  });
  ipcMain.handle("accio-switch:test_endpoint", async () => {
    if (!apiKey) throw new Error("Configure an API key first");
    const started = Date.now();
    try {
      const payload = await requestProvider({
        model: config.model,
        messages: [{ role: "user", content: "Reply with OK." }],
        stream: false,
        temperature: 0,
        max_tokens: 8,
      });
      const result = {
        ok: true,
        latencyMs: Date.now() - started,
        modelFound: payload?.model ? String(payload.model).includes(config.model) : true,
        message: "Chat endpoint reachable",
      };
      log("INFO", `Endpoint test: ${result.message}`);
      return result;
    } catch (error) {
      log("ERROR", `Endpoint test failed: ${error.message}`);
      throw error;
    }
  });
  ipcMain.handle("accio-switch:fetch_models", async () => fetchProviderModels());
  ipcMain.handle("accio-switch:fetch_image_models", async () => fetchImageProviderModels());
  ipcMain.handle("accio-switch:check_update", async (_event, { feedUrl } = {}) => checkForUpdate(feedUrl || config.updateFeedUrl));
  ipcMain.handle("accio-switch:download_update", async (_event, { feedUrl } = {}) => downloadUpdate(feedUrl || config.updateFeedUrl));
  ipcMain.handle("accio-switch:open_update_file", async (_event, { filePath } = {}) => {
    if (!filePath) throw new Error("No update file path provided");
    await shell.showItemInFolder(filePath);
    return { ok: true };
  });
  ipcMain.handle("accio-switch:install_update", async (_event, { filePath } = {}) => launchDownloadedUpdate(filePath));
  ipcMain.handle("accio-switch:test_image_endpoint", async () => {
    const credentials = imageCredentials();
    if (!credentials.key) throw new Error("Configure an image API key first");
    const started = Date.now();
    const response = await fetch(`${credentials.baseUrl}/models`, {
      headers: { authorization: `Bearer ${credentials.key}` },
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {}
    const models = Array.isArray(payload?.data) ? payload.data.map((item) => item?.id || item?.model || item?.name).filter(Boolean) : [];
    const modelFound = models.length ? models.includes(credentials.model) : text.includes(credentials.model);
    const result = {
      ok: response.ok,
      latencyMs: Date.now() - started,
      modelFound,
      models,
      message: response.ok && modelFound
        ? "Image endpoint reachable"
        : response.ok
          ? `Image endpoint reachable, but model '${credentials.model}' was not found`
          : `Image endpoint returned HTTP ${response.status}: ${payload?.error?.message || payload?.message || text.slice(0, 240)}`,
    };
    result.ok = result.ok && result.modelFound;
    log(result.ok ? "INFO" : "ERROR", `Image endpoint test: ${result.message}`);
    return result;
  });
  ipcMain.handle("accio-switch:launch_accio", async () => {
    if (!fs.existsSync(config.accioPath)) throw new Error(`Accio executable not found: ${config.accioPath}`);
    if (await isAccioRunning()) {
      throw new Error("Accio Work is already running. Quit it completely, then launch it from Accio Switch so the route variables can take effect.");
    }
    if (config.mode === "custom" && config.autoStartBridge) await startBridge();
    const env = { ...process.env };
    if (config.mode === "custom") {
      env.GATEWAY_BASE_URL = `http://127.0.0.1:${config.bridgePort}`;
      env.ADK_MODEL = config.model;
    } else {
      delete env.GATEWAY_BASE_URL;
      delete env.ADK_MODEL;
    }
    spawn(config.accioPath, [], { env, detached: true, stdio: "ignore", windowsHide: false }).unref();
    const message = `Accio Work launched in ${config.mode} mode`;
    log("INFO", message);
    return { launched: true, message };
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    show: !process.env.ACCIO_SWITCH_CAPTURE,
    width: 1440,
    height: 1024,
    useContentSize: true,
    minWidth: 1000,
    minHeight: 700,
    backgroundColor: "#fafaf8",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const window = mainWindow;
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
  const devUrl = process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:5173";
  const useDist = app.isPackaged || Boolean(process.env.ACCIO_SWITCH_CAPTURE) || Boolean(process.env.ACCIO_SWITCH_SMOKE);
  if (useDist) window.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  else window.loadURL(devUrl);
  if (process.env.ACCIO_SWITCH_CAPTURE) {
    window.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        const image = await window.webContents.capturePage();
        const output = process.env.ACCIO_SWITCH_CAPTURE;
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output, image.toPNG());
        app.quit();
      }, 1600);
    });
  }
  if (process.env.ACCIO_SWITCH_SMOKE) {
    window.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        const report = await window.webContents.executeJavaScript(`
          (async () => {
            const result = {};
            const byText = (text) => [...document.querySelectorAll('button')]
              .find((button) => button.textContent.trim().includes(text));
            result.initialTitle = document.querySelector('h1')?.textContent;
            byText('Settings')?.click();
            await new Promise((resolve) => setTimeout(resolve, 80));
            result.settingsVisible = document.body.textContent.includes('Local service and Accio installation paths.');
            byText('Route')?.click();
            await new Promise((resolve) => setTimeout(resolve, 80));
            byText('Official')?.click();
            await new Promise((resolve) => setTimeout(resolve, 80));
            result.officialMutesCustom = document.querySelector('.custom-config')?.classList.contains('is-muted');
            byText('Custom')?.click();
            await window.accioSwitch.invoke('start_bridge');
            const health = await fetch('http://127.0.0.1:8787/health').then((response) => response.json());
            result.bridgeHealth = health;
            await window.accioSwitch.invoke('stop_bridge');
            result.bridgeStopped = true;
            return result;
          })()
        `);
        const output = process.env.ACCIO_SWITCH_SMOKE;
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output, JSON.stringify(report, null, 2));
        app.quit();
      }, 1200);
    });
  }
}

function showMainWindow() {
  const window = mainWindow || BrowserWindow.getAllWindows()[0];
  if (!window) return;
  if (window.isMinimized()) window.restore();
  if (!window.isVisible()) window.show();
  window.focus();
}

if (!allowMultipleInstances) {
  app.on("second-instance", () => {
    showMainWindow();
  });
}

app.whenReady().then(() => {
  if (!singleInstanceLock) return;
  loadConfig();
  registerIpc();
  createWindow();
});

app.on("window-all-closed", async () => {
  await stopBridge();
  if (process.platform !== "darwin") app.quit();
});
