function textFromParts(parts = []) {
  return parts
    .filter((part) => typeof part?.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function parseJson(value, fallback = {}) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === "string" && parsed !== value) return parseJson(parsed, fallback);
    return parsed;
  } catch {
    return fallback;
  }
}

function parseJsonOrText(value, fallback = "") {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string") return fallback;
  if (!value.trim()) return "";
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === "string" && parsed !== value) return parseJsonOrText(parsed, parsed);
    return parsed;
  } catch {
    return value;
  }
}

const MAX_TOOL_CONTENT_CHARS = 32 * 1024;
const MAX_TEXT_CONTENT_CHARS = 96 * 1024;
const MAX_TOOL_DESCRIPTION_CHARS = 1200;
const MAX_SCHEMA_DESCRIPTION_CHARS = 500;
const MAX_SCHEMA_EXAMPLE_CHARS = 800;

function compactToolContent(value, maxChars = MAX_TOOL_CONTENT_CHARS) {
  const content = typeof value === "string" ? value : JSON.stringify(value);
  if (content.length <= maxChars) return content;
  const marker = `\n\n[Accio Switch compacted ${content.length - maxChars} characters from this large tool result]\n\n`;
  const available = Math.max(0, maxChars - marker.length);
  const headLength = Math.ceil(available * 0.67);
  const tailLength = available - headLength;
  return `${content.slice(0, headLength)}${marker}${content.slice(-tailLength)}`;
}

function toolResultContent({ name = "tool", toolCallId = "", value = "", maxChars = MAX_TOOL_CONTENT_CHARS } = {}) {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  const header = [
    "[Accio Switch tool result]",
    `tool: ${name || "tool"}`,
    toolCallId ? `tool_call_id: ${toolCallId}` : "",
    `content_chars: ${raw.length}`,
    raw.length ? "status: non_empty" : "status: empty",
    "---",
  ].filter(Boolean).join("\n");
  const bodyMaxChars = Math.max(0, maxChars - header.length - 1);
  const body = bodyMaxChars ? compactToolContent(raw, bodyMaxChars) : "";
  return `${header}\n${body}`;
}

function compactText(value, maxChars) {
  if (typeof value !== "string" || value.length <= maxChars) return value;
  const marker = `\n\n[Accio Switch compacted ${value.length - maxChars} characters]\n\n`;
  const available = Math.max(0, maxChars - marker.length);
  const headLength = Math.ceil(available * 0.75);
  const tailLength = available - headLength;
  return `${value.slice(0, headLength)}${marker}${value.slice(-tailLength)}`;
}

function compactMessageContent(value, maxChars = MAX_TEXT_CONTENT_CHARS) {
  if (typeof value === "string") return compactText(value, maxChars);
  if (!Array.isArray(value)) return value;
  return value.map((part) => {
    if (typeof part === "string") return compactText(part, maxChars);
    if (part?.text && typeof part.text === "string") return { ...part, text: compactText(part.text, maxChars) };
    if (part?.content && typeof part.content === "string") return { ...part, content: compactText(part.content, maxChars) };
    return part;
  });
}

function compactSchema(value, key = "", options = {}) {
  const maxSchemaDescriptionChars = options.maxSchemaDescriptionChars || MAX_SCHEMA_DESCRIPTION_CHARS;
  const maxSchemaExampleChars = options.maxSchemaExampleChars || MAX_SCHEMA_EXAMPLE_CHARS;
  if (typeof value === "string") {
    const limit = key === "description" || key === "$comment" ? maxSchemaDescriptionChars : maxSchemaExampleChars;
    return key === "description" || key === "$comment" || key === "examples"
      ? compactText(value, limit)
      : value;
  }
  if (Array.isArray(value)) {
    if (key === "examples") {
      return value.slice(0, 3).map((item) => (
        typeof item === "string" ? compactText(item, maxSchemaExampleChars) : compactSchema(item, "", options)
      ));
    }
    return value.map((item) => compactSchema(item, "", options));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [entryKey, compactSchema(entryValue, entryKey, options)]),
  );
}

