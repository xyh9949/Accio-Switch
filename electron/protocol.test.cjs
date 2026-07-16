const assert = require("node:assert/strict");
const test = require("node:test");
const {
  accioToOpenAI,
  buildToolRepairRequest,
  compactToolContent,
  extractImageRequest,
  findInvalidToolCalls,
  imageFrame,
  imageSizeForOpenAI,
  isImageOutputRequest,
  openSseResponse,
  openAIToAccio,
  parseProviderBody,
  requestedModelFromAccio,
  sseResponse,
  toolResultContent,
} = require("./protocol.cjs");
const {
  findAlibabaAuthorizationStatus,
  findGatewayStatus,
  forcedModelRoutingResponse,
  isModelRoutingRequest,
} = require("./routing.cjs");

test("intercepts only RLab automatic model-routing calls", () => {
  assert.equal(
    isModelRoutingRequest("/api/tool/rlab/call", "POST", Buffer.from('{"function":"model_routing","payload":{}}')),
    true,
  );
  assert.equal(
    isModelRoutingRequest("/api/tool/rlab/call", "POST", Buffer.from('{"function":"other_tool"}')),
    false,
  );
  assert.deepEqual(forcedModelRoutingResponse("gpt-5.5"), {
    success: true,
    data: {
      payload: {
        modelCode: "gpt-5.5",
        shouldCompact: false,
        reason: "accio_switch_forced",
      },
    },
  });
});

test("verifies the gateway from Accio's own startup log", () => {
  const since = 1782120000000;
  const text = [
    JSON.stringify({ timestamp: since - 1000, message: "[Gateway] Config: gatewayBaseUrl=https://phoenix-gw.alibaba.com" }),
    JSON.stringify({ timestamp: since + 1000, message: "[Gateway] Config: gatewayBaseUrl=http://127.0.0.1:8787, ADK_EMPID=undefined" }),
  ].join("\n");
  assert.deepEqual(findGatewayStatus(text, since, "http://127.0.0.1:8787"), {
    verified: true,
    message: "[Gateway] Config: gatewayBaseUrl=http://127.0.0.1:8787, ADK_EMPID=undefined",
    timestamp: since + 1000,
  });
});

test("recognizes Alibaba official account authorization after startup preflight", () => {
  const since = 1782120000000;
  const text = [
    JSON.stringify({
      timestamp: since + 1000,
      message: "[preflight-connector] alibaba → unauthorized (cm undefined)",
    }),
    JSON.stringify({
      timestamp: since + 2000,
      message: '[connector-debug] kind=list_response stage=success payload={"response":[{"id":"alibaba","status":"authorized","connectedCount":1}]}',
    }),
  ].join("\n");
  assert.deepEqual(findAlibabaAuthorizationStatus(text, since), {
    connected: true,
    message: '[connector-debug] kind=list_response stage=success payload={"response":[{"id":"alibaba","status":"authorized","connectedCount":1}]}',
    timestamp: since + 2000,
  });
});

test("converts the current Accio proto-shaped request", () => {
  const converted = accioToOpenAI({
    systemInstruction: "Be concise.",
    contents: [{ role: "user", parts: [{ text: "Hello" }] }],
    tools: [{
      name: "search",
      description: "Search things",
      parametersJson: JSON.stringify({ type: "object", properties: { query: { type: "string" } } }),
    }],
    temperature: 0.2,
    maxOutputTokens: 512,
  }, "custom-model");

  assert.equal(converted.model, "custom-model");
  assert.deepEqual(converted.messages.slice(0, 2), [
    { role: "system", content: "Be concise." },
    { role: "user", content: "Hello" },
  ]);
  assert.equal(converted.tools[0].function.name, "search");
  assert.equal(converted.temperature, 0.2);
  assert.equal(converted.max_tokens, 512);
  assert.equal(converted.stream, true);
});

test("opens an SSE response immediately and reuses its headers for the final frame", () => {
  const writes = [];
  const response = {
    headersSent: false,
    writeHead(status, headers) {
      this.headersSent = true;
      this.status = status;
      this.headers = headers;
    },
    flushHeaders() {
      this.flushed = true;
    },
    write(value) {
      writes.push(value);
    },
    end() {
      this.ended = true;
    },
  };

  openSseResponse(response, 200);
  assert.equal(response.flushed, true);
  assert.equal(response.headers["content-type"], "text/event-stream; charset=utf-8");
  openSseResponse(response, 502);
  assert.equal(response.status, 200);
  sseResponse(response, 200, [{ turnComplete: true }]);
  assert.match(writes[0], /"turnComplete":true/);
  assert.equal(response.ended, true);
});

