"use strict";

// 4B2 本地管理页面：同源 fetch，CSRF 只保存在本模块变量，不写任何本地存储。
// 所有动态文本用 textContent 渲染；不自动重发写请求，失败需使用者明确重新开始。

const MAX_AUDIO_BYTES = 50 * 1024 * 1024;
const CSRF_HEADER = "x-memo-tts-csrf";
const BASE64_CHUNK = 0x8000;

let csrfToken = null;
let busy = false;

const elements = {};

function byId(id) {
  return document.getElementById(id);
}

function setStatus(kind, text) {
  const node = elements.status;
  node.textContent = text;
  node.dataset.kind = kind;
}

// 无 spread 的分块 base64：避免把巨型数组展开成参数导致调用栈溢出。
function encodeBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK) {
    const chunk = bytes.subarray(offset, offset + BASE64_CHUNK);
    binary += String.fromCharCode.apply(null, chunk);
  }
  return window.btoa(binary);
}

async function api(path, options = {}) {
  const method = options.method || "GET";
  const init = {
    method,
    credentials: "same-origin",
    headers: {},
  };
  if (options.body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }
  if (method !== "GET") {
    // 浏览器自动带同源 Origin；这里只补 CSRF 头，令牌不进 URL。
    init.headers[CSRF_HEADER] = csrfToken || "";
  }
  const response = await fetch(path, init);
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok || (payload && payload.ok === false)) {
    const error = new Error(payload && payload.message ? payload.message : `请求失败（HTTP ${response.status}）`);
    error.stage = payload || null;
    throw error;
  }
  return payload;
}

function describeStage(stage) {
  if (!stage) {
    return "";
  }
  const parts = [];
  if (stage.registrationState) {
    parts.push(`注册阶段：${stage.registrationState}`);
  }
  if (stage.commitState) {
    parts.push(`目录提交：${stage.commitState}`);
  }
  if (stage.commitState === "committed" || stage.registrationState === "registered") {
    parts.push("已在后台生效，请人工核对后再决定，不要直接重复提交。");
  } else if (stage.registrationState === "unknown") {
    parts.push("完成状态未知，程序不会自动重发，请人工核对后再决定。");
  }
  return parts.join("；");
}

function setBusy(next) {
  busy = next;
  const controls = [elements.prepareSubmit, elements.importSubmit];
  for (const control of controls) {
    if (control) {
      control.disabled = next;
    }
  }
}

function persistenceLabel(value) {
  if (value === "temporary") {
    return "临时";
  }
  if (value === "saved") {
    return "已保存";
  }
  if (value === "external") {
    return "外部导入";
  }
  return String(value || "未知");
}

function bindingLabel(status) {
  if (status === "ready") {
    return "可用";
  }
  if (status === "invalid") {
    return "已停用";
  }
  return "未验证";
}

function renderEndpoints(state) {
  const select = elements.endpointSelect;
  select.textContent = "";
  const endpoints = state.endpoints || [];
  if (endpoints.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "没有已登记端点，请先在资料目录中配置";
    select.appendChild(option);
    select.disabled = true;
    elements.endpointSummary.textContent = "未登记端点：请在 catalog.json 中明确配置后再使用本工具。";
    return;
  }
  select.disabled = false;
  for (const endpoint of endpoints) {
    const option = document.createElement("option");
    option.value = String(endpoint.id);
    option.textContent = `${endpoint.id}（${endpoint.backendId}，目录声明 ${endpoint.readiness}）`;
    select.appendChild(option);
  }
  elements.endpointSummary.textContent = `已登记 ${endpoints.length} 个端点；目录声明就绪不等于已在线的真实试音。`;
}