function normalizeToolArguments(call = {}) {
  const value = call.function?.arguments
    ?? call.function?.args
    ?? call.function?.input
    ?? call.arguments
    ?? call.arguments_json
    ?? call.argsJson
    ?? call.args_json
    ?? call.args
    ?? call.input;
  const parsed = parseJson(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

function firstPresent(source = {}, keys = []) {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function toolCallIdFrom(source = {}) {
  return firstPresent(source, ["id", "toolCallId", "tool_call_id", "callId", "call_id"]);
}

function toolResponseValue(response = {}) {
  if (response.response !== undefined && response.response !== null) return response.response;
  if (response.responseJson !== undefined || response.response_json !== undefined) {
    return parseJsonOrText(response.responseJson ?? response.response_json);
  }
  return response.content ?? response.data ?? "";
}

function normalizeOpenAIToolCall(call = {}, index = 0) {
  return {
    id: toolCallIdFrom(call) || toolCallIdFrom(call.function) || `call_${index + 1}`,
    type: "function",
    function: {
      name: call.function?.name || call.name || "tool",
      arguments: JSON.stringify(normalizeToolArguments(call)),
    },
  };
}

function normalizeMessageContent(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string" || Array.isArray(value)) return value;
  return JSON.stringify(value);
}

function normalizeFlatMessage(item = {}, maxToolContentChars = MAX_TOOL_CONTENT_CHARS, maxTextContentChars = MAX_TEXT_CONTENT_CHARS) {
  const role = item.role === "model" ? "assistant" : item.role || "user";
  const calls = item.toolCalls || item.tool_calls;
  const flatToolCallId = firstPresent(item, ["toolCallId", "tool_call_id", "callId", "call_id"]);

  if (role === "tool" || flatToolCallId) {
    return {
      role: "tool",
      tool_call_id: flatToolCallId || item.id || item.name || "tool",
      content: toolResultContent({
        name: item.name,
        toolCallId: flatToolCallId || item.id,
        value: item.content ?? item.response ?? item.data ?? "",
        maxChars: maxToolContentChars,
      }),
    };
  }

  if (Array.isArray(calls) && calls.length) {
    return {
      role: "assistant",
      content: normalizeMessageContent(item.content, null),
      tool_calls: calls.map((call, index) => normalizeOpenAIToolCall(call, index)),
    };
  }

  return {
    role,
    content: compactMessageContent(normalizeMessageContent(item.content), maxTextContentChars),
  };
}

function normalizeTools(tools = [], options = {}) {
  const maxToolDescriptionChars = options.maxToolDescriptionChars || MAX_TOOL_DESCRIPTION_CHARS;
  const declarations = tools.flatMap((group) => {
    if (group?.name) return [group];
    return group?.functionDeclarations || group?.function_declarations || [];
  });

  return declarations.map((fn) => ({
    type: "function",
    function: {
      name: fn.name,
      description: compactText(fn.description || "", maxToolDescriptionChars),
      parameters: compactSchema(fn.parameters || parseJson(fn.parametersJson || fn.parameters_json, {
        type: "object",
        properties: {},
      }), "", options),
    },
  }));
}

function generationConfigFromInput(input = {}) {
  return input.generationConfig
    || input.generation_config
    || parseJson(input.properties?.generationConfig || input.properties?.generation_config);
}

function isImageOutputRequest(input = {}) {
  const generation = generationConfigFromInput(input);
  const modalities = generation.responseModalities || generation.response_modalities || [];
  return Array.isArray(modalities)
    && modalities.some((modality) => String(modality).toUpperCase() === "IMAGE");
}

function extractImageRequest(input = {}) {
  const generation = generationConfigFromInput(input);
  const imageConfig = generation.imageConfig || generation.image_config || {};
  const prompts = [];
  const images = [];

  for (const item of input.contents || input.messages || []) {
    for (const part of item.parts || []) {
      if (typeof part.text === "string") prompts.push(part.text);
      const inline = part.inlineData || part.inline_data;
      if (inline?.data) {
        images.push({
          mimeType: inline.mimeType || inline.mime_type || "image/png",
          data: inline.data,
        });
      }
      const file = part.fileData || part.file_data;
      if (file?.fileUri || file?.file_uri) {
        images.push({
          mimeType: file.mimeType || file.mime_type || "image/png",
          url: file.fileUri || file.file_uri,
        });
      }
    }
  }

  return {
    prompt: prompts.join("\n\n").trim(),
    images,
    aspectRatio: imageConfig.aspectRatio || imageConfig.aspect_ratio || "1:1",
    imageSize: imageConfig.imageSize || imageConfig.image_size || "1K",
  };
}

function imageSizeForOpenAI(aspectRatio = "1:1") {
  const ratios = {
    "1:1": "1024x1024",
    "3:2": "1536x1024",
    "4:3": "1536x1024",
    "16:9": "1536x1024",
    "2:3": "1024x1536",
    "3:4": "1024x1536",
    "4:5": "1024x1536",
    "9:16": "1024x1536",
  };
  return ratios[aspectRatio] || "1024x1024";
}

function imageFrame({ data, mimeType = "image/png", text = "", model = "" }) {
  const parts = [];
  if (text) parts.push({ text });
  parts.push({ inlineData: { mimeType, data } });
  return {
    content: { role: "model", parts },
    turnComplete: true,
    partial: false,
    finishReason: "STOP",
    customMetadata: { model_name: model, bridge: "accio-switch-image" },
  };
}

function accioToOpenAI(input, model, options = {}) {
  const maxToolContentChars = options.maxToolContentChars || MAX_TOOL_CONTENT_CHARS;
  const maxTextContentChars = options.maxTextContentChars || MAX_TEXT_CONTENT_CHARS;
  const messages = [];
  const system = input.systemInstruction || input.system_instruction;
  const systemText = typeof system === "string" ? system : textFromParts(system?.parts);
  if (systemText) messages.push({ role: "system", content: compactText(systemText, maxTextContentChars) });

  for (const item of input.contents || input.messages || []) {
    if (!Array.isArray(item.parts)) {
      messages.push(normalizeFlatMessage(item, maxToolContentChars, maxTextContentChars));
      continue;
    }

    const role = item.role === "model" ? "assistant" : item.role || "user";
    const content = [];
    const toolCalls = [];
    const toolResponses = [];

    for (const part of item.parts) {
      if (typeof part.text === "string") content.push({ type: "text", text: compactText(part.text, maxTextContentChars) });

      const image = part.inlineData || part.inline_data;
      if (image?.data) {
        content.push({
          type: "image_url",
          image_url: {
            url: `data:${image.mimeType || image.mime_type || "image/png"};base64,${image.data}`,
          },
        });
      }

      const call = part.functionCall || part.function_call;
      if (call?.name) {
        toolCalls.push(normalizeOpenAIToolCall(call, toolCalls.length));
      }

      const response = part.functionResponse || part.function_response;
      if (response?.name || toolCallIdFrom(response)) {
        const value = toolResponseValue(response);
        const toolCallId = toolCallIdFrom(response) || response.name;
        toolResponses.push({
          role: "tool",
          tool_call_id: toolCallId,
          content: toolResultContent({
            name: response.name,
            toolCallId,
            value,
            maxChars: maxToolContentChars,
          }),
        });
      }
    }

    if (toolCalls.length) {
      messages.push({
        role: "assistant",
        content: content.length ? compactText(content.map((part) => part.text || "").join("\n"), maxTextContentChars) : null,
        tool_calls: toolCalls,
      });
    } else if (content.length) {
      const onlyText = content.every((part) => part.type === "text");
      messages.push({
        role,
        content: onlyText ? compactText(content.map((part) => part.text).join("\n"), maxTextContentChars) : content,
      });
    }

    messages.push(...toolResponses);
  }

  const generation = generationConfigFromInput(input);
  const tools = normalizeTools(input.tools, options);
  const requestedMaxTokens = input.maxOutputTokens || input.max_output_tokens
    || generation.maxOutputTokens || generation.max_output_tokens || 16384;
  const maxTokens = options.maxOutputTokens
    ? Math.min(requestedMaxTokens, options.maxOutputTokens)
    : requestedMaxTokens;
  return {
    model,
    messages,
    stream: false,
    temperature: input.temperature ?? generation.temperature ?? 0.7,
    max_tokens: maxTokens,
    ...(input.topP ?? generation.topP ? { top_p: input.topP ?? generation.topP } : {}),
    ...(Array.isArray(input.stopSequences) && input.stopSequences.length
      ? { stop: input.stopSequences }
      : {}),
    ...(tools.length ? { tools, tool_choice: "auto" } : {}),
  };
}

function contentText(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      if (typeof part === "string") return part;
      return part?.text || part?.content || part?.output_text || "";
    })
    .filter(Boolean)
    .join("");
}

function unwrapProviderPayload(payload) {
  let current = payload;
  for (let depth = 0; depth < 3; depth += 1) {
    if (current?.choices || current?.output_text || Array.isArray(current?.output)) return current;
    if (current?.data && typeof current.data === "object") current = current.data;
    else break;
  }
  return current;
}

function responseOutputText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text;
  if (!Array.isArray(payload?.output)) return "";
  return payload.output
    .flatMap((item) => item?.content || [])
    .map((part) => part?.text || part?.output_text || "")
    .filter(Boolean)
    .join("");
}

