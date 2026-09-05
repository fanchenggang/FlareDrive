"use strict";

/**
 * Toolbar action popup (HamHome-style save dialog): left-clicking the toolbar
 * icon opens this popup on the current tab — prefill title/folder/tags, save
 * to the instance's WebDAV library, and offer entries into the shell home
 * page (bookmarks.html) and its settings view. The right-click quick-save in
 * background.js keeps working for one-click saves without the dialog.
 */

var THEME_KEY = "davflare-theme";
var LAST_FOLDER_KEY = "popupLastFolder";

var COPY = {
  en: {
    titleLabel: "Title",
    folderLabel: "Folder",
    folderPlaceholder: "Root — pick or type a folder",
    tagsLabel: "Tags (comma separated)",
    save: "Save",
    saving: "Saving…",
    saved: "Saved to your library.",
    exists: "This page is already in your library.",
    skipPage: "Only http(s) pages can be saved.",
    needConfig: "Configure your instance URL and WebDAV credentials in settings first.",
    goSettings: "Open settings",
    loading: "Loading library…",
    retry: "Retry",
    errDisabled: "WebDAV is disabled on this instance.",
    errNotConfigured: "The server has no WebDAV credentials configured.",
    errUnauthorized: "Wrong WebDAV username or password. Check settings.",
    errNetwork: "Cannot reach the instance.",
    errConflict: "The library changed elsewhere — reloaded, please save again.",
    errOther: "The instance returned an unexpected response.",
    home: "Open Davflare",
    settings: "Settings",
  },
  zh: {
    titleLabel: "标题",
    folderLabel: "分类",
    folderPlaceholder: "留空为根目录，可输入或选择",
    tagsLabel: "标签（逗号分隔）",
    save: "收藏",
    saving: "收藏中…",
    saved: "已收藏到书签库。",
    exists: "该页面已在书签库中。",
    skipPage: "只能收藏 http(s) 页面。",
    needConfig: "请先在「设置」里配置实例地址与 WebDAV 凭据。",
    goSettings: "去设置",
    loading: "正在读取书签库…",
    retry: "重试",
    errDisabled: "该实例已关闭 WebDAV。",
    errNotConfigured: "服务端未配置 WebDAV 凭据。",
    errUnauthorized: "WebDAV 用户名或密码错误，请在设置里检查。",
    errNetwork: "无法连接实例。",
    errConflict: "书签库已在别处更新——已重新加载，请再点一次收藏。",
    errOther: "实例返回了未预期的响应。",
    home: "插件主页",
    settings: "设置",
  },
};

var ERROR_KEY = {
  disabled: "errDisabled",
  notConfigured: "errNotConfigured",
  unauthorized: "errUnauthorized",
  network: "errNetwork",
  conflict: "errConflict",
};

var state = {
  lang: "en",
  t: COPY.en,
  tab: null,
  url: "",
  model: null,
  etag: null,
  exists: false,
  ready: false,
};

function $(id) {
  return document.getElementById(id);
}

function pickLang() {
  return (navigator.language || "en").toLowerCase().indexOf("zh") === 0 ? "zh" : "en";
}

function errorText(kind) {
  var key = ERROR_KEY[kind];
  return key ? state.t[key] : state.t.errOther;
}

