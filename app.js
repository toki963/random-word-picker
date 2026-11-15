// 데이터 형식을 바꿀 때는 이 버전과 가져오기 로직을 함께 확인합니다.
const APP_VERSION = 1;
const DB_NAME = "wordwell-library";
const DB_VERSION = 1;
const DB_STORE = "app-state";
const DB_KEY = "main";
const FALLBACK_KEY = "wordwell.library.v1";
const FALLBACK_ACTIVE_KEY = `${FALLBACK_KEY}.active`;

// 화면 제목은 경로 전환 시 공통 헤더에 표시합니다.
const titles = {
  dashboard: ["나만의 단어 보관함", "단어를 위한 나만의 공간."],
  words: ["내 단어 보관함", "모든 단어를 한곳에서."],
  unfiled: ["내 단어 보관함", "아직 폴더에 담기지 않은 단어."],
  folders: ["나의 모음", "아이디어마다 어울리는 자리를."],
  tags: ["나만의 분류", "태그로 단어를 탐색해 보세요."],
  picker: ["새로운 아이디어 찾기", "단어가 이끄는 대로 골라 보세요."],
  settings: ["나의 공간", "원하는 방식으로 설정하세요."],
};

// 앱 데이터는 단어와 폴더를 분리해 저장하고, 연결은 단어의 folderIds로 관리합니다.
let state = {
  version: APP_VERSION,
  words: [],
  folders: [],
  settings: { theme: "light" },
};
let currentView = "dashboard";
let storageMode = "IndexedDB";
let dbPromise;
let saveQueue = Promise.resolve();
// 결과는 단어의 복사본으로 보관해, 다시 뽑거나 지우기 전까지 그대로 보여줍니다.
let picker = {
  mode: "all",
  folderIds: [],
  folderLogic: "union",
  tagNames: [],
  tagLogic: "and",
  quantity: "1",
  allowDuplicates: false,
  results: null,
};
let browser = {
  search: "",
  folderId: "all",
  tagNames: [],
  tagLogic: "and",
  sort: "updated",
};
let tagSearch = "";
let tagFilterOpen = false;

// 작은 DOM 도우미를 사용해 화면 코드의 반복을 줄입니다.
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
// 사용자 입력을 HTML에 넣기 전에 이스케이프해 마크업으로 해석되지 않게 합니다.
const escapeHTML = (value = "") =>
  String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const nowISO = () => new Date().toISOString();
const makeId = () =>
  globalThis.crypto?.randomUUID?.() ??
    `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
// 태그는 대소문자를 구분하지 않지만, 화면에는 처음 입력한 표기를 유지합니다.
const normalizeTag = (tag) => String(tag ?? "").trim().replace(/\s+/g, " ");
const tagKey = (tag) => normalizeTag(tag).toLocaleLowerCase();
const uniqueTags = (values) => {
  const seen = new Set();
  return (Array.isArray(values) ? values : []).map(normalizeTag).filter(
    (tag) => {
      const key = tagKey(tag);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    },
  );
};
const parseTags = (value) => uniqueTags(String(value || "").split(/[,;\n]/));
const getFolder = (id) => state.folders.find((folder) => folder.id === id);
const getWord = (id) => state.words.find((word) => word.id === id);
const folderIdsOf = (
  word,
) => [...new Set((word.folderIds || []).filter((id) => !!getFolder(id)))];
const isUnfiled = (word) => folderIdsOf(word).length === 0;
const allTags = () => {
  const map = new Map();
  for (const item of [...state.folders, ...state.words]) {
    for (const tag of item.tags || []) {
      if (!map.has(tagKey(tag))) map.set(tagKey(tag), tag);
    }
  }
  return [...map.values()].sort((a, b) =>
    a.localeCompare(b, "ko-KR", { sensitivity: "base" })
  );
};
const formatDate = (value) => {
  if (!value) return "방금 전";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "방금 전"
    : new Intl.DateTimeFormat("ko-KR", { month: "short", day: "numeric" })
      .format(date);
};
const plural = (count, unit) => `${count}${unit}`;

// 저장 데이터와 가져온 파일을 같은 형태로 정리하고, 잘못된 연결은 제거합니다.
function normalizeState(input) {
  const safe = {
    version: APP_VERSION,
    words: [],
    folders: [],
    settings: { theme: input?.settings?.theme === "dark" ? "dark" : "light" },
  };
  if (!input || !Array.isArray(input.words) || !Array.isArray(input.folders)) {
    return safe;
  }
  const usedFolderIds = new Set();
  const folderRemap = new Map();
  for (const raw of input.folders) {
    if (!raw || typeof raw.name !== "string" || !raw.name.trim()) continue;
    const oldId = typeof raw.id === "string" ? raw.id : "";
    const id = oldId && !usedFolderIds.has(oldId) ? oldId : makeId();
    usedFolderIds.add(id);
    if (oldId && !folderRemap.has(oldId)) folderRemap.set(oldId, id);
    const timestamp = nowISO();
    safe.folders.push({
      id,
      name: raw.name.trim(),
      description: typeof raw.description === "string" ? raw.description : "",
      tags: uniqueTags(raw.tags),
      createdAt: raw.createdAt || timestamp,
      updatedAt: raw.updatedAt || timestamp,
    });
  }
  const usedWordIds = new Set();
  for (const raw of input.words) {
    if (!raw || typeof raw.name !== "string" || !raw.name.trim()) continue;
    const oldId = typeof raw.id === "string" ? raw.id : "";
    const id = oldId && !usedWordIds.has(oldId) ? oldId : makeId();
    usedWordIds.add(id);
    const folderIds = [
      ...new Set(
        (Array.isArray(raw.folderIds) ? raw.folderIds : []).map((folderId) =>
          folderRemap.get(String(folderId))
        ).filter(Boolean),
      ),
    ];
    const timestamp = nowISO();
    safe.words.push({
      id,
      name: raw.name.trim(),
      description: typeof raw.description === "string" ? raw.description : "",
      tags: uniqueTags(raw.tags),
      folderIds,
      createdAt: raw.createdAt || timestamp,
      updatedAt: raw.updatedAt || timestamp,
    });
  }
  return safe;
}

// 앱 데이터는 IndexedDB에 저장합니다. 실패하면 아래에서 브라우저 저장소를 사용합니다.
function openDatabase() {
  if (!("indexedDB" in window)) {
    return Promise.reject(new Error("IndexedDB를 사용할 수 없습니다."));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(DB_STORE)) {
        database.createObjectStore(DB_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error || new Error("저장소를 열 수 없습니다."));
  });
}

// 저장소를 열 때는 이전 저장 실패로 표시된 브라우저 저장소 백업을 먼저 확인합니다.
async function loadState() {
  try {
    const database = await openDatabase();
    dbPromise = Promise.resolve(database);
    let fallbackIsActive = false;
    try {
      fallbackIsActive = localStorage.getItem(FALLBACK_ACTIVE_KEY) === "1";
    } catch { /* 브라우저 저장소 사용이 차단된 경우 무시합니다. */ }
    if (fallbackIsActive) {
      try {
        const fallback = localStorage.getItem(FALLBACK_KEY);
        if (fallback) {
          state = normalizeState(JSON.parse(fallback));
          storageMode = "browser storage";
          return;
        }
      } catch {
        /* 백업을 읽을 수 없으면 아래에서 IndexedDB 데이터를 불러옵니다. */
      }
    }
    const saved = await new Promise((resolve, reject) => {
      const request = database.transaction(DB_STORE, "readonly").objectStore(
        DB_STORE,
      ).get(DB_KEY);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (saved) state = normalizeState(saved);
    else {
      const local = localStorage.getItem(FALLBACK_KEY);
      if (local) {
        try {
          state = normalizeState(JSON.parse(local));
        } catch {
          state = normalizeState(null);
        }
        await persistIndexedDB();
      }
    }
    storageMode = "IndexedDB";
  } catch {
    storageMode = "browser storage";
    try {
      const local = localStorage.getItem(FALLBACK_KEY);
      if (local) state = normalizeState(JSON.parse(local));
    } catch {
      state = normalizeState(null);
    }
  }
}

async function persistIndexedDB() {
  const database = dbPromise ? await dbPromise : await openDatabase();
  dbPromise = Promise.resolve(database);
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(DB_STORE, "readwrite");
    transaction.objectStore(DB_STORE).put(state, DB_KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error || new Error("저장에 실패했습니다."));
    transaction.onabort = () =>
      reject(transaction.error || new Error("저장에 실패했습니다."));
  });
}

// 저장 요청을 차례로 처리해 빠른 연속 수정에서 오래된 값이 덮어쓰지 않게 합니다.
function saveState() {
  const snapshot = structuredClone(state);
  saveQueue = saveQueue.then(async () => {
    try {
      if (storageMode === "IndexedDB") {
        await persistIndexedDB();
        try {
          localStorage.setItem(FALLBACK_KEY, JSON.stringify(snapshot));
        } catch { /* IndexedDB 저장에는 영향이 없어 무시합니다. */ }
        try {
          localStorage.removeItem(FALLBACK_ACTIVE_KEY);
        } catch { /* IndexedDB 저장에는 영향이 없어 무시합니다. */ }
      } else {
        localStorage.setItem(FALLBACK_KEY, JSON.stringify(snapshot));
        localStorage.setItem(FALLBACK_ACTIVE_KEY, "1");
      }
    } catch {
      storageMode = "browser storage";
      try {
        localStorage.setItem(FALLBACK_KEY, JSON.stringify(snapshot));
        localStorage.setItem(FALLBACK_ACTIVE_KEY, "1");
      } catch {
        toast(
          "변경 사항을 저장할 수 없어요. 브라우저 저장 공간이 가득 찼을 수 있습니다.",
          "error",
        );
      }
    }
  });
  return saveQueue;
}

function toast(message, kind = "success") {
  const item = document.createElement("div");
  item.className = `toast ${kind === "error" ? "error" : ""}`;
  item.innerHTML = `<span>${kind === "error" ? "!" : "✓"}</span><span>${
    escapeHTML(message)
  }</span>`;
  $("#toast-region").append(item);
  setTimeout(() => item.remove(), 3200);
}

function applyTheme() {
  const isDark = state.settings.theme === "dark";
  document.body.classList.toggle("dark", isDark);
  $("meta[name='theme-color']")?.setAttribute(
    "content",
    isDark ? "#171d1a" : "#f6f7f4",
  );
}

// 현재 경로에 맞는 화면만 다시 그립니다. 각 화면은 아래 렌더 함수에서 만듭니다.
function render() {
  if (!titles[currentView]) currentView = "dashboard";
  const [eyebrow, title] = titles[currentView];
  $("#topline-eyebrow").textContent = eyebrow;
  $("#topline-title").textContent = title;
  $$(".nav-link[data-view]").forEach((link) =>
    link.classList.toggle("active", link.dataset.view === currentView)
  );
  $("#nav-word-count").textContent = state.words.length;
  $("#nav-folder-count").textContent = state.folders.length;
  applyTheme();
  const root = $("#view-root");
  if (currentView === "dashboard") root.innerHTML = renderDashboard();
  else if (currentView === "words") root.innerHTML = renderWordBrowser(false);
  else if (currentView === "unfiled") root.innerHTML = renderWordBrowser(true);
  else if (currentView === "folders") root.innerHTML = renderFolders();
  else if (currentView === "tags") root.innerHTML = renderTags();
  else if (currentView === "picker") root.innerHTML = renderPicker();
  else if (currentView === "settings") root.innerHTML = renderSettings();
}

function renderTagChips(tags, clickable = false) {
  if (!tags?.length) return `<span class="field-help">태그 없음</span>`;
  return tags.map((tag) =>
    clickable
      ? `<button type="button" class="tag-chip clickable" data-action="filter-tag" data-tag="${
        escapeHTML(tag)
      }">${escapeHTML(tag)}</button>`
      : `<span class="tag-chip">${escapeHTML(tag)}</span>`
  ).join("");
}