function responseToolCalls(payload) {
  if (!Array.isArray(payload?.output)) return [];
  return payload.output
    .filter((item) => item?.type === "function_call" || item?.type === "tool_call")
    .map((item) => ({
      id: toolCallIdFrom(item),
      name: item.name || item.function?.name,
      arguments: item.arguments ?? item.input ?? item.function?.arguments,
    }));
}

function openAIToAccio(rawPayload, model) {
  const payload = unwrapProviderPayload(rawPayload);
  const choice = payload?.choices?.[0] || {};
  const message = choice.message || {};
  const regularText = contentText(message.content) || contentText(choice.text) || responseOutputText(payload);
  const reasoningText = contentText(message.reasoning_content || message.reasoning);
  const parts = [];

  if (regularText) parts.push({ text: regularText });
  else if (reasoningText) parts.push({ text: reasoningText });

  const calls = message.tool_calls || (message.function_call ? [{
    id: toolCallIdFrom(message.function_call),
    function: message.function_call,
  }] : responseToolCalls(payload));
  for (const [index, call] of calls.entries()) {
    const name = call.function?.name || call.name || "tool";
    const args = normalizeToolArguments(call);
    parts.push({
      functionCall: {
        id: toolCallIdFrom(call) || `call_${index + 1}`,
        name,
        argsJson: JSON.stringify(args),
      },
    });
  }

  if (!parts.length) {
    const finish = choice.finish_reason || payload?.status || "unknown";
    throw new Error(`Provider returned no text or tool calls (finish=${finish})`);
  }

  return {
    content: { role: "model", parts },
    turnComplete: true,
    partial: false,
    usageMetadata: {
      promptTokenCount: payload?.usage?.prompt_tokens || payload?.usage?.input_tokens || 0,
      candidatesTokenCount: payload?.usage?.completion_tokens || payload?.usage?.output_tokens || 0,
      totalTokenCount: payload?.usage?.total_tokens || 0,
      thoughtsTokenCount: payload?.usage?.completion_tokens_details?.reasoning_tokens,
    },
    finishReason: choice.finish_reason === "length" ? "MAX_TOKENS" : "STOP",
    customMetadata: { model_name: payload?.model || model, bridge: "accio-switch" },
  };
}