function applyTheme() {
  var saved = null;
  try {
    saved = localStorage.getItem(THEME_KEY);
  } catch (err) {
    saved = null;
  }
  var theme = saved === "light" || saved === "dark" ? saved : null;
  if (!theme) {
    theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  document.documentElement.dataset.theme = theme;
}

function setStatus(text, kind) {
  var el = $("saveStatus");
  el.textContent = text || "";
  el.className = "status" + (kind ? " " + kind : "");
}

/** Notice states replace the form: loading / restricted / unconfigured / error. */
function showNotice(text, buttonLabel, onButton) {
  $("saveForm").classList.add("hidden");
  var notice = $("bodyNotice");
  notice.textContent = text;
  notice.classList.remove("hidden");
  var btn = $("noticeBtn");
  if (buttonLabel && onButton) {
    btn.textContent = buttonLabel;
    btn.classList.remove("hidden");
    btn.onclick = onButton;
  } else {
    btn.classList.add("hidden");
    btn.onclick = null;
  }
}

function showForm() {
  $("bodyNotice").classList.add("hidden");
  $("noticeBtn").classList.add("hidden");
  $("saveForm").classList.remove("hidden");
}

async function loadConfig() {
  var sync = await chrome.storage.sync.get(["instanceUrl", "bookmarkPath"]);
  var local = await chrome.storage.local.get(["davUsername", "davPassword"]);
  var merged = mergeSettings(sync);
  return {
    instanceUrl: merged.instanceUrl,
    basePath: merged.bookmarkPath,
    username: typeof local.davUsername === "string" ? local.davUsername : "",
    password: typeof local.davPassword === "string" ? local.davPassword : "",
  };
}

async function openShell(view) {
  var base = chrome.runtime.getURL("bookmarks.html");
  var target = base + (view ? "?view=" + encodeURIComponent(view) : "");
  var tabs = await chrome.tabs.query({ url: base + "*" });
  if (tabs && tabs.length > 0) {
    var tab = tabs[0];
    var update = { active: true };
    // Reusing an open shell tab still must land on the requested view
    // (e.g. Settings from the popup), not just focus the existing page.
    if (view) update.url = target;
    await chrome.tabs.update(tab.id, update);
    if (typeof tab.windowId === "number") {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
  } else {
    await chrome.tabs.create({ url: target || base });
  }
  window.close();
}

function setSaveEnabled(enabled, label) {
  var btn = $("saveBtn");
  btn.disabled = !enabled;
  btn.textContent = label;
}

/**
 * GET + parse the remote library. Fills the folder datalist, re-checks
 * "already saved", and decides whether the save button is usable. User-typed
 * inputs (title/folder/tags) are left alone unless prefillTitle is set.
 */
async function loadModel(opts) {
  var options = opts || {};
  state.ready = false;
  setSaveEnabled(false, state.t.save);
  if (options.prefillTitle) setStatus(state.t.loading);
  var client = DavflareDav.createDavClient(options.cfg);
  var res = await client.getBookmarks();
  if (!res.ok) {
    showNotice(errorText(res.kind), state.t.retry, function () {
      init();
    });
    return;
  }
  var model = Bookmarks.parseHtml(res.html || "");
  if (res.jsonText) {
    var parsed = Bookmarks.modelFromJson(res.jsonText);
    if (parsed.ok) model = Bookmarks.adoptRichFields(model, parsed.model);
  }
  state.model = model;
  state.etag = res.etag;

  var folders = Bookmarks.folderPaths(model);
  var datalist = $("folderOptions");
  datalist.innerHTML = "";
  for (var i = 0; i < folders.length; i++) {
    var opt = document.createElement("option");
    opt.value = folders[i];
    datalist.appendChild(opt);
  }

  var key = Bookmarks.urlKey(state.url);
  state.exists = Boolean(
    key &&
      model.bookmarks.some(function (b) {
        return Bookmarks.urlKey(b.url) === key;
      })
  );

  if (options.prefillTitle && !$("saveTitle").value) {
    $("saveTitle").value = (state.tab && state.tab.title) || state.url;
  }
  if (options.prefillFolder && !$("saveFolder").value) {
    var stored = await chrome.storage.local.get([LAST_FOLDER_KEY]);
    var last = stored && typeof stored[LAST_FOLDER_KEY] === "string" ? stored[LAST_FOLDER_KEY] : "";
    if (Bookmarks.folderPaths(model).indexOf(last) !== -1) {
      $("saveFolder").value = last;
    }
  }

  showForm();
  if (state.exists) {
    setStatus(state.t.exists, "ok");
    setSaveEnabled(false, state.t.exists);
  } else {
    state.ready = true;
    setSaveEnabled(true, state.t.save);
  }
}

async function saveCurrent(event) {
  event.preventDefault();
  if (!state.ready) return;
  state.ready = false;
  setSaveEnabled(false, state.t.saving);
  setStatus("");

  var title = $("saveTitle").value.trim() || (state.tab && state.tab.title) || state.url;
  var folder = $("saveFolder").value.trim().replace(/^\/+|\/+$/g, "");
  var tags = $("saveTags")
    .value
    .split(",")
    .map(function (tag) {
      return tag.trim();
    })
    .filter(Boolean);

  var add = Bookmarks.addBookmark(state.model, {
    title: title,
    url: state.url,
    folder: folder,
    tags: tags,
    added: Date.now(),
  });
  if (!add.added) {
    state.exists = true;
    setStatus(state.t.exists, "ok");
    setSaveEnabled(false, state.t.exists);
    return;
  }

  var cfg = await loadConfig();
  var client = DavflareDav.createDavClient(cfg);
  var put = await client.putBookmarks({
    html: Bookmarks.serializeHtml(add.model),
    json: Bookmarks.modelToJsonText(add.model),
    etag: state.etag,
  });
  if (!put.ok) {
    if (put.kind === "conflict") {
      // Remote moved on: reload model + etag, keep what the user typed.
      // loadModel may flip to the "already saved" state if the URL landed remotely.
      await loadModel({ cfg: cfg });
      if (!state.exists) setStatus(state.t.errConflict, "err");
    } else {
      setStatus(errorText(put.kind), "err");
      state.ready = true;
      setSaveEnabled(true, state.t.save);
    }
    return;
  }
  state.model = add.model;
  state.exists = true;
  setStatus(state.t.saved, "ok");
  setSaveEnabled(false, state.t.saved);
  chrome.storage.local.set({ popupLastFolder: folder }, function () {
    void chrome.runtime.lastError;
  });
}

function renderHeader() {
  var icon = $("pageIcon");
  var fallback = $("brandIcon");
  if (Bookmarks.isWebUrl(state.url)) {
    icon.src =
      chrome.runtime.getURL("_favicon/?pageUrl=") + encodeURIComponent(state.url) + "&size=32";
    icon.hidden = false;
    fallback.hidden = true;
    icon.onerror = function () {
      icon.hidden = true;
      fallback.hidden = false;
    };
  } else {
    icon.hidden = true;
    fallback.hidden = false;
  }
  $("pageTitle").textContent = (state.tab && state.tab.title) || "Davflare";
  $("pageUrl").textContent = state.url;
}

async function init() {
  applyTheme();
  state.lang = pickLang();
  state.t = COPY[state.lang];
  var t = state.t;

  document.title = "Davflare";
  $("titleLabel").textContent = t.titleLabel;
  $("folderLabel").textContent = t.folderLabel;
  $("saveFolder").placeholder = t.folderPlaceholder;
  $("tagsLabel").textContent = t.tagsLabel;
  $("homeBtn").textContent = t.home;
  $("settingsBtn").textContent = t.settings;

  var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tab = tabs && tabs[0] ? tabs[0] : null;
  state.url = (state.tab && state.tab.url) || "";
  renderHeader();

  if (!Bookmarks.isWebUrl(state.url)) {
    showNotice(t.skipPage);
    return;
  }

  var cfg = await loadConfig();
  if (!cfg.instanceUrl) {
    showNotice(t.needConfig, t.goSettings, function () {
      openShell("settings");
    });
    return;
  }

  await loadModel({ cfg: cfg, prefillTitle: true, prefillFolder: true });
}

$("saveForm").addEventListener("submit", saveCurrent);
$("homeBtn").addEventListener("click", function () {
  openShell("");
});
$("settingsBtn").addEventListener("click", function () {
  openShell("settings");
});

init();