function renderDashboard() {
  const unfiledCount = state.words.filter(isUnfiled).length;
  const sorted = [...state.words].sort((a, b) =>
    (b.updatedAt || "").localeCompare(a.updatedAt || "")
  ).slice(0, 5);
  const folders = [...state.folders].sort((a, b) =>
    (b.updatedAt || "").localeCompare(a.updatedAt || "")
  ).slice(0, 4);
  const today = new Intl.DateTimeFormat("ko-KR", {
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(new Date());

  const recentWordsMarkup = sorted.length
    ? `<div class="word-list">
        ${sorted.map((word) => `
          <div class="word-row">
            <span class="word-orb">${escapeHTML(word.name.trim().slice(0, 1).toUpperCase())}</span>
            <div class="word-row-content">
              <div class="word-row-title">${escapeHTML(word.name)}</div>
              <p class="word-row-desc">${escapeHTML(
                word.description ||
                  (word.tags.length ? word.tags.join(" · ") : "설명이 없습니다."),
              )}</p>
            </div>
            <div class="word-row-side">
              <small>${escapeHTML(formatDate(word.updatedAt))}</small>
              <button
                class="icon-button"
                type="button"
                aria-label="${escapeHTML(word.name)} 수정"
                data-action="edit-word"
                data-id="${escapeHTML(word.id)}"
              >···</button>
            </div>
          </div>
        `).join("")}
      </div>`
    : emptyState(
      "첫 단어를 기다리고 있어요",
      "단어를 추가해 나만의 작은 보관함을 만들어 보세요.",
      "new-word",
      "＋ 단어 추가",
    );

  const quickActionsMarkup = `
    <div class="quick-grid">
      <button class="quick-card" type="button" data-action="new-word">
        <span class="quick-icon">＋</span>
        <span><strong>단어 추가</strong><small>새로운 아이디어 저장</small></span>
      </button>
      <button class="quick-card" type="button" data-action="new-folder">
        <span class="quick-icon">▰</span>
        <span><strong>폴더 만들기</strong><small>새로운 모음 만들기</small></span>
      </button>
      <button class="quick-card" type="button" data-action="go-picker">
        <span class="quick-icon">✳</span>
        <span><strong>랜덤으로 뽑기</strong><small>무작위 단어 찾기</small></span>
      </button>
      <button class="quick-card" type="button" data-action="open-settings">
        <span class="quick-icon">↥</span>
        <span><strong>단어 백업</strong><small>보관함 내보내기</small></span>
      </button>
    </div>`;

  const folderStripMarkup = folders.length
    ? `<div class="collection-strip">
        ${folders.map((folder) => `
          <button
            class="collection-chip"
            type="button"
            data-action="open-folder"
            data-id="${escapeHTML(folder.id)}"
          >
            <strong>▰ &nbsp;${escapeHTML(folder.name)}</strong>
            <small>${folderCount(folder)}개 단어</small>
          </button>
        `).join("")}
      </div>`
    : `<p class="empty-note">폴더를 만들면 여기에 표시돼요.</p>`;

  return `
    <section class="section">
      <div class="section-heading">
        <div>
          <h2>한눈에 보기</h2>
          <p>단어를 하나씩 모으며 나만의 보관함을 채워 보세요.</p>
        </div>
        <span class="text-link">${escapeHTML(today)}</span>
      </div>

      <div class="stat-grid">
        <article class="stat-card">
          <div class="stat-top"><span>전체 단어</span><span class="stat-icon">▤</span></div>
          <div class="stat-number">${state.words.length}</div>
          <div class="stat-foot">보관함에 저장됨</div>
        </article>
        <article class="stat-card">
          <div class="stat-top"><span>폴더</span><span class="stat-icon">▰</span></div>
          <div class="stat-number">${state.folders.length}</div>
          <div class="stat-foot">개의 모음</div>
        </article>
        <article class="stat-card">
          <div class="stat-top"><span>미분류</span><span class="stat-icon">↗</span></div>
          <div class="stat-number">${unfiledCount}</div>
          <div class="stat-foot">아직 폴더에 없는 단어</div>
        </article>
        <article class="stat-card">
          <div class="stat-top"><span>고유 태그</span><span class="stat-icon">◇</span></div>
          <div class="stat-number">${allTags().length}</div>
          <div class="stat-foot">다양한 탐색 방법</div>
        </article>
      </div>
    </section>

    <div class="dashboard-columns">
      <section class="panel">
        <div class="panel-header">
          <div><h2>최근 수정한 단어</h2><p>최근에 추가하거나 수정한 단어예요.</p></div>
          <a href="#words" class="text-link">모두 보기 →</a>
        </div>
        ${recentWordsMarkup}
      </section>

      <section class="panel">
        <div class="panel-header">
          <div><h2>바로 시작하기</h2><p>원하는 작업을 골라 보세요.</p></div>
        </div>
        ${quickActionsMarkup}
        <div class="panel-header" style="padding-top:4px">
          <div><h2>나의 폴더</h2><p>아이디어를 어울리는 곳에 모아 보세요.</p></div>
          <a href="#folders" class="text-link">모두 보기 →</a>
        </div>
        ${folderStripMarkup}
      </section>
    </div>`;
}

function emptyState(title, description, action, label) {
  return `<div class="empty-state"><span class="empty-symbol">✦</span><h3>${
    escapeHTML(title)
  }</h3><p>${escapeHTML(description)}</p>${
    action
      ? `<button type="button" class="button button-primary button-small" data-action="${action}">${
        escapeHTML(label)
      }</button>`
      : ""
  }</div>`;
}

function folderCount(folder) {
  return state.words.filter((word) => folderIdsOf(word).includes(folder.id))
    .length;
}

// 브라우저 검색, 폴더 필터, 태그 AND/OR 조건을 한곳에서 적용합니다.
function wordMatches(word, unfiledOnly = false) {
  if (unfiledOnly && !isUnfiled(word)) return false;
  if (!unfiledOnly && browser.folderId !== "all") {
    if (
      browser.folderId === "unfiled"
        ? !isUnfiled(word)
        : !folderIdsOf(word).includes(browser.folderId)
    ) return false;
  }
  if (browser.search) {
    const needle = browser.search.toLocaleLowerCase();
    if (
      !`${word.name} ${word.description} ${(word.tags || []).join(" ")}`
        .toLocaleLowerCase().includes(needle)
    ) return false;
  }
  if (browser.tagNames.length) {
    const has = (tag) =>
      (word.tags || []).some((item) => tagKey(item) === tagKey(tag));
    if (
      browser.tagLogic === "and"
        ? !browser.tagNames.every(has)
        : !browser.tagNames.some(has)
    ) return false;
  }
  return true;
}

function renderWordBrowser(unfiledOnly = false) {
  const filtered = state.words.filter((word) => wordMatches(word, unfiledOnly));
  const sorts = {
    updated: (a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""),
    name: (a, b) =>
      a.name.localeCompare(b.name, "ko-KR", { sensitivity: "base" }),
    created: (a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""),
  };
  filtered.sort(sorts[browser.sort] || sorts.updated);

  const tags = allTags();
  const folderOptions = state.folders.map((folder) => `
    <option value="${escapeHTML(folder.id)}" ${
      browser.folderId === folder.id ? "selected" : ""
    }>${escapeHTML(folder.name)}</option>
  `).join("");

  const folderFilter = unfiledOnly
    ? ""
    : `
      <select
        class="control filter-select"
        id="word-folder-filter"
        aria-label="폴더로 필터"
      >
        <option value="all" ${browser.folderId === "all" ? "selected" : ""}>
          모든 폴더
        </option>
        <option value="unfiled" ${browser.folderId === "unfiled" ? "selected" : ""}>
          미분류만
        </option>
        ${folderOptions}
      </select>`;

  const tagOptions = tags.length
    ? tags.map((tag) => `
        <label class="choice-item">
          <input
            type="checkbox"
            data-browser-tag="${escapeHTML(tag)}"
            ${browser.tagNames.some((name) => tagKey(name) === tagKey(tag)) ? "checked" : ""}
          />
          <span>${escapeHTML(tag)}</span>
        </label>
      `).join("")
    : `<small class="field-help">단어나 폴더에 태그를 추가해 보세요.</small>`;

  const tagFilter = `
    <details class="tag-filter" ${tagFilterOpen ? "open" : ""}>
      <summary class="button button-quiet button-small">
        ◇ 태그${browser.tagNames.length ? ` (${browser.tagNames.length})` : ""}
      </summary>
      <div class="tag-filter-popover">
        <div class="segmented">
          <button
            type="button"
            data-action="browser-tag-logic"
            data-value="and"
            class="${browser.tagLogic === "and" ? "selected" : ""}"
          >모두 포함</button>
          <button
            type="button"
            data-action="browser-tag-logic"
            data-value="or"
            class="${browser.tagLogic === "or" ? "selected" : ""}"
          >하나 이상 포함</button>
        </div>
        ${tagOptions}
        <button type="button" class="text-link" data-action="clear-browser-tags">
          태그 필터 지우기
        </button>
      </div>
    </details>`;

  const sortOptions = `
    <select class="control" id="word-sort" aria-label="단어 정렬">
      <option value="updated" ${browser.sort === "updated" ? "selected" : ""}>최근 수정순</option>
      <option value="created" ${browser.sort === "created" ? "selected" : ""}>최근 추가순</option>
      <option value="name" ${browser.sort === "name" ? "selected" : ""}>이름순</option>
    </select>`;

  const selectedTagChips = browser.tagNames.length
    ? `<div class="chip-row selected-tag-filters">
        ${browser.tagNames.map((tag) => `
          <button
            type="button"
            class="tag-chip clickable"
            data-action="remove-browser-tag"
            data-tag="${escapeHTML(tag)}"
          >${escapeHTML(tag)} ×</button>
        `).join("")}
      </div>`
    : "";

  const wordCards = filtered.length
    ? `<div class="cards-grid">${filtered.map(renderWordCard).join("\n")}</div>`
    : emptyState(
      state.words.length ? "검색 결과가 없어요" : "보관함이 비어 있어요",
      state.words.length
        ? "검색어나 필터를 바꿔 보세요."
        : "단어를 추가해 나만의 아이디어를 모아 보세요.",
      state.words.length ? null : "new-word",
      state.words.length ? null : "＋ 단어 추가",
    );

  return `
    <section class="section">
      <div class="section-heading">
        <div>
          <h2>${unfiledOnly ? "미분류 단어" : "내 단어 보관함"}</h2>
          <p>${unfiledOnly
            ? "아직 폴더에 담기지 않은 단어예요."
            : "저장한 단어를 검색하고, 정렬하고, 탐색해 보세요."}</p>
        </div>
        <button class="button button-primary button-small" type="button" data-action="new-word">
          ＋ 단어 추가
        </button>
      </div>

      <div class="toolbar">
        <div class="search-wrap">
          <span class="search-symbol">⌕</span>
          <input
            class="search-input"
            id="word-search"
            type="search"
            placeholder="단어, 설명, 태그 검색…"
            value="${escapeHTML(browser.search)}"
            aria-label="단어 검색"
          />
        </div>
        ${folderFilter}
        ${tagFilter}
        ${sortOptions}
      </div>

      ${selectedTagChips}
      <div class="result-meta">
        <span><strong>${filtered.length}</strong>개 단어</span>
        <span>이 기기에 저장됨</span>
      </div>
      ${wordCards}
    </section>`;
}

function renderWordCard(word) {
  const folders = folderIdsOf(word).map(getFolder).filter(Boolean);
  const desc = word.description
    ? escapeHTML(word.description)
    : "설명을 추가하지 않았어요.";
  const tagChips = word.tags.length
    ? renderTagChips(word.tags, true)
    : `<span class="field-help">태그 없음</span>`;
  const folderChips = folders.length
    ? folders.map((folder) => `
        <button
          type="button"
          class="folder-chip"
          title="${escapeHTML(folder.name)} 폴더 열기"
          data-action="open-folder"
          data-id="${escapeHTML(folder.id)}"
        >▰ ${escapeHTML(folder.name)}</button>
      `).join("")
    : `<span class="field-help">미분류</span>`;

  return `
    <article class="word-card">
      <div class="word-card-top">
        <h3>${escapeHTML(word.name)}</h3>
        <div class="card-actions">
          <button
            class="icon-button"
            type="button"
            aria-label="${escapeHTML(word.name)} 수정"
            title="단어 수정"
            data-action="edit-word"
            data-id="${escapeHTML(word.id)}"
          >✎</button>
          <button
            class="icon-button danger"
            type="button"
            aria-label="${escapeHTML(word.name)} 삭제"
            title="단어 삭제"
            data-action="delete-word"
            data-id="${escapeHTML(word.id)}"
          >×</button>
        </div>
      </div>

      <p class="word-card-desc">${desc}</p>
      <div class="chip-row">${tagChips}</div>
      <div class="card-divider"></div>
      <div class="chip-row">${folderChips}</div>

      <div class="card-foot word-card-foot">
        <span>${escapeHTML(formatDate(word.updatedAt))} 수정</span>
        <span>${plural(word.tags.length, "개 태그")}</span>
      </div>
    </article>`;
}

function renderFolders() {
  const folders = [...state.folders].sort((a, b) =>
    a.name.localeCompare(b.name, "ko-KR", { sensitivity: "base" })
  );
  const folderCards = folders.length
    ? `<div class="cards-grid">
        ${folders.map((folder) => {
          const folderTags = folder.tags.length
            ? renderTagChips(folder.tags, true)
            : `<span class="field-help">태그 없음</span>`;

          return `
            <article class="folder-card">
              <div class="folder-card-top">
                <span class="folder-icon">▰</span>
                <div class="folder-card-heading">
                  <h3>${escapeHTML(folder.name)}</h3>
                  <div class="folder-meta">
                    <strong>${folderCount(folder)}</strong>
                    <span>개 단어</span>
                  </div>
                </div>
                <div class="card-actions">
                  <button
                    class="icon-button"
                    type="button"
                    title="폴더 수정"
                    aria-label="${escapeHTML(folder.name)} 폴더 수정"
                    data-action="edit-folder"
                    data-id="${escapeHTML(folder.id)}"
                  >✎</button>
                  <button
                    class="icon-button danger"
                    type="button"
                    title="폴더 삭제"
                    aria-label="${escapeHTML(folder.name)} 폴더 삭제"
                    data-action="delete-folder"
                    data-id="${escapeHTML(folder.id)}"
                  >×</button>
                </div>
              </div>

              <p class="folder-description">
                ${escapeHTML(folder.description || "아이디어를 모아 두는 폴더예요.")}
              </p>
              <div class="chip-row">${folderTags}</div>

              <div class="folder-actions">
                <span class="field-help">${escapeHTML(formatDate(folder.createdAt))} 생성</span>
                <button
                  class="text-link"
                  type="button"
                  data-action="open-folder"
                  data-id="${escapeHTML(folder.id)}"
                >단어 보기 →</button>
              </div>
            </article>`;
        }).join("")}
      </div>`
    : emptyState(
      "첫 폴더를 만들어 보세요",
      "폴더를 활용하면 관련 단어를 함께 모으면서도 여러 곳에 자유롭게 담을 수 있어요.",
      "new-folder",
      "＋ 폴더 만들기",
    );

  return `
    <section class="section">
      <div class="section-heading">
        <div>
          <h2>나의 폴더</h2>
          <p>하나의 단어를 여러 폴더에 함께 담을 수 있어요.</p>
        </div>
        <button class="button button-primary button-small" type="button" data-action="new-folder">
          ＋ 폴더 만들기
        </button>
      </div>
      ${folderCards}
    </section>`;
}

function tagStats(tag) {
  const key = tagKey(tag);
  return {
    words:
      state.words.filter((word) =>
        word.tags.some((item) => tagKey(item) === key)
      ).length,
    folders:
      state.folders.filter((folder) =>
        folder.tags.some((item) => tagKey(item) === key)
      ).length,
  };
}

function renderTags() {
  const tags = allTags().filter((tag) =>
    tag.toLocaleLowerCase().includes(tagSearch.toLocaleLowerCase())
  );
  const recentWords = state.words.filter((word) => word.tags.length).length;
  const tagCards = tags.map((tag) => {
    const stats = tagStats(tag);

    return `
      <article class="tag-card">
        <span class="tag-card-dot">◇</span>
        <div class="tag-card-copy">
          <strong title="${escapeHTML(tag)}">${escapeHTML(tag)}</strong>
          <small>단어 ${stats.words}개 · 폴더 ${stats.folders}개</small>
        </div>
        <div class="tag-card-actions">
          <button
            class="icon-button"
            type="button"
            title="태그 이름 바꾸기"
            aria-label="${escapeHTML(tag)} 태그 이름 바꾸기"
            data-action="rename-tag"
            data-tag="${escapeHTML(tag)}"
          >✎</button>
          <button
            class="icon-button danger"
            type="button"
            title="태그 삭제"
            aria-label="${escapeHTML(tag)} 태그 삭제"
            data-action="delete-tag"
            data-tag="${escapeHTML(tag)}"
          >×</button>
        </div>
      </article>`;
  }).join("\n");

  const tagContent = tags.length
    ? `
      <div class="tag-cloud">
        ${tags.map((tag) => `
          <button
            class="tag-chip clickable"
            type="button"
            data-action="filter-tag"
            data-tag="${escapeHTML(tag)}"
          >${escapeHTML(tag)}</button>
        `).join("")}
      </div>

      <div class="section-heading tag-management-heading">
        <div>
          <h2>태그 관리</h2>
          <p>태그를 바꾸거나 삭제하면 해당 태그를 쓰는 모든 단어와 폴더에 적용돼요.</p>
        </div>
      </div>
      <div class="tag-summary">${tagCards}</div>`
    : emptyState(
      allTags().length ? "일치하는 태그가 없어요" : "단어에 태그를 달아 보세요",
      allTags().length
        ? "다른 태그 이름을 검색해 보세요."
        : "단어나 폴더에 태그를 추가한 뒤 공통된 주제를 탐색할 수 있어요.",
      allTags().length ? null : "new-word",
      allTags().length ? null : "＋ 단어 추가",
    );

  return `
    <section class="section">
      <div class="section-heading">
        <div>
          <h2>태그 한눈에 보기</h2>
          <p>단어와 폴더에 공통으로 붙은 주제를 찾아보세요.</p>
        </div>
        <span class="field-help">
          태그가 있는 단어 ${recentWords}개 · 전체 태그 ${allTags().length}개
        </span>
      </div>

      <div class="tag-search-row">
        <div class="search-wrap">
          <span class="search-symbol">⌕</span>
          <input
            class="search-input"
            id="tag-search"
            type="search"
            placeholder="태그 검색…"
            value="${escapeHTML(tagSearch)}"
            aria-label="태그 검색"
          />
        </div>
      </div>
      ${tagContent}
    </section>`;
}

function checkedItems(items, selected, keyName, idAttr = false) {
  return items.map((item) => {
    const key = idAttr ? item.id : item;
    const label = idAttr ? item.name : item;
    const selectedValue = selected.some((
      value,
    ) => (idAttr ? value === key : tagKey(value) === tagKey(key)));
    return `<label class="choice-item"><input type="checkbox" ${
      idAttr
        ? `data-picker-folder="${escapeHTML(key)}"`
        : `data-picker-tag="${escapeHTML(key)}"`
    } ${selectedValue ? "checked" : ""} /><span>${
      escapeHTML(label)
    }</span></label>`;
  }).join("");
}

// 후보 목록은 ID 기준으로 중복을 제거해, 여러 폴더에 든 단어도 한 번만 셉니다.
function pickerCandidates() {
  const mode = picker.mode;
  let candidates = [...state.words];
  if (mode === "unfiled") candidates = candidates.filter(isUnfiled);
  if (mode === "folders" || mode === "combined") {
    if (!picker.folderIds.length) return [];
    candidates = candidates.filter((word) => {
      const ids = new Set(folderIdsOf(word));
      return picker.folderLogic === "intersection"
        ? picker.folderIds.every((id) => ids.has(id))
        : picker.folderIds.some((id) => ids.has(id));
    });
  }
  if (mode === "tags" || mode === "combined") {
    if (!picker.tagNames.length) return [];
    candidates = candidates.filter((word) => {
      const has = (tag) =>
        word.tags.some((item) => tagKey(item) === tagKey(tag));
      return picker.tagLogic === "and"
        ? picker.tagNames.every(has)
        : picker.tagNames.some(has);
    });
  }
  return [...new Map(candidates.map((word) => [word.id, word])).values()];
}

function renderPicker() {
  const candidates = pickerCandidates();
  const quantity = Number(picker.quantity);
  const validQuantity = Number.isInteger(quantity) && quantity > 0;
  const tooMany = validQuantity && !picker.allowDuplicates && quantity > candidates.length;
  const canDraw = validQuantity && candidates.length > 0 && !tooMany;
  const modeOptions = [
    ["all", "전체 보관함"],
    ["folders", "폴더 선택"],
    ["tags", "태그 선택"],
    ["combined", "폴더 + 태그"],
    ["unfiled", "미분류 단어"],
  ];
  const mode = picker.mode;
  const selectedTags = allTags();

  const modeOptionsMarkup = modeOptions.map(([value, label]) => `
    <option value="${value}" ${mode === value ? "selected" : ""}>${label}</option>
  `).join("");

  const folderChoices = state.folders.length
    ? checkedItems(state.folders, picker.folderIds, "folder", true)
    : `<small class="field-help">이 필터를 쓰려면 먼저 폴더를 만들어 주세요.</small>`;
  const folderControls = mode === "folders" || mode === "combined"
    ? `
      <div class="form-field">
        <span class="field-label">폴더 선택</span>
        <div class="choice-list">${folderChoices}</div>
        <small>
          단어는 여러 폴더에 담길 수 있어요. 합집합은 선택한 폴더 중 하나 이상,
          교집합은 모두에 속한 단어를 포함해요.
        </small>
        <div class="segmented">
          <button
            type="button"
            data-action="picker-folder-logic"
            data-value="union"
            class="${picker.folderLogic === "union" ? "selected" : ""}"
          >합집합 · 하나 이상</button>
          <button
            type="button"
            data-action="picker-folder-logic"
            data-value="intersection"
            class="${picker.folderLogic === "intersection" ? "selected" : ""}"
          >교집합 · 모두</button>
        </div>
      </div>`
    : "";

  const tagChoices = selectedTags.length
    ? checkedItems(selectedTags, picker.tagNames, "tag")
    : `<small class="field-help">단어나 폴더에 태그를 추가해 보세요.</small>`;
  const tagControls = mode === "tags" || mode === "combined"
    ? `
      <div class="form-field">
        <span class="field-label">태그 선택</span>
        <div class="choice-list">${tagChoices}</div>
        <small>
          태그 이름이 정확히 일치하는 단어를 찾습니다.
          선택한 태그의 적용 방식을 고르세요.
        </small>
        <div class="segmented">
          <button
            type="button"
            data-action="picker-tag-logic"
            data-value="and"
            class="${picker.tagLogic === "and" ? "selected" : ""}"
          >모두 일치</button>
          <button
            type="button"
            data-action="picker-tag-logic"
            data-value="or"
            class="${picker.tagLogic === "or" ? "selected" : ""}"
          >하나라도 일치</button>
        </div>
      </div>`
    : "";

  const quantityPresets = [1, 3, 5, 10, 20, 50].map((number) => `
    <button
      type="button"
      class="preset-button ${String(number) === String(picker.quantity) ? "active" : ""}"
      data-action="picker-preset"
      data-value="${number}"
    >${number}</button>
  `).join("");

  const availabilityMessage = tooMany
    ? `${candidates.length}개만 뽑을 수 있어요. 개수를 줄이거나 중복을 허용해 주세요.`
    : candidates.length
    ? "뽑을 수 있는 고유 단어"
    : "조건에 맞는 단어가 없어요.";

  const resultsMarkup = picker.results?.length
    ? `<div class="results-list">
        ${picker.results.map((word, index) => `
          <article class="result-card" style="animation-delay:${Math.min(index * 45, 360)}ms">
            <span class="result-number">${String(index + 1).padStart(2, "0")}</span>
            <div class="result-copy">
              <strong>${escapeHTML(word.name)}</strong>
              <small>${escapeHTML(word.tags.length ? word.tags.join(" · ") : "태그 없음")}</small>
            </div>
          </article>
        `).join("")}
      </div>`
    : `
      <div class="results-empty">
        <span class="empty-symbol">✳</span>
        <strong>다음에 만날 단어를 기다리고 있어요</strong>
        <p>조건과 개수를 정한 뒤 랜덤 뽑기를 눌러 보세요.</p>
      </div>`;

  const resultSummary = picker.results?.length
    ? `${picker.results.length}개 단어를 뽑았어요.`
    : "다시 뽑거나 지울 때까지 결과가 유지돼요.";
  const resultButtonDisabled = picker.results?.length ? "" : "disabled";

  return `
    <section class="section">
      <div class="picker-layout">
        <section class="panel picker-panel">
          <h2>뽑기 설정</h2>
          <p>조건에 맞는 단어를 모아 두고, 무작위로 골라 보세요.</p>

          <div class="form-field">
            <label for="picker-mode">선택 방식</label>
            <select class="field-select" id="picker-mode">
              ${modeOptionsMarkup}
            </select>
          </div>

          ${folderControls}
          ${tagControls}

          <div class="form-field">
            <span class="field-label">몇 개를 뽑을까요?</span>
            <div class="preset-row">${quantityPresets}</div>
            <input
              class="field-input"
              id="picker-quantity"
              type="number"
              min="1"
              step="1"
              inputmode="numeric"
              value="${escapeHTML(picker.quantity)}"
              aria-label="뽑을 단어 개수"
            />
          </div>

          <div class="form-field">
            <label class="checkline">
              <input id="picker-duplicates" type="checkbox" ${
                picker.allowDuplicates ? "checked" : ""
              } />
              <span>
                <strong>중복 허용</strong><br />
                한 단어가 한 번의 뽑기에서 여러 번 나올 수 있어요.
              </span>
            </label>
          </div>

          <div class="candidate-banner ${
            tooMany || !candidates.length ? "warning" : ""
          }">
            <span>${availabilityMessage}</span>
            <strong>${candidates.length}</strong>
          </div>

          <button
            type="button"
            class="button button-primary draw-button"
            data-action="draw"
            ${canDraw ? "" : "disabled"}
          >✳ &nbsp; ${validQuantity ? `${quantity}개 뽑기` : "랜덤 뽑기"}</button>
        </section>

        <section class="panel picker-panel">
          <div class="results-head">
            <div>
              <h2>뽑힌 단어</h2>
              <p class="results-summary">${resultSummary}</p>
            </div>
            <div class="results-actions">
              <button class="button button-quiet button-small" type="button" data-action="copy-results" ${resultButtonDisabled}>복사</button>
              <button class="button button-quiet button-small" type="button" data-action="export-results" ${resultButtonDisabled}>내보내기</button>
              <button class="button button-quiet button-small" type="button" data-action="clear-results" ${resultButtonDisabled}>지우기</button>
            </div>
          </div>
          ${resultsMarkup}
        </section>
      </div>
    </section>`;
}

function renderSettings() {
  const storageLabel = storageMode === "IndexedDB"
    ? "IndexedDB"
    : "브라우저 저장소";
  const darkModeChecked = state.settings.theme === "dark" ? "checked" : "";

  return `
    <section class="section">
      <div class="settings-grid">
        <section class="settings-card">
          <h2>백업 및 복원</h2>
          <p>보관함을 백업하거나 기존 백업 파일을 이 기기에 가져올 수 있어요.</p>

          <div class="settings-action">
            <div>
              <strong>전체 데이터 내보내기</strong>
              <small>단어, 폴더, 태그와 연결 정보를 JSON 파일로 저장합니다.</small>
            </div>
            <button
              class="button button-quiet button-small"
              type="button"
              data-action="export-data"
            >↓ JSON 내보내기</button>
          </div>

          <div class="form-field settings-import-field">
            <label for="import-strategy">가져오기 방식</label>
            <select class="field-select" id="import-strategy">
              <option value="merge">내 보관함에 합치기</option>
              <option value="replace">내 보관함 바꾸기</option>
            </select>
            <small class="field-help">
              합치기는 기존 데이터를 유지하며 중복 ID를 안전하게 새로 지정합니다.
              보관함을 바꾸기 전에는 확인을 요청합니다.
            </small>
          </div>

          <div class="settings-action">
            <div>
              <strong>백업 가져오기</strong>
              <small>
                워드웰 JSON 백업 파일을 선택하세요. 잘못된 항목이나 끊어진 폴더 연결은 제외됩니다.
              </small>
            </div>
            <button
              class="button button-quiet button-small"
              type="button"
              data-action="import-data"
            >↑ JSON 가져오기</button>
          </div>
        </section>

        <section class="settings-card">
          <h2>화면 모양</h2>
          <p>편안하게 사용할 수 있도록 화면 테마를 선택하세요.</p>

          <div class="settings-action">
            <div>
              <strong>어두운 테마</strong>
              <small>선택한 테마는 이 기기에 저장됩니다.</small>
            </div>
            <label class="checkline">
              <input id="theme-toggle" type="checkbox" ${darkModeChecked} />
              <span>사용</span>
            </label>
          </div>

          <div class="privacy-note">
            <span>◈</span>
            <span>
              <strong>내 데이터는 내 기기에 저장돼요.</strong><br />
              단어는 이 브라우저에 저장되며 서버로 전송되지 않습니다.
              브라우저 데이터를 지우기 전에 백업 파일을 내보내세요.
            </span>
          </div>

          <div class="settings-action settings-storage-action">
            <div>
              <strong>저장 방식</strong>
              <small>
                ${escapeHTML(storageLabel)} · 단어 ${state.words.length}개 ·
                폴더 ${state.folders.length}개
              </small>
            </div>
            <span class="tag-chip">이 기기에 저장</span>
          </div>
        </section>
      </div>

      <section class="settings-card danger-zone">
        <h2>보관함 초기화</h2>
        <p>
          이 브라우저에 저장된 모든 단어, 폴더, 태그를 삭제합니다.
          삭제한 데이터는 복원할 수 없습니다.
        </p>
        <button
          class="button button-danger button-small"
          type="button"
          data-action="clear-library"
        >전체 데이터 삭제</button>
      </section>
    </section>`;
}

function openModal(kind, id = null) {
  const existing = id ? (kind === "word" ? getWord(id) : getFolder(id)) : null;

  if (kind === "word") {
    const word = existing ||
      { name: "", description: "", tags: [], folderIds: [] };
    const folderChecks = state.folders.length
      ? state.folders.map((folder) =>
        `
          <label class="checkline">
            <input
              type="checkbox"
              name="folderIds"
              value="${escapeHTML(folder.id)}"
              ${(word.folderIds || []).includes(folder.id) ? "checked" : ""}
            />
            <span>${escapeHTML(folder.name)}</span>
          </label>
        `
      ).join("")
      : `<span class="field-help">이 단어는 미분류로 저장돼요. 나중에 폴더에 추가할 수 있습니다.</span>`;
    const wordTitle = existing ? "단어 수정" : "단어 추가";
    const submitLabel = existing ? "변경 사항 저장" : "단어 추가";

    showModal(
      `
        <form data-form="word" data-id="${escapeHTML(existing?.id || "")}">
          <div class="modal-header">
            <div>
              <h2>${wordTitle}</h2>
              <p>기억해 두고 싶은 단어와 생각을 저장하세요.</p>
            </div>
            <button
              class="icon-button"
              type="button"
              aria-label="닫기"
              data-action="close-modal"
            >×</button>
          </div>

          <div class="modal-body">
            <div class="form-field">
              <label class="field-label required" for="word-name">단어</label>
              <input
                class="field-input"
                id="word-name"
                name="name"
                required
                maxlength="120"
                autofocus
                value="${escapeHTML(word.name)}"
                placeholder="예: 설렘"
              />
            </div>

            <div class="form-field">
              <label class="field-label" for="word-description">
                설명 <span class="optional-label">(선택)</span>
              </label>
              <textarea
                class="field-textarea"
                id="word-description"
                name="description"
                maxlength="1000"
                placeholder="뜻이나 기억하고 싶은 내용을 적어 보세요…"
              >${escapeHTML(word.description)}</textarea>
            </div>

            <div class="form-field">
              <label class="field-label" for="word-tags">
                태그 <span class="optional-label">(쉼표로 구분)</span>
              </label>
              <input
                class="field-input"
                id="word-tags"
                name="tags"
                list="known-tags"
                value="${escapeHTML(word.tags.join(", "))}"
                placeholder="언어, 감정, 자연"
              />
              <datalist id="known-tags">
                ${allTags().map((tag) => `
                  <option value="${escapeHTML(tag)}"></option>
                `).join("")}
              </datalist>
              <small>
                대소문자가 달라도 같은 태그로 취급하며, 폴더와 태그를 공유할 수 있어요.
              </small>
            </div>

            <div class="form-field">
              <span class="field-label">
                폴더 <span class="optional-label">(여러 개 선택 가능)</span>
              </span>
              <div class="folder-checks">${folderChecks}</div>
              <button
                type="button"
                class="text-link folder-create-link"
                data-action="new-folder-from-word"
              >＋ 폴더 만들기</button>
            </div>
          </div>

          <div class="modal-footer">
            <button
              class="button button-quiet"
              type="button"
              data-action="close-modal"
            >취소</button>
            <button class="button button-primary" type="submit">
              ${submitLabel}
            </button>
          </div>
        </form>
      `,
    );
  } else if (kind === "folder") {
    const folder = existing || { name: "", description: "", tags: [] };
    const folderTitle = existing ? "폴더 수정" : "폴더 만들기";
    const submitLabel = existing ? "변경 사항 저장" : "폴더 만들기";

    showModal(
      `
        <form data-form="folder" data-id="${escapeHTML(existing?.id || "")}">
          <div class="modal-header">
            <div>
              <h2>${folderTitle}</h2>
              <p>하나의 단어를 여러 폴더에 함께 담을 수 있어요.</p>
            </div>
            <button
              class="icon-button"
              type="button"
              aria-label="닫기"
              data-action="close-modal"
            >×</button>
          </div>

          <div class="modal-body">
            <div class="form-field">
              <label class="field-label required" for="folder-name">폴더 이름</label>
              <input
                class="field-input"
                id="folder-name"
                name="name"
                required
                maxlength="100"
                value="${escapeHTML(folder.name)}"
                placeholder="예: 이야기 소재"
              />
            </div>

            <div class="form-field">
              <label class="field-label" for="folder-description">
                설명 <span class="optional-label">(선택)</span>
              </label>
              <textarea
                class="field-textarea"
                id="folder-description"
                name="description"
                maxlength="700"
                placeholder="이 폴더에 어떤 단어를 모을까요?"
              >${escapeHTML(folder.description)}</textarea>
            </div>

            <div class="form-field">
              <label class="field-label" for="folder-tags">
                태그 <span class="optional-label">(쉼표로 구분)</span>
              </label>
              <input
                class="field-input"
                id="folder-tags"
                name="tags"
                list="known-tags"
                value="${escapeHTML(folder.tags.join(", "))}"
                placeholder="창작, 즐겨찾기"
              />
              <datalist id="known-tags">
                ${allTags().map((tag) => `
                  <option value="${escapeHTML(tag)}"></option>
                `).join("")}
              </datalist>
            </div>
          </div>

          <div class="modal-footer">
            <button
              class="button button-quiet"
              type="button"
              data-action="close-modal"
            >취소</button>
            <button class="button button-primary" type="submit">
              ${submitLabel}
            </button>
          </div>
        </form>
      `,
    );
  } else if (kind === "tag") {
    showModal(
      `
        <form data-form="tag" data-tag="${escapeHTML(id)}">
          <div class="modal-header">
            <div>
              <h2>태그 이름 바꾸기</h2>
              <p>이 태그를 사용하는 모든 곳에 변경 사항이 적용돼요.</p>
            </div>
            <button
              class="icon-button"
              type="button"
              aria-label="닫기"
              data-action="close-modal"
            >×</button>
          </div>

          <div class="modal-body">
            <div class="form-field">
              <label class="field-label required" for="tag-new-name">
                새 태그 이름
              </label>
              <input
                class="field-input"
                id="tag-new-name"
                name="name"
                required
                maxlength="50"
                value="${escapeHTML(id)}"
              />
            </div>
          </div>

          <div class="modal-footer">
            <button
              class="button button-quiet"
              type="button"
              data-action="close-modal"
            >취소</button>
            <button class="button button-primary" type="submit">
              이름 바꾸기
            </button>
          </div>
        </form>
      `,
    );
  }

  // 모달을 연 직후 입력 칸에 포커스를 두면 키보드로 바로 입력할 수 있습니다.
  const focus = $("input[autofocus], #tag-new-name", $("#modal-root"));
  if (focus) setTimeout(() => focus.focus(), 30);
}

function showModal(content) {
  $("#modal-root").innerHTML = `
    <div class="modal-backdrop" data-action="backdrop-close">
      <section class="modal" role="dialog" aria-modal="true">
        ${content}
      </section>
    </div>
  `;
}

function closeModal() {
  $("#modal-root").innerHTML = "";
}

function formData(form) {
  return new FormData(form);
}

// 폼 값을 정리하고 기존 단어를 갱신하거나 새 단어로 보관합니다.
function saveWordForm(form) {
  const data = formData(form);
  const name = String(data.get("name") || "").trim();
  if (!name) {
    toast("단어를 입력해 주세요.", "error");
    return;
  }
  const id = form.dataset.id;
  const old = id ? getWord(id) : null;
  const folderIds = [
    ...form.querySelectorAll('input[name="folderIds"]:checked'),
  ].map((input) => input.value).filter((folderId) => !!getFolder(folderId));
  const word = {
    id: old?.id || makeId(),
    name,
    description: String(data.get("description") || "").trim(),
    tags: parseTags(data.get("tags")),
    folderIds: [...new Set(folderIds)],
    createdAt: old?.createdAt || nowISO(),
    updatedAt: nowISO(),
  };
  if (old) {
    state.words = state.words.map((item) => item.id === old.id ? word : item);
  } else state.words.unshift(word);
  closeModal();
  saveState();
  render();
  toast(old ? "단어를 수정했어요." : "보관함에 단어를 추가했어요.");
}

// 폴더도 단어와 같은 방식으로 이름, 설명, 태그를 저장합니다.
function saveFolderForm(form) {
  const data = formData(form);
  const name = String(data.get("name") || "").trim();
  if (!name) {
    toast("폴더 이름을 입력해 주세요.", "error");
    return;
  }
  const id = form.dataset.id;
  const old = id ? getFolder(id) : null;
  const folder = {
    id: old?.id || makeId(),
    name,
    description: String(data.get("description") || "").trim(),
    tags: parseTags(data.get("tags")),
    createdAt: old?.createdAt || nowISO(),
    updatedAt: nowISO(),
  };
  if (old) {
    state.folders = state.folders.map((item) =>
      item.id === old.id ? folder : item
    );
  } else state.folders.push(folder);
  closeModal();
  saveState();
  render();
  toast(old ? "폴더를 수정했어요." : "폴더를 만들었어요.");
}

// 태그 이름은 단어와 폴더뿐 아니라 현재 열려 있는 필터에도 반영합니다.
function renameTag(oldTag, newTag) {
  const oldKey = tagKey(oldTag);
  const newClean = normalizeTag(newTag);
  const newKey = tagKey(newClean);
  if (!newKey) {
    toast("태그 이름을 입력해 주세요.", "error");
    return;
  }
  const replacements = new Map([[oldKey, newClean]]);
  for (const word of state.words) {
    word.tags = uniqueTags(
      word.tags.map((tag) => replacements.get(tagKey(tag)) || tag),
    );
  }
  for (const folder of state.folders) {
    folder.tags = uniqueTags(
      folder.tags.map((tag) => replacements.get(tagKey(tag)) || tag),
    );
  }
  if (tagKey(oldTag) === newKey) {
    for (const word of state.words) {
      if (word.tags.some((tag) => tagKey(tag) === newKey)) {
        word.updatedAt = nowISO();
      }
    }
    for (const folder of state.folders) {
      if (folder.tags.some((tag) => tagKey(tag) === newKey)) {
        folder.updatedAt = nowISO();
      }
    }
  }
  browser.tagNames = browser.tagNames.map((tag) =>
    tagKey(tag) === oldKey ? newClean : tag
  );
  picker.tagNames = picker.tagNames.map((tag) =>
    tagKey(tag) === oldKey ? newClean : tag
  );
  saveState();
  render();
  toast("사용 중인 모든 곳에서 태그 이름을 바꿨어요.");
}

async function deleteWord(id) {
  const word = getWord(id);
  if (
    !word ||
    !confirm(`“${word.name}” 단어를 삭제할까요? 모든 폴더에서도 제거됩니다.`)
  ) return;
  state.words = state.words.filter((item) => item.id !== id);
  await saveState();
  render();
  toast("단어를 삭제했어요.");
}

async function deleteFolder(id) {
  const folder = getFolder(id);
  if (
    !folder ||
    !confirm(
      `“${folder.name}” 폴더를 삭제할까요? 폴더 안의 단어는 보관함에 남습니다.`,
    )
  ) return;
  state.folders = state.folders.filter((item) => item.id !== id);
  state.words = state.words.map((word) => ({
    ...word,
    folderIds: word.folderIds.filter((folderId) => folderId !== id),
    updatedAt: word.folderIds.includes(id) ? nowISO() : word.updatedAt,
  }));
  picker.folderIds = picker.folderIds.filter((folderId) => folderId !== id);
  if (browser.folderId === id) browser.folderId = "all";
  await saveState();
  render();
  toast("폴더를 삭제했어요. 단어는 그대로 보관돼요.");
}

async function deleteTag(tag) {
  const stats = tagStats(tag);
  if (
    !confirm(
      `“${tag}” 태그를 단어 ${stats.words}개와 폴더 ${stats.folders}개에서 삭제할까요?`,
    )
  ) return;
  const key = tagKey(tag);
  for (const word of state.words) {
    word.tags = word.tags.filter((item) => tagKey(item) !== key);
  }
  for (const folder of state.folders) {
    folder.tags = folder.tags.filter((item) => tagKey(item) !== key);
  }
  browser.tagNames = browser.tagNames.filter((item) => tagKey(item) !== key);
  picker.tagNames = picker.tagNames.filter((item) => tagKey(item) !== key);
  await saveState();
  render();
  toast("사용 중인 모든 곳에서 태그를 삭제했어요.");
}

// 중복을 허용하지 않을 때는 Fisher–Yates 셔플 후 필요한 개수만 가져옵니다.
function drawWords() {
  const candidates = pickerCandidates();
  const quantity = Number(picker.quantity);
  if (!Number.isInteger(quantity) || quantity <= 0) {
    toast("1 이상의 정수를 입력해 주세요.", "error");
    return;
  }
  if (!candidates.length) {
    toast("이번 뽑기에서 선택할 수 있는 단어가 없어요.", "error");
    return;
  }
  if (!picker.allowDuplicates && quantity > candidates.length) {
    toast(`중복 없이 뽑을 수 있는 단어는 ${candidates.length}개예요.`, "error");
    return;
  }
  let selected;
  if (picker.allowDuplicates) {
    selected = Array.from(
      { length: quantity },
      () => candidates[Math.floor(Math.random() * candidates.length)],
    );
  } else {
    const shuffled = [...candidates];
    for (let index = shuffled.length - 1; index > 0; index--) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [shuffled[index], shuffled[swapIndex]] = [
        shuffled[swapIndex],
        shuffled[index],
      ];
    }
    selected = shuffled.slice(0, quantity);
  }
  picker.results = selected.map((word) => ({ ...word, tags: [...word.tags] }));
  render();
}

function resultText() {
  return (picker.results || []).map((word) => word.name).join("\n");
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
  toast("클립보드에 복사했어요.");
}

function download(name, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// 단어에 저장된 folderIds와 별도 관계 목록을 함께 내보내 다른 도구에서도 읽기 쉽습니다.
function exportData() {
  const payload = {
    app: "워드웰 랜덤 단어 뽑기",
    version: APP_VERSION,
    exportedAt: nowISO(),
    words: state.words,
    folders: state.folders,
    relationships: state.words.flatMap((word) =>
      folderIdsOf(word).map((folderId) => ({ wordId: word.id, folderId }))
    ),
  };
  download(
    `워드웰-백업-${new Date().toISOString().slice(0, 10)}.json`,
    JSON.stringify(payload, null, 2),
    "application/json",
  );
  toast("JSON 백업 파일을 준비했어요.");
}

// 가져오기 중 ID 충돌을 새 ID로 바꾸고, 관계는 가져온 폴더·단어 안에서 다시 연결합니다.
function importRecords(raw, strategy) {
  if (
    !raw || typeof raw !== "object" || !Array.isArray(raw.words) ||
    !Array.isArray(raw.folders)
  ) throw new Error("파일에 단어 목록과 폴더 목록이 있어야 합니다.");
  const replacing = strategy === "replace";
  const baseWords = replacing ? [] : [...state.words];
  const baseFolders = replacing ? [] : [...state.folders];
  const usedWordIds = new Set(baseWords.map((item) => item.id));
  const usedFolderIds = new Set(baseFolders.map((item) => item.id));
  const folderMap = new Map();
  let skipped = 0;
  let remapped = 0;
  const importedFolders = [];
  for (const folder of raw.folders) {
    if (!folder || typeof folder.name !== "string" || !folder.name.trim()) {
      skipped++;
      continue;
    }
    const oldId = typeof folder.id === "string" ? folder.id : "";
    let id = oldId && !usedFolderIds.has(oldId) ? oldId : makeId();
    if (id !== oldId) remapped++;
    usedFolderIds.add(id);
    if (oldId && !folderMap.has(oldId)) folderMap.set(oldId, id);
    const timestamp = nowISO();
    importedFolders.push({
      id,
      name: folder.name.trim(),
      description: typeof folder.description === "string"
        ? folder.description
        : "",
      tags: uniqueTags(folder.tags),
      createdAt: folder.createdAt || timestamp,
      updatedAt: folder.updatedAt || timestamp,
    });
  }

  // 단어를 처리할 때 폴더 ID를 새 ID로 바꿀 수 있도록 먼저 폴더를 읽습니다.
  const importedWords = [];
  for (const word of raw.words) {
    if (!word || typeof word.name !== "string" || !word.name.trim()) {
      skipped++;
      continue;
    }
    const oldId = typeof word.id === "string" ? word.id : "";
    let id = oldId && !usedWordIds.has(oldId) ? oldId : makeId();
    if (id !== oldId) remapped++;
    usedWordIds.add(id);
    const timestamp = nowISO();
    importedWords.push({
      id,
      name: word.name.trim(),
      description: typeof word.description === "string" ? word.description : "",
      tags: uniqueTags(word.tags),
      folderIds: (Array.isArray(word.folderIds) ? word.folderIds : []).map((
        folderId,
      ) => folderMap.get(String(folderId))).filter(Boolean),
      createdAt: word.createdAt || timestamp,
      updatedAt: word.updatedAt || timestamp,
    });
  }
  if (Array.isArray(raw.relationships)) {
    const wordMap = new Map();
    const importedWordInputs = raw.words.filter((word) =>
      word && typeof word.name === "string" && word.name.trim()
    );
    importedWordInputs.forEach((word, index) => {
      if (word.id && !wordMap.has(word.id)) {
        wordMap.set(word.id, importedWords[index]?.id);
      }
    });
    for (const relation of raw.relationships) {
      const wordId = wordMap.get(String(relation?.wordId));
      const folderId = folderMap.get(String(relation?.folderId));
      const word = importedWords.find((item) => item.id === wordId);
      if (word && folderId && !word.folderIds.includes(folderId)) {
        word.folderIds.push(folderId);
      }
    }
  }

  // 가져온 데이터에 실제로 존재하지 않는 폴더 연결은 저장 전에 정리합니다.
  const validFolderIds = new Set(
    [...baseFolders, ...importedFolders].map((folder) => folder.id),
  );
  for (const word of [...baseWords, ...importedWords]) {
    word.folderIds = [
      ...new Set(word.folderIds.filter((id) => validFolderIds.has(id))),
    ];
  }
  state = {
    ...state,
    version: APP_VERSION,
    words: [...baseWords, ...importedWords],
    folders: [...baseFolders, ...importedFolders],
    settings: { ...state.settings },
  };
  return {
    words: importedWords.length,
    folders: importedFolders.length,
    skipped,
    remapped,
  };
}

async function handleImport(file) {
  if (!file) return;
  try {
    const raw = JSON.parse(await file.text());
    const strategy = $("#import-strategy")?.value || "merge";
    if (!raw || !Array.isArray(raw.words) || !Array.isArray(raw.folders)) {
      throw new Error("파일에 단어 목록과 폴더 목록이 있어야 합니다.");
    }
    if (
      strategy === "replace" &&
      !confirm(
        `현재 보관함을 이 파일의 단어 ${raw.words.length}개와 폴더 ${raw.folders.length}개로 바꿀까요? 기존 데이터는 삭제됩니다.`,
      )
    ) return;
    const summary = importRecords(raw, strategy);
    if (strategy === "replace") {
      browser.folderId = "all";
      browser.tagNames = [];
      picker.folderIds = [];
      picker.tagNames = [];
    }
    await saveState();
    render();
    const notes = [
      summary.remapped ? `ID ${summary.remapped}개를 새로 지정함` : "",
      summary.skipped ? `잘못된 항목 ${summary.skipped}개를 건너뜀` : "",
    ].filter(Boolean).join(" · ");
    toast(
      `단어 ${summary.words}개와 폴더 ${summary.folders}개를 가져왔어요${
        notes ? ` (${notes})` : ""
      }.`,
    );
  } catch (error) {
    const message = error instanceof SyntaxError
      ? "JSON 형식이 올바르지 않아요."
      : error.message || "파일을 읽을 수 없어요.";
    toast(`가져오기에 실패했어요: ${message}`, "error");
  } finally {
    $("#import-file").value = "";
  }
}

function navigate(view) {
  if (!titles[view]) return;
  if (location.hash !== `#${view}`) location.hash = view;
  else {
    currentView = view;
    render();
  }
  $("#sidebar").classList.remove("open");
  $("#menu-toggle").setAttribute("aria-expanded", "false");
}

// 화면이 다시 그려져도 동작하도록 버튼 이벤트는 문서에서 위임해 처리합니다.
document.addEventListener("click", async (event) => {
  const navLink = event.target.closest(".nav-link[data-view]");
  if (navLink) {
    $("#sidebar").classList.remove("open");
    $("#menu-toggle").setAttribute("aria-expanded", "false");
  }
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  const id = target.dataset.id;
  if (action === "new-word") openModal("word");
  else if (action === "new-folder") openModal("folder");
  else if (action === "new-folder-from-word") {
    const form = $("form[data-form=word]"),
      name = $("#word-name")?.value,
      description = $("#word-description")?.value,
      tags = $("#word-tags")?.value,
      selected = [...form.querySelectorAll('input[name="folderIds"]:checked')]
        .map((item) => item.value);
    openModal("folder");
    setTimeout(() => {
      const folderForm = $("form[data-form=folder]");
      folderForm.dataset.returnToWord = "true";
      folderForm.dataset.wordId = form.dataset.id || "";
      folderForm.dataset.wordName = name || "";
      folderForm.dataset.wordDescription = description || "";
      folderForm.dataset.wordTags = tags || "";
      folderForm.dataset.selectedFolders = selected.join(",");
    }, 0);
  } else if (action === "edit-word") openModal("word", id);
  else if (action === "edit-folder") openModal("folder", id);
  else if (action === "delete-word") await deleteWord(id);
  else if (action === "delete-folder") await deleteFolder(id);
  else if (action === "rename-tag") openModal("tag", target.dataset.tag);
  else if (action === "delete-tag") await deleteTag(target.dataset.tag);
  else if (action === "close-modal") closeModal();
  else if (action === "backdrop-close" && event.target === target) closeModal();
  else if (action === "open-folder") {
    browser.folderId = id;
    navigate("words");
  } else if (action === "filter-tag") {
    browser.tagNames = [target.dataset.tag];
    browser.tagLogic = "and";
    browser.folderId = "all";
    navigate("words");
  } else if (action === "go-picker") navigate("picker");
  else if (action === "open-settings") navigate("settings");
  else if (action === "picker-preset") {
    picker.quantity = target.dataset.value;
    render();
  } else if (action === "picker-folder-logic") {
    picker.folderLogic = target.dataset.value;
    render();
  } else if (action === "picker-tag-logic") {
    picker.tagLogic = target.dataset.value;
    render();
  } else if (action === "draw") drawWords();
  else if (action === "clear-results") {
    picker.results = null;
    render();
  } else if (action === "copy-results" && picker.results?.length) {
    await copyText(resultText());
  } else if (action === "export-results" && picker.results?.length) {
    download(
      `워드웰-뽑은-단어-${new Date().toISOString().slice(0, 10)}.txt`,
      resultText(),
      "text/plain;charset=utf-8",
    );
    toast("뽑은 단어를 파일로 저장했어요.");
  } else if (action === "export-data") exportData();
  else if (action === "import-data") $("#import-file").click();
  else if (action === "clear-library") {
    if (
      !confirm(
        "이 브라우저에 저장된 모든 단어, 폴더, 태그를 삭제할까요? 필요할 수 있다면 먼저 백업을 내보내세요.",
      )
    ) return;
    state.words = [];
    state.folders = [];
    browser = { ...browser, folderId: "all", tagNames: [] };
    await saveState();
    render();
    toast("보관함을 비웠어요.");
  } else if (action === "clear-browser-tags") {
    browser.tagNames = [];
    render();
  } else if (action === "remove-browser-tag") {
    browser.tagNames = browser.tagNames.filter((tag) =>
      tagKey(tag) !== tagKey(target.dataset.tag)
    );
    render();
  } else if (action === "browser-tag-logic") {
    browser.tagLogic = target.dataset.value;
    tagFilterOpen = true;
    render();
  }
});

document.addEventListener("change", (event) => {
  // 선택 상자는 값이 확정된 뒤 필터나 설정에 반영합니다.
  const target = event.target;
  if (target.id === "word-folder-filter") {
    browser.folderId = target.value;
    render();
  } else if (target.id === "word-sort") {
    browser.sort = target.value;
    render();
  } else if (target.matches("[data-browser-tag]")) {
    const tag = target.dataset.browserTag;
    browser.tagNames = target.checked
      ? [
        ...new Map(
          [...browser.tagNames, tag].map((item) => [tagKey(item), item]),
        ).values(),
      ]
      : browser.tagNames.filter((item) => tagKey(item) !== tagKey(tag));
    tagFilterOpen = true;
    render();
  } else if (target.id === "picker-mode") {
    picker.mode = target.value;
    render();
  } else if (target.matches("[data-picker-folder]")) {
    const id = target.dataset.pickerFolder;
    picker.folderIds = target.checked
      ? [...new Set([...picker.folderIds, id])]
      : picker.folderIds.filter((item) => item !== id);
    render();
  } else if (target.matches("[data-picker-tag]")) {
    const tag = target.dataset.pickerTag;
    picker.tagNames = target.checked
      ? [
        ...new Map(
          [...picker.tagNames, tag].map((item) => [tagKey(item), item]),
        ).values(),
      ]
      : picker.tagNames.filter((item) => tagKey(item) !== tagKey(tag));
    render();
  } else if (target.id === "picker-duplicates") {
    picker.allowDuplicates = target.checked;
    render();
  } else if (target.id === "import-file") handleImport(target.files?.[0]);
  else if (target.id === "theme-toggle") {
    state.settings.theme = target.checked ? "dark" : "light";
    saveState();
    render();
  }
});

document.addEventListener("input", (event) => {
  // 다시 그린 검색창에서 입력 위치를 유지해 타이핑이 끊기지 않게 합니다.
  const target = event.target;
  if (target.id === "word-search") {
    browser.search = target.value;
    const start = target.selectionStart;
    const end = target.selectionEnd;
    render();
    const input = $("#word-search");
    input?.focus();
    input?.setSelectionRange(start, end);
  } else if (target.id === "tag-search") {
    tagSearch = target.value;
    const start = target.selectionStart;
    const end = target.selectionEnd;
    render();
    const input = $("#tag-search");
    input?.focus();
    input?.setSelectionRange(start, end);
  } else if (target.id === "picker-quantity") {
    picker.quantity = target.value;
    const start = target.selectionStart;
    const end = target.selectionEnd;
    render();
    const input = $("#picker-quantity");
    input?.focus();
    if (input && start !== null) input.setSelectionRange(start, end);
  }
});

document.addEventListener("submit", (event) => {
  // 폼 제출은 새로고침하지 않고 필요한 저장 함수로 전달합니다.
  const form = event.target;
  if (!form.matches("[data-form]")) return;
  event.preventDefault();
  if (form.dataset.form === "word") saveWordForm(form);
  else if (form.dataset.form === "folder") {
    const returnToWord = form.dataset.returnToWord === "true";
    const wordDraft = returnToWord
      ? {
        id: form.dataset.wordId || null,
        name: form.dataset.wordName,
        description: form.dataset.wordDescription,
        tags: form.dataset.wordTags,
        folders: form.dataset.selectedFolders?.split(",").filter(Boolean) || [],
      }
      : null;
    const data = formData(form);
    const name = String(data.get("name") || "").trim();
    if (!name) {
      toast("폴더 이름을 입력해 주세요.", "error");
      return;
    }
    const created = {
      id: makeId(),
      name,
      description: String(data.get("description") || "").trim(),
      tags: parseTags(data.get("tags")),
      createdAt: nowISO(),
      updatedAt: nowISO(),
    };
    if (returnToWord) {
      const selected = [...wordDraft.folders, created.id];
      closeModal();
      openModal("word", wordDraft.id);
      setTimeout(() => {
        const wordForm = $("form[data-form=word]");
        if (!wordForm) return;
        $("#word-name").value = wordDraft.name;
        $("#word-description").value = wordDraft.description;
        $("#word-tags").value = wordDraft.tags;
        const checks = wordForm.querySelector(".folder-checks");
        checks.innerHTML = state.folders.map((folder) =>
          `<label class="checkline"><input type="checkbox" name="folderIds" value="${
            escapeHTML(folder.id)
          }" ${selected.includes(folder.id) ? "checked" : ""} /><span>${
            escapeHTML(folder.name)
          }</span></label>`
        ).join("");
      }, 0);
    } else saveFolderForm(form);
    if (returnToWord) {
      state.folders.push(created);
      saveState();
      render();
    }
  } else if (form.dataset.form === "tag") {
    const name = String(new FormData(form).get("name") || "");
    renameTag(form.dataset.tag, name);
    closeModal();
  }
});

window.addEventListener("hashchange", () => {
  currentView = location.hash.slice(1) || "dashboard";
  render();
});

$("#menu-toggle").addEventListener("click", () => {
  const open = $("#sidebar").classList.toggle("open");
  $("#menu-toggle").setAttribute("aria-expanded", String(open));
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeModal();
});

async function init() {
  await loadState();
  currentView = location.hash.slice(1) || "dashboard";
  if (!location.hash) history.replaceState(null, "", "#dashboard");
  render();
}

init();