function mergeOpenAIChunks(chunks) {
  const merged = {
    choices: [{ message: { content: "", tool_calls: [] }, finish_reason: null }],
    usage: {},
  };
  const toolCalls = new Map();

  for (const chunk of chunks) {
    if (chunk?.usage) merged.usage = chunk.usage;
    if (chunk?.model) merged.model = chunk.model;
    const choice = chunk?.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta || choice.message || {};
    if (typeof delta.content === "string") merged.choices[0].message.content += delta.content;
    if (Array.isArray(delta.content)) {
      if (!Array.isArray(merged.choices[0].message.content)) {
        const existingText = merged.choices[0].message.content;
        merged.choices[0].message.content = existingText ? [{ type: "text", text: existingText }] : [];
      }
      merged.choices[0].message.content.push(...delta.content);
    }
    if (Array.isArray(delta.images)) {
      merged.choices[0].message.images = [
        ...(merged.choices[0].message.images || []),
        ...delta.images,
      ];
    }
    if (typeof delta.reasoning_content === "string") {
      merged.choices[0].message.reasoning_content =
        (merged.choices[0].message.reasoning_content || "") + delta.reasoning_content;
    }
    for (const call of delta.tool_calls || choice.tool_calls || chunk.tool_calls || []) {
      const index = call.index ?? toolCalls.size;
      const existing = toolCalls.get(index) || { id: "", type: "function", function: { name: "", arguments: "" } };
      const id = toolCallIdFrom(call);
      if (id) existing.id += id;
      if (call.function?.name) existing.function.name += call.function.name;
      const nextArguments = call.function?.arguments
        ?? call.function?.args
        ?? call.arguments
        ?? call.args
        ?? call.input;
      if (nextArguments && typeof nextArguments === "object") {
        existing.function.arguments = {
          ...(typeof existing.function.arguments === "object" ? existing.function.arguments : {}),
          ...nextArguments,
        };
      } else if (typeof nextArguments === "string") {
        existing.function.arguments =
          (typeof existing.function.arguments === "string" ? existing.function.arguments : "")
          + nextArguments;
      }
      toolCalls.set(index, existing);
    }
    if (choice.finish_reason) merged.choices[0].finish_reason = choice.finish_reason;
  }

  merged.choices[0].message.tool_calls = [...toolCalls.values()];
  return merged;
}

