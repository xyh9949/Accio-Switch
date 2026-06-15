import { useEffect, useMemo, useState } from "react";
import {
  ArrowSquareOut,
  CaretDown,
  CheckCircle,
  CircleNotch,
  CloudArrowUp,
  Eye,
  EyeSlash,
  GearSix,
  Info,
  Key,
  ListBullets,
  Play,
  PlugsConnected,
  Power,
  RadioButton,
  ShareNetwork,
  ShieldCheck,
  SlidersHorizontal,
  Warning,
  XCircle,
} from "@phosphor-icons/react";

const DEFAULT_CONFIG = {
  mode: "custom",
  provider: "OpenAI Compatible",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4.1-mini",
  apiKey: "",
  apiKeyConfigured: false,
  imageEnabled: false,
  imageProtocol: "chat-completions",
  imageBaseUrl: "",
  imageModel: "",
  imageApiKey: "",
  imageApiKeyConfigured: false,
  imageReuseChatKey: true,
  autoStartBridge: true,
  bridgePort: 8787,
  officialGateway: "https://phoenix-gw.alibaba.com",
  accioPath: "C:\\Users\\123\\AppData\\Local\\Programs\\Accio\\Accio.exe",
};

const DEMO_LOGS = [
  { time: "10:24:31", level: "INFO", message: "Bridge configuration loaded" },
  { time: "10:24:32", level: "INFO", message: "Waiting for endpoint test" },
];

const providers = [
  { id: "openai", label: "OpenAI Compatible", note: "Recommended", tone: "blue" },
  { id: "anthropic", label: "Anthropic Compatible", note: "Coming next", tone: "ink" },
  { id: "gemini", label: "Google Gemini", note: "Coming next", tone: "multi" },
  { id: "litellm", label: "LiteLLM / CC Switch", note: "OpenAI route", tone: "green" },
  { id: "other", label: "Other OpenAPI", note: "Custom endpoint", tone: "gray" },
];

function isTauri() {
  return Boolean(window.__TAURI_INTERNALS__);
}

async function invoke(command, args = {}) {
  if (window.accioSwitch) {
    return window.accioSwitch.invoke(command, args);
  }
  if (!isTauri()) {
    await new Promise((resolve) => setTimeout(resolve, 350));
    if (command === "get_snapshot") {
      return { config: DEFAULT_CONFIG, bridgeRunning: false, accioRunning: false, logs: DEMO_LOGS };
    }
    if (command === "test_endpoint") {
      return { ok: true, latencyMs: 312, modelFound: true, message: "Endpoint reachable" };
    }
    if (command === "start_bridge") return { running: true };
    if (command === "stop_bridge") return { running: false };
    if (command === "launch_accio") return { launched: true, message: "Accio Work launched" };
    return { ok: true };
  }
  const api = await import("@tauri-apps/api/core");
  return api.invoke(command, args);
}