function renderVoices(state) {
  const list = elements.voicesList;
  list.textContent = "";
  const profiles = state.profiles || [];
  const bindings = state.bindings || [];
  if (profiles.length === 0) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "当前资料目录还没有音色。";
    list.appendChild(empty);
    return;
  }

  for (const profile of profiles) {
    const card = document.createElement("article");
    card.className = "voice-card";

    const title = document.createElement("h4");
    title.textContent = String(profile.label || profile.id);
    card.appendChild(title);

    const meta = document.createElement("p");
    meta.className = "voice-meta";
    meta.textContent = `资料 ID：${profile.id}`;
    const tag = document.createElement("span");
    tag.className = `tag tag-${profile.persistence}`;
    tag.textContent = persistenceLabel(profile.persistence);
    card.appendChild(meta);
    card.appendChild(tag);

    for (const binding of bindings.filter((entry) => entry.profileId === profile.id)) {
      const row = document.createElement("p");
      row.className = "voice-binding";
      row.textContent = `${binding.backendId} · 端点 ${binding.endpointId} · ${bindingLabel(binding.status)}（revision ${binding.revision}）`;
      card.appendChild(row);
    }

    if (profile.persistence === "temporary") {
      const actions = document.createElement("div");
      actions.className = "voice-actions";
      const save = document.createElement("button");
      save.type = "button";
      save.textContent = "保存临时";
      save.addEventListener("click", () => runLifecycle("save", profile.id, save));
      const end = document.createElement("button");
      end.type = "button";
      end.className = "secondary";
      end.textContent = "结束临时";
      end.addEventListener("click", () => runLifecycle("end", profile.id, end));
      actions.appendChild(save);
      actions.appendChild(end);
      card.appendChild(actions);
      const note = document.createElement("p");
      note.className = "hint";
      note.textContent = "结束临时只做可恢复停用：保留录音与资料，但不会自动修改历史脚本或缓存。";
      card.appendChild(note);
    } else if (profile.persistence === "saved") {
      const note = document.createElement("p");
      note.className = "hint";
      note.textContent = "已保存音色不提供结束临时操作。";
      card.appendChild(note);
    } else {
      const note = document.createElement("p");
      note.className = "hint";
      note.textContent = "外部导入音色只读，不提供保存或停用操作。";
      card.appendChild(note);
    }

    list.appendChild(card);
  }
}

async function refreshState() {
  const state = await api("/api/state");
  renderEndpoints(state);
  renderVoices(state);
}

async function readAudioFile(file) {
  if (!file) {
    throw new Error("请先选择参考录音文件。");
  }
  if (file.size > MAX_AUDIO_BYTES) {
    throw new Error("参考录音超过 50MiB 上限，请换更短的文件。");
  }
  if (file.size === 0) {
    throw new Error("参考录音为空。");
  }
  const buffer = await file.arrayBuffer();
  return encodeBase64(new Uint8Array(buffer));
}

async function runLifecycle(action, profileId, button) {
  if (busy) {
    return;
  }
  setBusy(true);
  button.disabled = true;
  setStatus("pending", "正在提交，请勿重复点击。");
  try {
    await api(`/api/${action}`, { method: "POST", body: { profileId } });
    setStatus("ok", action === "save" ? "已保存为持久音色。" : "已结束临时使用，绑定标记为停用。");
    await refreshState();
  } catch (error) {
    setStatus("error", `${error.message}${error.stage ? `（${describeStage(error.stage)}）` : ""}`);
  } finally {
    setBusy(false);
  }
}

async function onSubmitPrepare(event) {
  event.preventDefault();
  if (busy) {
    return;
  }
  const file = byId("audio-file").files[0] || null;
  setBusy(true);
  setStatus("pending", "正在准备音色，请勿重复点击。");
  try {
    const audioBase64 = await readAudioFile(file);
    const body = {
      endpointId: byId("endpoint-select").value,
      label: byId("label-input").value,
      audioBase64,
      referenceText: byId("reference-text").value,
      language: byId("language-input").value,
      persistence: byId("persistence-select").value,
      authorizationConfirmed: byId("authorization-check").checked,
    };
    await api("/api/prepare", { method: "POST", body });
    setStatus("ok", "音色准备完成，已写入自有资料目录。");
    await refreshState();
  } catch (error) {
    setStatus("error", `${error.message}${error.stage ? `（${describeStage(error.stage)}）` : ""}`);
  } finally {
    setBusy(false);
  }
}

async function onSubmitImport(event) {
  event.preventDefault();
  if (busy) {
    return;
  }
  setBusy(true);
  setStatus("pending", "正在导入，请勿重复点击。");
  try {
    await api("/api/import", {
      method: "POST",
      body: {
        endpointId: byId("import-endpoint").value,
        nativeVoiceId: byId("import-native").value,
        label: byId("import-label").value,
      },
    });
    setStatus("ok", "导入完成。");
    await refreshState();
  } catch (error) {
    setStatus("error", `${error.message}${error.stage ? `（${describeStage(error.stage)}）` : ""}`);
  } finally {
    setBusy(false);
  }
}

async function start() {
  elements.status = byId("status-message");
  elements.prepareSubmit = byId("prepare-submit");
  elements.importSubmit = byId("import-submit");
  elements.voicesList = byId("voices-list");
  elements.endpointSelect = byId("endpoint-select");
  elements.endpointSummary = byId("endpoint-summary");

  byId("prepare-form").addEventListener("submit", onSubmitPrepare);
  byId("import-form").addEventListener("submit", onSubmitImport);

  try {
    const session = await api("/api/session");
    csrfToken = session.csrfToken;
    await refreshState();
    setStatus("ok", "已连接本机管理服务。");
  } catch (error) {
    setStatus("error", `无法连接本机管理服务：${error.message}`);
  }
}

window.addEventListener("DOMContentLoaded", start);