function parseProviderBody(text, contentType = "") {
  if (contentType.includes("text/event-stream") || /^\s*(data|event):/m.test(text)) {
    const chunks = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter((line) => line && line !== "[DONE]")
      .map((line) => JSON.parse(line));
    if (!chunks.length) throw new Error("Provider returned an empty event stream");
    const imagePayload = [...chunks].reverse().find((chunk) => (
      Array.isArray(chunk?.data) || Array.isArray(chunk?.output)
    ));
    if (imagePayload && !chunks.some((chunk) => chunk?.choices)) return imagePayload;
    return mergeOpenAIChunks(chunks);
  }
  return JSON.parse(text);
}

function findInvalidToolCalls(frame, tools = []) {
  const definitions = new Map(
    tools.map((tool) => [tool.function?.name, tool.function]).filter(([name]) => name),
  );
  return (frame?.content?.parts || [])
    .filter((part) => part.functionCall)
    .map((part) => {
      const call = part.functionCall;
      const args = parseJson(call.argsJson || call.args);
      const required = definitions.get(call.name)?.parameters?.required || [];
      const missing = required.filter((key) => (
        !Object.prototype.hasOwnProperty.call(args, key)
        || args[key] === ""
        || args[key] == null
      ));
      return missing.length ? { id: call.id, name: call.name, missing } : null;
    })
    .filter(Boolean);
}

function buildToolRepairRequest(request, invalidCall) {
  const selectedTool = request.tools?.find((tool) => tool.function?.name === invalidCall.name);
  if (!selectedTool) return null;
  return {
    ...request,
    messages: [
      ...request.messages,
      {
        role: "system",
        content: [
          `Your previous ${invalidCall.name} tool call was invalid because these required arguments were missing: ${invalidCall.missing.join(", ")}.`,
          "Infer the correct values from the conversation and tool description.",
          "Call this tool exactly once with a complete JSON object. Do not answer with text.",
        ].join(" "),
      },
    ],
    tools: [selectedTool],
    tool_choice: { type: "function", function: { name: invalidCall.name } },
  };
}

function sseResponse(res, status, frames) {
  res.writeHead(status, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    "access-control-allow-origin": "*",
  });
  for (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\n\n`);
  res.end();
}

module.exports = {
  accioToOpenAI,
  buildToolRepairRequest,
  compactMessageContent,
  compactToolContent,
  toolResultContent,
  extractImageRequest,
  findInvalidToolCalls,
  imageFrame,
  imageSizeForOpenAI,
  isImageOutputRequest,
  mergeOpenAIChunks,
  normalizeTools,
  normalizeToolArguments,
  openAIToAccio,
  parseProviderBody,
  sseResponse,
};
