"use strict";

importScripts("url.js", "bookmarks.js", "dav.js");

var MENU_SAVE = "davflare-save-page";
var MENU_MODE = "davflare-toggle-mode";

var MESSAGES = {
  en: {
    appTitle: "Davflare",
    errTitle: "Davflare — action failed",
    saveOk: "Bookmark saved to your library.",
    saveExists: "This page is already in your library.",
    skipPage: "Only http(s) pages can be saved.",
    modeTitle: "Default home view switched",
    modeDrive: "The home page will open your drive.",
    modeBookmarks: "The home page will open your bookmark library.",
  },
  zh: {
    appTitle: "Davflare",
    errTitle: "Davflare — 操作失败",
    saveOk: "已收藏到书签库。",
    saveExists: "该页面已在书签库中。",
    skipPage: "只能收藏 http(s) 页面。",
    modeTitle: "主页默认视图已切换",
    modeDrive: "插件主页将打开网盘。",
    modeBookmarks: "插件主页将打开书签库。",
  },
};

var ERROR_COPY = {
  disabled: { en: "WebDAV is disabled on this instance.", zh: "该实例已关闭 WebDAV。" },
  notConfigured: {
    en: "The server has no WebDAV credentials configured.",
    zh: "服务端未配置 WebDAV 凭据。",
  },
  unauthorized: {
    en: "Wrong WebDAV username or password. Check the settings view in the library page.",
    zh: "WebDAV 用户名或密码错误，请在书签库的设置里检查。",
  },
  network: { en: "Cannot reach the instance.", zh: "无法连接实例。" },
  conflict: {
    en: "The library changed elsewhere. Please retry.",
    zh: "书签库已在别处更新，请重试。",
  },
};

function pickLang() {
  return (navigator.language || "en").toLowerCase().indexOf("zh") === 0 ? "zh" : "en";
}

function t() {
  return MESSAGES[pickLang()];
}

function errorText(kind) {
  var known = ERROR_COPY[kind];
  return known ? known[pickLang()] : "HTTP " + kind;
}

function flashBadge(text) {
  chrome.action.setBadgeText({ text: text });
  setTimeout(function () {
    chrome.action.setBadgeText({ text: "" });
  }, 2500);
}

function notify(title, message) {
  try {
    chrome.notifications.create(
      {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: title,
        message: message,
      },
      function () {
        void chrome.runtime.lastError;
      }
    );
  } catch (err) {
    /* notifications are best-effort feedback */
  }
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

async function toggleDefaultMode() {
  var stored = await chrome.storage.sync.get(["toolbarMode"]);
  var next = mergeSettings(stored).toolbarMode === "bookmarks" ? "drive" : "bookmarks";
  await chrome.storage.sync.set({ toolbarMode: next });
  var copy = t();
  notify(copy.modeTitle, next === "bookmarks" ? copy.modeBookmarks : copy.modeDrive);
}

async function savePage(tab) {
  var copy = t();
  var url = (tab && tab.url) || "";
  var title = (tab && tab.title) || "";
  if (!Bookmarks.isWebUrl(url)) {
    flashBadge("!");
    notify(copy.errTitle, copy.skipPage);
    return;
  }
  var client = DavflareDav.createDavClient(await loadConfig());
  var res = await client.getBookmarks();
  if (!res.ok) {
    flashBadge("!");
    notify(copy.errTitle, errorText(res.kind));
    return;
  }

  var model = Bookmarks.parseHtml(res.html || "");
  if (res.jsonText) {
    var parsed = Bookmarks.modelFromJson(res.jsonText);
    if (parsed.ok) model = Bookmarks.adoptRichFields(model, parsed.model);
  }
  var add = Bookmarks.addBookmark(model, { title: title, url: url, added: Date.now() });
  if (!add.added) {
    flashBadge("✓");
    notify(copy.appTitle, copy.saveExists);
    return;
  }

  var put = await client.putBookmarks({
    html: Bookmarks.serializeHtml(add.model),
    json: Bookmarks.modelToJsonText(add.model),
    etag: res.etag,
  });
  if (!put.ok) {
    flashBadge("!");
    notify(copy.errTitle, errorText(put.kind));
    return;
  }
  flashBadge("✓");
  notify(copy.appTitle, copy.saveOk);
}

// 工具栏左键点击由 popup.html（收藏弹窗）接管；右键菜单保留一键收藏与主页默认视图切换。

/**
 * #62 P1: the configurable shortcut triggers the same quick-save as the
 * toolbar popup. openPopup() shows that exact dialog; when it is
 * unavailable (older Chrome) or rejects, fall back to the silent
 * context-menu save path.
 */
async function quickSaveCurrentPage() {
  if (typeof chrome.action.openPopup === "function") {
    try {
      await chrome.action.openPopup();
      return;
    } catch (err) {
      /* fall through to the silent save */
    }
  }
  var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs && tabs[0]) await savePage(tabs[0]);
}