test("uses the model selected in Accio and falls back for Auto", () => {
  assert.equal(requestedModelFromAccio({ model: "gpt-5.5" }, "gpt-5.6-sol"), "gpt-5.5");
  assert.equal(requestedModelFromAccio({ modelCode: "gpt-5.4-mini" }, "gpt-5.6-sol"), "gpt-5.4-mini");
  assert.equal(requestedModelFromAccio({ properties: { model: "gpt-5-mini" } }, "gpt-5.6-sol"), "gpt-5-mini");
  assert.equal(requestedModelFromAccio({ model: "auto" }, "gpt-5.6-sol"), "gpt-5.6-sol");
  assert.equal(requestedModelFromAccio({}, "gpt-5.6-sol"), "gpt-5.6-sol");

  const request = accioToOpenAI({
    model: "gpt-5.5",
    contents: [{ role: "user", parts: [{ text: "Hello" }] }],
  }, "gpt-5.6-sol");
  assert.equal(request.model, "gpt-5.5");
});

test("normalizes text and tool calls into an Accio frame", () => {
  const frame = openAIToAccio({
    model: "custom-model",
    choices: [{
      message: {
        content: [{ type: "text", text: "Working" }],
        tool_calls: [{
          id: "call_1",
          function: { name: "search", arguments: "{\"query\":\"shoes\"}" },
        }],
      },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
  }, "custom-model");

  assert.equal(frame.content.parts[0].text, "Working");
  assert.equal(frame.content.parts[1].functionCall.name, "search");
  assert.deepEqual(JSON.parse(frame.content.parts[1].functionCall.argsJson), { query: "shoes" });
  assert.equal(frame.turnComplete, true);
});

test("rejects provider responses with no useful output", () => {
  assert.throws(
    () => openAIToAccio({ choices: [{ message: { content: null }, finish_reason: "stop" }] }, "custom-model"),
    /no text or tool calls/,
  );
});

test("merges an OpenAI-compatible SSE response", () => {
  const body = [
    'data: {"model":"custom-model","choices":[{"delta":{"content":"Hel"},"finish_reason":null}]}',
    "",
    'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const payload = parseProviderBody(body, "text/event-stream");
  const frame = openAIToAccio(payload, "custom-model");
  assert.equal(frame.content.parts[0].text, "Hello");
  assert.equal(frame.usageMetadata.totalTokenCount, 3);
});

test("preserves object-valued tool arguments from SSE providers", () => {
  const body = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_skill","function":{"name":"skill","arguments":{"action":"read","skill_id":"1688-sourcing"}}}]},"finish_reason":"tool_calls"}]}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const frame = openAIToAccio(parseProviderBody(body, "text/event-stream"), "custom-model");
  assert.deepEqual(JSON.parse(frame.content.parts[0].functionCall.argsJson), {
    action: "read",
    skill_id: "1688-sourcing",
  });
});

test("merges streamed tool argument fragments", () => {
  const body = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"skill","arguments":"{\\"action\\":\\"read\\","}}]},"finish_reason":null}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"skill_id\\":\\"pdf\\"}"}}]},"finish_reason":"tool_calls"}]}',
    "data: [DONE]",
  ].join("\n");
  const frame = openAIToAccio(parseProviderBody(body, "text/event-stream"), "custom-model");
  assert.deepEqual(JSON.parse(frame.content.parts[0].functionCall.argsJson), { action: "read", skill_id: "pdf" });
});

test("normalizes Responses API function calls", () => {
  const frame = openAIToAccio({
    model: "custom-model",
    output: [{
      type: "function_call",
      call_id: "call_response",
      name: "skill",
      arguments: "{\"action\":\"list\",\"plugin_id\":\"canva\"}",
    }],
  }, "custom-model");
  assert.deepEqual(frame.content.parts[0].functionCall, {
    id: "call_response",
    name: "skill",
    argsJson: "{\"action\":\"list\",\"plugin_id\":\"canva\"}",
  });
});

