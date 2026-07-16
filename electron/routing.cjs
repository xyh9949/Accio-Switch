function parseJsonBody(body) {
  try {
    return JSON.parse(Buffer.isBuffer(body) ? body.toString("utf8") : String(body || ""));
  } catch {
    return null;
  }
}

function isModelRoutingRequest(url, method, body) {
  if (method !== "POST" || String(url).split("?")[0] !== "/api/tool/rlab/call") return false;
  return parseJsonBody(body)?.function === "model_routing";
}

function forcedModelRoutingResponse(model) {
  return {
    success: true,
    data: {
      payload: {
        modelCode: model,
        shouldCompact: false,
        reason: "accio_switch_forced",
      },
    },
  };
}

function findGatewayStatus(logText, sinceMs, expectedGateway) {
  let latest = null;
  for (const line of String(logText || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (Number(entry.timestamp) < sinceMs) continue;
    const message = String(entry.message || "");
    if (!message.includes("[Gateway] Config: gatewayBaseUrl=")) continue;
    latest = {
      verified: message.includes(`gatewayBaseUrl=${expectedGateway}`),
      message,
      timestamp: Number(entry.timestamp),
    };
  }
  return latest;
}

function findAlibabaAuthorizationStatus(logText, sinceMs = 0) {
  let latest = null;
  for (const line of String(logText || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const timestamp = Number(entry.timestamp);
    if (timestamp < sinceMs) continue;
    const message = String(entry.message || "");
    if (message.includes("[preflight-connector] alibaba") && message.includes("unauthorized")) {
      latest = { connected: false, message, timestamp };
      continue;
    }
    if (
      (message.includes('"id":"alibaba","status":"authorized"')
        && message.includes('"connectedCount":1'))
      || /Synced remote authorization snapshot: alibaba \([1-9]\d* connected account\(s\)\)/.test(message)
      || /Restored from cache: alibaba \([1-9]\d* account\(s\)\)/.test(message)
    ) {
      latest = { connected: true, message, timestamp };
    }
  }
  return latest;
}

module.exports = {
  findAlibabaAuthorizationStatus,
  findGatewayStatus,
  forcedModelRoutingResponse,
  isModelRoutingRequest,
};