chrome.commands.onCommand.addListener(function (command) {
  if (command === "save-current-page") quickSaveCurrentPage();
});

/* ---------- omnibox (#62 P1): "df <query>" searches the cached library ---------- */

var OMNI_LIMIT = 6;
var CACHE_KEY = "bookmarksCache";

function xmlEscape(text) {
  return String(text == null ? "" : text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function cachedBookmarksModel() {
  var stored = await chrome.storage.local.get([CACHE_KEY]);
  var cache = stored && stored[CACHE_KEY];
  return cache && cache.model ? cache.model : { bookmarks: [] };
}

function omniDescription(item) {
  var parts = [xmlEscape(item.title || item.url)];
  if (item.tags && item.tags.length) {
    parts.push("<dim>" + xmlEscape(item.tags.join(", ")) + "</dim>");
  }
  parts.push("<url>" + xmlEscape(item.url) + "</url>");
  return parts.join(" ");
}

chrome.omnibox.onInputStarted.addListener(function () {
  chrome.omnibox.setDefaultSuggestion({
    description:
      pickLang() === "zh" ? "搜索 Davflare 书签…" : "Search Davflare bookmarks…",
  });
});

chrome.omnibox.onInputChanged.addListener(async function (text, suggest) {
  var model = await cachedBookmarksModel();
  var matches = Bookmarks.searchBookmarks(model, text, OMNI_LIMIT);
  if (!matches.length) return;
  var suggestions = [];
  for (var i = 0; i < matches.length; i++) {
    suggestions.push({
      content: matches[i].url,
      description: omniDescription(matches[i]),
    });
  }
  // 第一条作为默认建议（回车直达），其余进下拉列表。
  chrome.omnibox.setDefaultSuggestion({ description: suggestions[0].description });
  suggest(suggestions.slice(1));
});

chrome.omnibox.onInputEntered.addListener(async function (text, disposition) {
  var target = "";
  if (Bookmarks.isWebUrl(text)) {
    // 用户选中了某条建议：content 即书签 URL。
    target = text;
  } else {
    var model = await cachedBookmarksModel();
    var matches = Bookmarks.searchBookmarks(model, text, 1);
    if (matches.length) target = matches[0].url;
  }
  var open = function (url) {
    if (disposition === "newForegroundTab") chrome.tabs.create({ url: url, active: true });
    else if (disposition === "newBackgroundTab")
      chrome.tabs.create({ url: url, active: false });
    else chrome.tabs.update({ url: url });
  };
  if (target) {
    open(target);
    return;
  }
  // 没有命中：退回书签库页面继续找。
  var libraryUrl = chrome.runtime.getURL("bookmarks.html");
  if (disposition === "newForegroundTab" || disposition === "newBackgroundTab") {
    chrome.tabs.create({ url: libraryUrl, active: disposition === "newForegroundTab" });
  } else {
    chrome.tabs.update({ url: libraryUrl });
  }
});

chrome.contextMenus.onClicked.addListener(function (info, tab) {
  if (info.menuItemId === MENU_MODE) {
    toggleDefaultMode();
    return;
  }
  if (info.menuItemId === MENU_SAVE) {
    savePage(tab);
  }
});

chrome.runtime.onInstalled.addListener(function () {
  var zh = pickLang() === "zh";
  chrome.contextMenus.create(
    {
      id: MENU_SAVE,
      title: zh ? "收藏此页到 Davflare" : "Save page to Davflare",
      contexts: ["page"],
    },
    function () {
      void chrome.runtime.lastError;
    }
  );
  chrome.contextMenus.create(
    {
      id: MENU_MODE,
      title: zh ? "切换插件主页默认视图" : "Switch default home view",
      contexts: ["action"],
    },
    function () {
      void chrome.runtime.lastError;
    }
  );
});