test("builds a focused retry for missing required tool arguments", () => {
  const request = accioToOpenAI({
    contents: [{ role: "user", parts: [{ text: "Use the pdf skill" }] }],
    tools: [{
      name: "skill",
      parametersJson: JSON.stringify({
        type: "object",
        properties: {
          action: { type: "string" },
          skill_id: { type: "string" },
        },
        required: ["action"],
      }),
    }, {
      name: "other",
      parametersJson: "{\"type\":\"object\",\"properties\":{}}",
    }],
  }, "custom-model");
  const frame = openAIToAccio({
    choices: [{
      message: {
        tool_calls: [{ id: "call_bad", function: { name: "skill", arguments: "{}" } }],
      },
      finish_reason: "tool_calls",
    }],
  }, "custom-model");

  const invalid = findInvalidToolCalls(frame, request.tools);
  assert.deepEqual(invalid, [{ id: "call_bad", name: "skill", missing: ["action"] }]);
  const retry = buildToolRepairRequest(request, invalid[0]);
  assert.equal(retry.tools.length, 1);
  assert.equal(retry.tools[0].function.name, "skill");
  assert.deepEqual(retry.tool_choice, { type: "function", function: { name: "skill" } });
  assert.match(retry.messages.at(-1).content, /action/);
});

test("preserves tool call ids across assistant and tool-result turns", () => {
  const request = accioToOpenAI({
    contents: [{
      role: "model",
      parts: [{
        functionCall: {
          id: "call_roundtrip",
          name: "skill",
          args: { action: "read", skill_id: "pdf" },
        },
      }],
    }, {
      role: "user",
      parts: [{
        functionResponse: {
          id: "call_roundtrip",
          name: "skill",
          response: { content: "loaded" },
        },
      }],
    }],
  }, "custom-model");
  assert.equal(request.messages[0].tool_calls[0].id, "call_roundtrip");
  assert.equal(request.messages[1].tool_call_id, "call_roundtrip");
});

test("normalizes flat Accio tool messages into OpenAI schema", () => {
  const request = accioToOpenAI({
    contents: [{
      role: "assistant",
      content: "Reading the skill file.",
      toolCalls: [{
        id: "call_read",
        name: "read",
        arguments: {
          file_path: "SKILL.md",
          limit: 2000,
        },
      }],
    }, {
      role: "tool",
      name: "read",
      toolCallId: "call_read",
      content: "00001| ---\n00002| name: skill",
    }],
  }, "custom-model");

  assert.equal(request.messages[0].role, "assistant");
  assert.equal(request.messages[0].tool_calls[0].id, "call_read");
  assert.equal(request.messages[0].tool_calls[0].function.name, "read");
  assert.deepEqual(JSON.parse(request.messages[0].tool_calls[0].function.arguments), {
    file_path: "SKILL.md",
    limit: 2000,
  });
  assert.equal(request.messages[1].role, "tool");
  assert.equal(request.messages[1].tool_call_id, "call_read");
  assert.match(request.messages[1].content, /tool: read/);
  assert.match(request.messages[1].content, /tool_call_id: call_read/);
  assert.match(request.messages[1].content, /content_chars: 29/);
  assert.match(request.messages[1].content, /status: non_empty/);
  assert.match(request.messages[1].content, /00001\| ---\n00002\| name: skill/);
  assert.equal(Object.hasOwn(request.messages[1], "toolCallId"), false);
});

test("preserves camelCase ids from proto-shaped tool turns", () => {
  const request = accioToOpenAI({
    contents: [{
      role: "model",
      parts: [{
        functionCall: {
          toolCallId: "call_camel",
          name: "read",
          argsJson: "{\"file_path\":\"SKILL.md\"}",
        },
      }],
    }, {
      role: "user",
      parts: [{
        functionResponse: {
          toolCallId: "call_camel",
          name: "read",
          response: "loaded",
        },
      }],
    }],
  }, "custom-model");

  assert.equal(request.messages[0].tool_calls[0].id, "call_camel");
  assert.equal(request.messages[1].tool_call_id, "call_camel");
  assert.match(request.messages[1].content, /tool: read/);
  assert.match(request.messages[1].content, /status: non_empty/);
  assert.match(request.messages[1].content, /loaded/);
});