function Toggle({ checked, onChange, label }) {
  return (
    <button type="button" className={`toggle ${checked ? "is-on" : ""}`} aria-pressed={checked} aria-label={label} onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}

function StatusDot({ status }) {
  return <span className={`status-dot status-${status}`} />;
}

function AppIcon({ type }) {
  if (type === "client") return <CloudArrowUp size={28} weight="duotone" />;
  if (type === "bridge") return <ShareNetwork size={28} weight="duotone" />;
  return <PlugsConnected size={28} weight="duotone" />;
}

export function App() {
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [bridgeRunning, setBridgeRunning] = useState(false);
  const [logs, setLogs] = useState(DEMO_LOGS);
  const [showKey, setShowKey] = useState(false);
  const [showImageKey, setShowImageKey] = useState(false);
  const [busy, setBusy] = useState("");
  const [testResult, setTestResult] = useState(null);
  const [imageTestResult, setImageTestResult] = useState(null);
  const [notice, setNotice] = useState("");
  const [activeNav, setActiveNav] = useState("route");

  useEffect(() => {
    invoke("get_snapshot")
      .then((snapshot) => {
        setConfig({ ...DEFAULT_CONFIG, ...snapshot.config, apiKey: "" });
        setBridgeRunning(snapshot.bridgeRunning);
        if (snapshot.logs?.length) setLogs(snapshot.logs.slice(-8));
      })
      .catch((error) => setNotice(String(error)));
  }, []);

  const update = (patch) => {
    setConfig((current) => ({ ...current, ...patch }));
    setTestResult(null);
  };

  const selectedProvider = useMemo(
    () => providers.find((item) => item.label === config.provider) || providers[0],
    [config.provider],
  );

  const addLog = (message, level = "INFO") => {
    const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
    setLogs((current) => [...current.slice(-6), { time, level, message }]);
  };

  const save = async () => {
    setBusy("save");
    setNotice("");
    try {
      await invoke("save_config", { config });
      addLog("Configuration saved");
      setNotice("Configuration saved");
      setConfig((current) => ({
        ...current,
        apiKey: "",
        imageApiKey: "",
        apiKeyConfigured: current.apiKeyConfigured || Boolean(current.apiKey),
        imageApiKeyConfigured: current.imageApiKeyConfigured || Boolean(current.imageApiKey),
      }));
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy("");
    }
  };

  const testImageEndpoint = async () => {
    setBusy("image-test");
    setNotice("");
    try {
      await invoke("save_config", { config });
      const result = await invoke("test_image_endpoint");
      setImageTestResult(result);
      addLog(result.ok ? `Image endpoint reachable in ${result.latencyMs} ms` : result.message, result.ok ? "INFO" : "ERROR");
    } catch (error) {
      const result = { ok: false, message: String(error), latencyMs: 0, modelFound: false };
      setImageTestResult(result);
      addLog(result.message, "ERROR");
    } finally {
      setBusy("");
    }
  };

  const testEndpoint = async () => {
    setBusy("test");
    setNotice("");
    try {
      await invoke("save_config", { config });
      const result = await invoke("test_endpoint");
      setTestResult(result);
      addLog(result.ok ? `Chat endpoint reachable in ${result.latencyMs} ms` : result.message, result.ok ? "INFO" : "ERROR");
    } catch (error) {
      const result = { ok: false, message: String(error), latencyMs: 0, modelFound: false };
      setTestResult(result);
      addLog(result.message, "ERROR");
    } finally {
      setBusy("");
    }
  };

  const toggleBridge = async () => {
    setBusy("bridge");
    setNotice("");
    try {
      await invoke("save_config", { config });
      const result = await invoke(bridgeRunning ? "stop_bridge" : "start_bridge");
      setBridgeRunning(result.running);
      addLog(result.running ? `Bridge listening on 127.0.0.1:${config.bridgePort}` : "Bridge stopped");
    } catch (error) {
      setNotice(String(error));
      addLog(String(error), "ERROR");
    } finally {
      setBusy("");
    }
  };

  const launchAccio = async () => {
    setBusy("launch");
    setNotice("");
    try {
      await invoke("save_config", { config });
      const result = await invoke("launch_accio");
      if (config.mode === "custom") setBridgeRunning(true);
      addLog(result.message || `Accio launched in ${config.mode} mode`);
      setNotice(result.message || "Accio Work launched");
    } catch (error) {
      setNotice(String(error));
      addLog(String(error), "ERROR");
    } finally {
      setBusy("");
    }
  };

  const readiness = [
    { label: "Bridge service", value: bridgeRunning ? `127.0.0.1:${config.bridgePort}` : "Stopped", ok: bridgeRunning },
    { label: "Custom endpoint", value: testResult?.ok ? `${testResult.latencyMs} ms` : "Not tested", ok: Boolean(testResult?.ok) },
    { label: "Authentication", value: config.apiKey || config.apiKeyConfigured ? "Key configured" : "Missing key", ok: Boolean(config.apiKey || config.apiKeyConfigured) },
    { label: "Chat model", value: config.model || "Not set", ok: Boolean(config.model) },
    {
      label: "Image route",
      value: config.imageEnabled ? (config.imageModel || config.model || "Not set") : "Disabled",
      ok: !config.imageEnabled || Boolean(config.imageModel || config.model),
    },
  ];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-mark"><ShareNetwork size={30} weight="duotone" /></div>
        <nav>
          {[
            ["route", ShareNetwork, "Route"],
            ["logs", ListBullets, "Logs"],
            ["settings", GearSix, "Settings"],
            ["about", Info, "About"],
          ].map(([id, Icon, label]) => (
            <button key={id} className={activeNav === id ? "active" : ""} onClick={() => setActiveNav(id)}>
              <Icon size={23} weight={activeNav === id ? "fill" : "regular"} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div><StatusDot status={bridgeRunning ? "good" : "idle"} />Bridge</div>
          <small>v0.2.8</small>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div className="title-lockup">
            <h1>ACCIO SWITCH</h1>
            <span className={`bridge-badge ${bridgeRunning ? "ready" : ""}`}>
              <StatusDot status={bridgeRunning ? "good" : "idle"} />
              {bridgeRunning ? "Bridge ready" : "Bridge stopped"}
            </span>
          </div>
          <div className="top-actions">
            <button className="secondary-button" onClick={save} disabled={busy}>
              {busy === "save" ? <CircleNotch className="spin" size={17} /> : <ShieldCheck size={17} />}
              Save
            </button>
            <button className="launch-button" onClick={launchAccio} disabled={busy}>
              {busy === "launch" ? <CircleNotch className="spin" size={18} /> : <Play size={18} weight="fill" />}
              Launch Accio
            </button>
          </div>
        </header>

        {activeNav === "route" && (
          <div className="route-layout">
            <section className="setup-pane">
              <div className="mode-switch" role="tablist" aria-label="Routing mode">
                <button className={config.mode === "official" ? "active" : ""} onClick={() => update({ mode: "official" })}>Official</button>
                <button className={config.mode === "custom" ? "active" : ""} onClick={() => update({ mode: "custom" })}>Custom</button>
              </div>

              <div className={`custom-config ${config.mode === "official" ? "is-muted" : ""}`}>
                <section className="step-section">
                  <div className="step-number">1</div>
                  <div className="step-body">
                    <h2>Choose provider</h2>
                    <div className="provider-list">
                      {providers.map((provider) => (
                        <button
                          type="button"
                          key={provider.id}
                          className={config.provider === provider.label ? "selected" : ""}
                          onClick={() => update({ provider: provider.label })}
                          disabled={config.mode === "official" || provider.id === "anthropic" || provider.id === "gemini"}
                        >
                          <RadioButton size={20} weight={config.provider === provider.label ? "fill" : "regular"} />
                          <span className={`provider-glyph tone-${provider.tone}`}>{provider.label.slice(0, 1)}</span>
                          <span className="provider-name">{provider.label}</span>
                          <small>{provider.note}</small>
                        </button>
                      ))}
                    </div>
                  </div>
                </section>

                <section className="step-section">
                  <div className="step-number">2</div>
                  <div className="step-body">
                    <h2>Configure endpoint</h2>
                    <div className="form-grid">
                      <label>
                        <span>Base URL</span>
                        <div className="input-wrap mono">
                          <input value={config.baseUrl} onChange={(event) => update({ baseUrl: event.target.value })} disabled={config.mode === "official"} />
                        </div>
                        <small>OpenAI-compatible root URL, including <code>/v1</code>.</small>
                      </label>
                      <label>
                        <span>API key</span>
                        <div className="input-wrap mono">
                          <Key size={17} />
                          <input
                            type={showKey ? "text" : "password"}
                            value={config.apiKey}
                            placeholder={config.apiKeyConfigured ? "Stored in Windows secure storage" : "sk-..."}
                            onChange={(event) => update({ apiKey: event.target.value })}
                            disabled={config.mode === "official"}
                          />
                          <button type="button" className="icon-button" onClick={() => setShowKey((value) => !value)}>
                            {showKey ? <EyeSlash size={18} /> : <Eye size={18} />}
                          </button>
                        </div>
                        <small>The key is encrypted with Windows secure storage, never written to the config file.</small>
                      </label>
                      <label>
                        <span>Model</span>
                        <div className="input-wrap mono">
                          <input value={config.model} onChange={(event) => update({ model: event.target.value })} disabled={config.mode === "official"} />
                          <CaretDown size={16} />
                        </div>
                      </label>
                    </div>
                    <div className="endpoint-actions">
                      <button className="outline-button" onClick={testEndpoint} disabled={busy || config.mode === "official"}>
                        {busy === "test" ? <CircleNotch className="spin" size={17} /> : <SlidersHorizontal size={17} />}
                        Test endpoint
                      </button>
                      {testResult && (
                        <span className={testResult.ok ? "test-success" : "test-error"}>
                          {testResult.ok ? <CheckCircle size={18} weight="fill" /> : <XCircle size={18} weight="fill" />}
                          {testResult.ok ? `Success (${testResult.latencyMs} ms)` : testResult.message}
                        </span>
                      )}
                    </div>
                  </div>
                </section>

                <section className="step-section">
                  <div className="step-number">3</div>
                  <div className="step-body">
                    <h2>Configure image generation</h2>
                    <div className="behavior-list image-enable-row">
                      <div>
                        <span><strong>Use a custom image model</strong><small>Image generation and editing never use Accio's official model service.</small></span>
                        <Toggle checked={config.imageEnabled} onChange={(value) => update({ imageEnabled: value })} label="Custom image model" />
                      </div>
                    </div>
                    <div className={`image-config-panel ${config.imageEnabled ? "" : "is-disabled"}`}>
                      <div className="form-grid">
                        <label>
                          <span>Image API protocol</span>
                          <div className="input-wrap mono">
                            <select value={config.imageProtocol} onChange={(event) => update({ imageProtocol: event.target.value })} disabled={!config.imageEnabled}>
                              <option value="chat-completions">Chat Completions multimodal</option>
                              <option value="openai-images">OpenAI Images API</option>
                            </select>
                          </div>
                          <small>Use Chat Completions when the model returns images directly; use Images API for <code>/images/generations</code> and <code>/images/edits</code>.</small>
                        </label>
                        <label>
                          <span>Image Base URL</span>
                          <div className="input-wrap mono">
                            <input
                              value={config.imageBaseUrl}
                              placeholder={config.baseUrl || "https://api.example.com/v1"}
                              onChange={(event) => update({ imageBaseUrl: event.target.value })}
                              disabled={!config.imageEnabled}
                            />
                          </div>
                          <small>Leave empty to reuse the chat Base URL.</small>
                        </label>
                        <label>
                          <span>Image model</span>
                          <div className="input-wrap mono">
                            <input
                              value={config.imageModel}
                              placeholder={config.model || "image-model"}
                              onChange={(event) => update({ imageModel: event.target.value })}
                              disabled={!config.imageEnabled}
                            />
                          </div>
                          <small>Leave empty to reuse the chat model.</small>
                        </label>
                      </div>
                      <div className="behavior-list compact-behavior">
                        <div>
                          <span><strong>Reuse chat API key</strong><small>Turn off to store a separate encrypted key for image requests.</small></span>
                          <Toggle checked={config.imageReuseChatKey} onChange={(value) => update({ imageReuseChatKey: value })} label="Reuse chat API key" />
                        </div>
                      </div>
                      {!config.imageReuseChatKey && (
                        <div className="form-grid">
                          <label>
                            <span>Image API key</span>
                            <div className="input-wrap mono">
                              <Key size={17} />
                              <input
                                type={showImageKey ? "text" : "password"}
                                value={config.imageApiKey}
                                placeholder={config.imageApiKeyConfigured ? "Stored in Windows secure storage" : "sk-..."}
                                onChange={(event) => update({ imageApiKey: event.target.value })}
                                disabled={!config.imageEnabled}
                              />
                              <button type="button" className="icon-button" onClick={() => setShowImageKey((value) => !value)}>
                                {showImageKey ? <EyeSlash size={18} /> : <Eye size={18} />}
                              </button>
                            </div>
                          </label>
                        </div>
                      )}
                      <div className="endpoint-actions">
                        <button className="outline-button" onClick={testImageEndpoint} disabled={busy || !config.imageEnabled}>
                          {busy === "image-test" ? <CircleNotch className="spin" size={17} /> : <SlidersHorizontal size={17} />}
                          Test image endpoint
                        </button>
                        {imageTestResult && (
                          <span className={imageTestResult.ok ? "test-success" : "test-error"}>
                            {imageTestResult.ok ? <CheckCircle size={18} weight="fill" /> : <XCircle size={18} weight="fill" />}
                            {imageTestResult.ok ? `Success (${imageTestResult.latencyMs} ms)` : imageTestResult.message}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </section>

                <section className="step-section">
                  <div className="step-number">4</div>
                  <div className="step-body">
                    <h2>Routing behavior</h2>
                    <div className="behavior-list">
                      <div>
                        <span><strong>Auto-start bridge with Accio</strong><small>Start the local relay before launching Accio Work.</small></span>
                        <Toggle checked={config.autoStartBridge} onChange={(value) => update({ autoStartBridge: value })} label="Auto-start bridge" />
                      </div>
                    </div>
                    <button className={`bridge-control ${bridgeRunning ? "stop" : ""}`} onClick={toggleBridge} disabled={busy || config.mode === "official"}>
                      {busy === "bridge" ? <CircleNotch className="spin" size={18} /> : <Power size={18} />}
                      {bridgeRunning ? "Stop local bridge" : "Start local bridge"}
                    </button>
                  </div>
                </section>
              </div>
            </section>

            <aside className="preview-pane">
              <section className="route-preview">
                <h2>Route Preview</h2>
                <div className="route-chain">
                  {[
                    ["client", "Accio Work", "Client"],
                    ["bridge", "Bridge", bridgeRunning ? "Active" : "Stopped"],
                    ["provider", selectedProvider.label, config.model],
                  ].map(([type, title, subtitle], index) => (
                    <div className="route-fragment" key={type}>
                      <div className={`route-node node-${type}`}>
                        <div className="node-icon"><AppIcon type={type} /></div>
                        <strong>{title}</strong>
                        <small>{subtitle}</small>
                      </div>
                      {index < 2 && <div className={`route-line ${bridgeRunning ? "active" : ""}`}><i /><i /><i /></div>}
                    </div>
                  ))}
                </div>
              </section>

              <section className={`readiness ${bridgeRunning && testResult?.ok ? "healthy" : ""}`}>
                <div className="readiness-head">
                  {bridgeRunning && testResult?.ok ? <CheckCircle size={34} weight="fill" /> : <Warning size={34} weight="fill" />}
                  <span>
                    <strong>{bridgeRunning && testResult?.ok ? "Ready to launch" : "Setup in progress"}</strong>
                    <small>{bridgeRunning && testResult?.ok ? "The custom route is active and healthy." : "Complete the checks below before launch."}</small>
                  </span>
                </div>
                <div className="check-list">
                  {readiness.map((item) => (
                    <div key={item.label} className={item.ok ? "is-ok" : ""}>
                      {item.ok ? <CheckCircle size={19} weight="fill" /> : <XCircle size={19} />}
                      <span>{item.label}</span>
                      <small>{item.value}</small>
                    </div>
                  ))}
                </div>
              </section>

              <section className="recent-events">
                <div className="section-title">
                  <h2>Recent events</h2>
                  <button onClick={() => setLogs([])}>Clear</button>
                </div>
                <div className="console">
                  {logs.length === 0 ? (
                    <div className="empty-log">No events yet.</div>
                  ) : logs.map((entry, index) => (
                    <div key={`${entry.time}-${index}`} className={entry.level === "ERROR" ? "error" : ""}>
                      <time>{entry.time}</time><b>[{entry.level}]</b><span>{entry.message}</span>
                    </div>
                  ))}
                </div>
                <button className="text-link" onClick={() => setActiveNav("logs")}>View full logs <ArrowSquareOut size={15} /></button>
              </section>
            </aside>
          </div>
        )}

        {activeNav === "logs" && (
          <div className="single-page">
            <div className="page-heading"><div><h2>Bridge logs</h2><p>Operational events are redacted before display.</p></div><button className="outline-button" onClick={() => setLogs([])}>Clear logs</button></div>
            <div className="full-console">{logs.map((entry, index) => <div key={index}><time>{entry.time}</time><b>[{entry.level}]</b><span>{entry.message}</span></div>)}</div>
          </div>
        )}

        {activeNav === "settings" && (
          <div className="single-page settings-page">
            <div className="page-heading"><div><h2>Settings</h2><p>Local service and Accio installation paths.</p></div></div>
            <label><span>Bridge port</span><input type="number" value={config.bridgePort} onChange={(event) => update({ bridgePort: Number(event.target.value) })} /></label>
            <label><span>Official gateway</span><input value={config.officialGateway} onChange={(event) => update({ officialGateway: event.target.value })} /></label>
            <label><span>Accio executable</span><input value={config.accioPath} onChange={(event) => update({ accioPath: event.target.value })} /></label>
            <button className="launch-button" onClick={save}>Save settings</button>
          </div>
        )}

        {activeNav === "about" && (
          <div className="single-page about-page">
            <ShareNetwork size={52} weight="duotone" />
            <h2>Accio Switch</h2>
            <p>A local routing companion for Accio Work. It keeps official services intact while redirecting supported LLM traffic through your chosen OpenAI-compatible endpoint.</p>
            <div className="notice-box"><Warning size={20} weight="fill" /><span>In Custom mode, chat and image-model requests never fall back to Accio's official model service. Non-model account and application APIs remain transparently proxied so Accio Work can operate.</span></div>
          </div>
        )}

        {notice && <div className="toast" onClick={() => setNotice("")}>{notice}</div>}
      </main>
    </div>
  );
}