test("preserves raw text carried in proto responseJson tool results", () => {
  const rawSkillText = `00001| ---\n${"skill body\n".repeat(2400)}00002| done`;
  const request = accioToOpenAI({
    contents: [{
      role: "user",
      parts: [{
        functionResponse: {
          id: "call_read",
          name: "read",
          responseJson: rawSkillText,
        },
      }],
    }],
  }, "custom-model");

  assert.equal(request.messages[0].role, "tool");
  assert.equal(request.messages[0].tool_call_id, "call_read");
  assert.match(request.messages[0].content, /tool: read/);
  assert.match(request.messages[0].content, new RegExp(`content_chars: ${rawSkillText.length}`));
  assert.match(request.messages[0].content, /00001\| ---/);
  assert.match(request.messages[0].content, /00002\| done$/);
  assert.doesNotMatch(request.messages[0].content, /\{\}$/);
});

test("does not treat flat user message ids as tool result ids", () => {
  const request = accioToOpenAI({
    contents: [{
      role: "user",
      id: "msg_1",
      content: "hello",
    }],
  }, "custom-model");

  assert.deepEqual(request.messages[0], { role: "user", content: "hello" });
});

test("compacts large tool results while preserving both ends", () => {
  const value = `BEGIN-${"x".repeat(50000)}-END`;
  const compacted = compactToolContent(value, 1000);
  assert.equal(compacted.length, 1000);
  assert.match(compacted, /^BEGIN-/);
  assert.match(compacted, /-END$/);
  assert.match(compacted, /Accio Switch compacted/);
});

test("adds a generic header to tool results", () => {
  const content = toolResultContent({
    name: "read",
    toolCallId: "call_header",
    value: "loaded",
    maxChars: 1000,
  });
  assert.match(content, /^\[Accio Switch tool result\]/);
  assert.match(content, /tool: read/);
  assert.match(content, /tool_call_id: call_header/);
  assert.match(content, /content_chars: 6/);
  assert.match(content, /status: non_empty/);
  assert.match(content, /loaded$/);
});

test("compacts large Accio function responses before sending upstream", () => {
  const request = accioToOpenAI({
    contents: [{
      role: "user",
      parts: [{
        functionResponse: {
          id: "call_large",
          name: "bash",
          response: { result: "x".repeat(100000) },
        },
      }],
    }],
  }, "custom-model");
  assert.equal(request.messages[0].role, "tool");
  assert.ok(request.messages[0].content.length <= 32 * 1024);
  assert.match(request.messages[0].content, /Accio Switch compacted/);
});

test("can further compact tool results for oversized upstream requests", () => {
  const request = accioToOpenAI({
    contents: [{
      role: "user",
      parts: [{
        functionResponse: {
          id: "call_large",
          name: "bash",
          response: { result: "x".repeat(100000) },
        },
      }],
    }],
  }, "custom-model", { maxToolContentChars: 12 * 1024 });
  assert.equal(request.messages[0].role, "tool");
  assert.ok(request.messages[0].content.length <= 12 * 1024);
  assert.match(request.messages[0].content, /Accio Switch compacted/);
});

test("compacts oversized plain text messages", () => {
  const request = accioToOpenAI({
    contents: [{ role: "user", parts: [{ text: `BEGIN-${"x".repeat(50000)}-END` }] }],
  }, "custom-model", { maxTextContentChars: 4000 });
  assert.equal(request.messages[0].role, "user");
  assert.ok(request.messages[0].content.length <= 4000);
  assert.match(request.messages[0].content, /^BEGIN-/);
  assert.match(request.messages[0].content, /-END$/);
  assert.match(request.messages[0].content, /Accio Switch compacted/);
});

test("can cap max output tokens for compact retries", () => {
  const request = accioToOpenAI({
    contents: [{ role: "user", parts: [{ text: "Summarize this" }] }],
    generationConfig: { maxOutputTokens: 16000 },
  }, "custom-model", { maxOutputTokens: 2048 });
  assert.equal(request.max_tokens, 2048);
});

test("compacts long tool descriptions and schema comments", () => {
  const longDescription = `BEGIN-${"x".repeat(5000)}-END`;
  const request = accioToOpenAI({
    contents: [{ role: "user", parts: [{ text: "Use the tool" }] }],
    tools: [{
      name: "large_tool",
      description: longDescription,
      parameters: {
        type: "object",
        description: longDescription,
        properties: {
          query: { type: "string", description: longDescription },
        },
      },
    }],
  }, "custom-model");
  const tool = request.tools[0].function;
  assert.ok(tool.description.length <= 1200);
  assert.match(tool.description, /^BEGIN-/);
  assert.match(tool.description, /-END$/);
  assert.ok(tool.parameters.description.length <= 500);
  assert.ok(tool.parameters.properties.query.description.length <= 500);
});

test("can aggressively compact tool descriptions and schema comments", () => {
  const longDescription = `BEGIN-${"x".repeat(5000)}-END`;
  const request = accioToOpenAI({
    contents: [{ role: "user", parts: [{ text: "Use the tool" }] }],
    tools: [{
      name: "large_tool",
      description: longDescription,
      parameters: {
        type: "object",
        description: longDescription,
        properties: {
          query: { type: "string", description: longDescription },
        },
      },
    }],
  }, "custom-model", {
    maxToolDescriptionChars: 240,
    maxSchemaDescriptionChars: 120,
  });
  const tool = request.tools[0].function;
  assert.ok(tool.description.length <= 240);
  assert.ok(tool.parameters.description.length <= 120);
  assert.ok(tool.parameters.properties.query.description.length <= 120);
});

test("preserves Accio orchestration tools without business-specific routing", () => {
  const request = accioToOpenAI({
    systemInstruction: "Use the available tools when needed.",
    contents: [{
      role: "user",
      parts: [{
        text: "Please use the seller assistant skill or subtask if that is what Accio provided.",
      }],
    }],
    tools: [
      { name: "bash", parametersJson: "{\"type\":\"object\",\"properties\":{}}" },
      { name: "get_time", parametersJson: "{\"type\":\"object\",\"properties\":{}}" },
      { name: "sessions_spawn", parametersJson: "{\"type\":\"object\",\"properties\":{}}" },
      { name: "mcp_call", parametersJson: "{\"type\":\"object\",\"properties\":{}}" },
      { name: "skill", parametersJson: "{\"type\":\"object\",\"properties\":{}}" },
    ],
  }, "custom-model");
  assert.deepEqual(request.tools.map((tool) => tool.function.name).sort(), [
    "bash",
    "get_time",
    "mcp_call",
    "sessions_spawn",
    "skill",
  ]);
  assert.equal(request.messages[0].content, "Use the available tools when needed.");
});

test("detects direct image-output generation requests", () => {
  assert.equal(isImageOutputRequest({
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: { aspectRatio: "4:5" },
    },
  }), true);
  assert.equal(isImageOutputRequest({
    generationConfig: { responseModalities: ["TEXT"] },
  }), false);
});

test("detects proto-serialized image generation config", () => {
  assert.equal(isImageOutputRequest({
    properties: {
      generationConfig: JSON.stringify({
        responseModalities: ["TEXT", "IMAGE"],
        imageConfig: { aspectRatio: "1:1", imageSize: "2K" },
      }),
    },
  }), true);
});

test("extracts image prompt, references, ratio, and size", () => {
  const result = extractImageRequest({
    contents: [{
      role: "user",
      parts: [
        { text: "Edit this poster" },
        { inlineData: { mimeType: "image/png", data: "YWJj" } },
      ],
    }],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: { aspectRatio: "4:5", imageSize: "2K" },
    },
  });
  assert.equal(result.prompt, "Edit this poster");
  assert.equal(result.images.length, 1);
  assert.equal(result.aspectRatio, "4:5");
  assert.equal(result.imageSize, "2K");
  assert.equal(imageSizeForOpenAI("4:5"), "1024x1536");
});

test("creates an Accio inline image response frame", () => {
  const frame = imageFrame({
    data: "YWJj",
    mimeType: "image/png",
    text: "Created",
    model: "image-model",
  });
  assert.equal(frame.content.parts[0].text, "Created");
  assert.deepEqual(frame.content.parts[1].inlineData, {
    mimeType: "image/png",
    data: "YWJj",
  });
  assert.equal(frame.customMetadata.model_name, "image-model");
});

test("preserves image content in streamed chat responses", () => {
  const body = [
    'data: {"choices":[{"delta":{"content":[{"type":"image_url","image_url":{"url":"data:image/png;base64,YWJj"}}]},"finish_reason":"stop"}]}',
    "data: [DONE]",
  ].join("\n");
  const payload = parseProviderBody(body, "text/event-stream");
  assert.equal(
    payload.choices[0].message.content[0].image_url.url,
    "data:image/png;base64,YWJj",
  );
});

test("preserves final image payload in streamed Images API responses", () => {
  const body = [
    'data: {"progress":50}',
    'data: {"data":[{"b64_json":"YWJj"}]}',
    "data: [DONE]",
  ].join("\n");
  const payload = parseProviderBody(body, "text/event-stream");
  assert.equal(payload.data[0].b64_json, "YWJj");
});
