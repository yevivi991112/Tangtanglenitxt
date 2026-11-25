/**
 * ui.js — 浮动面板：主视图 + 内置设置视图（⚙️切换）+ 历史记忆库管理 + 注入预览弹窗
 *
 * 设计不变量：
 * 1. 所有设置控件集中在浮动面板内，避免与外部 settings.html 产生 DOM ID 冲突。
 * 2. 「全选当前页」仅作用于当前所在 Tab 的可见条目，防止误删其他分区（记忆库/遗弃区）的数据。
 * 3. 编辑楼层序号重新插入时，必须完整保留原条目的 pinned / pinnedOrder / sourceDeleted 状态。
 * 4. 新增记忆采用临时编辑表单，仅点击「保存」时写入数据库，点「取消」不会残留空白记录。
 * 5. 置顶区块与记忆库区块均支持折叠收起；「置顶排序」控件仅在置顶 Tab 显示。
 */

import {
    loadMemories, saveMemories, addMemory, addMemoryAtFloor, updateMemory, deleteMemory, deleteMemories,
    mergeMemories, getPinnedSorted, getRecentUnpinned, getAbandoned,
    pinMemory, unpinMemory, clearAbandoned, restoreOneToChat,
    movePinnedTop, movePinnedBottom, movePinnedUp, movePinnedDown,
    saveDbSnapshot, saveChatSnapshot, isBlockAlreadyStored,
    getCurrentChatId, bindCurrentChatToVault, mergeVaultInto,
} from './memory.js';
import { listAllVaults, deleteVault } from './storage.js';
import { updateInjection, buildPromptText, resolvePosition } from './inject.js';
import { filterMemories } from './search.js';

const $ = jQuery;

let _vaultId      = null;
let _settings     = {};
let _onSave       = null;
let _onVaultBound = null;

export function setUiChatId(vaultId)         { _vaultId = vaultId; }
export function setUiSettings(s)             { _settings = s; }
export function setUiSaveCallback(fn)        { _onSave = fn; }
export function setUiVaultBoundCallback(fn)  { _onVaultBound = fn; }

function esc(t) { return $('<div>').text(t || '').html(); }
function triggerSave() { if (_onSave) _onSave(); }

// ─── 状态 ─────────────────────────────────────────────────────────────────
let _selectedIds     = new Set();
let _expandedIds     = new Set();
let _pinnedSort      = 'order';
let _searchQuery     = '';
let _view            = 'main'; // 'main' | 'settings'
let _activeTab       = 'pinned'; // 'pinned' | 'recent' | 'abandoned'
let _pinnedCollapsed = false;
let _vaultCollapsed  = true;
let _highlightIds    = new Set();
let _vaultSearch     = '';
let _previewVaultId  = null;

// ─── HTML ─────────────────────────────────────────────────────────────────
const PANEL_HTML = `
<div id="mv-panel" class="mv-panel">
  <!-- 头部 -->
  <div class="mv-header" id="mv-header">
    <span class="mv-title">🍬 糖的记忆管理</span>
    <div class="mv-header-actions">
      <button class="mv-hbtn" id="mv-preview-inject-btn" title="预览实际注入给 AI 的文本">👁️</button>
      <button class="mv-hbtn" id="mv-vaults-btn" title="历史记忆库 / 重新绑定">🗂️</button>
      <button class="mv-hbtn" id="mv-settings-btn" title="设置">⚙️</button>
      <button class="mv-hbtn" id="mv-close-btn" title="关闭">✕</button>
    </div>
  </div>

  <!-- 主视图 -->
  <div id="mv-main-view" class="mv-flex-col">
    <!-- 总开关关闭提示条 -->
    <div id="mv-disabled-banner" class="mv-disabled-banner" style="display:none;">
      <span>⏸️ 插件总开关已关闭（当前不注入记忆）</span>
      <button class="mv-tbtn mv-banner-btn" id="mv-quick-enable-btn">立即开启</button>
    </div>

    <!-- Tab 切换栏 -->
    <div class="mv-tab-bar">
      <button class="mv-tab mv-tab-active" data-tab="pinned" id="mv-tab-pinned">📌置顶</button>
      <button class="mv-tab" data-tab="recent" id="mv-tab-recent">📋最近</button>
      <button class="mv-tab mv-tab-trash" data-tab="abandoned" id="mv-tab-abandoned">🗑️</button>
    </div>

    <div class="mv-toolbar">
      <label class="mv-label" id="mv-pin-sort-wrap" style="margin-left:0;">置顶排序:
        <select id="mv-pin-sort" class="mv-select">
          <option value="order">自定义序号</option>
          <option value="time_asc">时间↑</option>
          <option value="time_desc">时间↓</option>
          <option value="imp_desc">重要度↓</option>
          <option value="imp_asc">重要度↑</option>
        </select>
      </label>
      <div class="mv-search-wrap">
        <input type="text" id="mv-search-input" class="mv-input mv-search-input" placeholder="搜索关键词/标签/重要度…">
        <button class="mv-search-clear" id="mv-search-clear" title="清空搜索" style="display:none;">×</button>
      </div>
      <button class="mv-tbtn" id="mv-add-btn">＋新增</button>
    </div>

    <div class="mv-multibar" id="mv-multibar" style="display:none;">
      <button class="mv-tbtn" id="mv-sel-all">全选当前页</button>
      <button class="mv-tbtn" id="mv-sel-none">取消</button>
      <button class="mv-tbtn mv-pin-batch-btn" id="mv-batch-pin-btn">📌置顶</button>
      <button class="mv-tbtn" id="mv-batch-unpin-btn">取消置顶</button>
      <button class="mv-tbtn mv-merge-btn" id="mv-merge-btn" style="display:none;">🔗合并</button>
      <button class="mv-tbtn mv-danger-btn" id="mv-del-sel-btn" style="display:none;">🗑删除</button>
      <span id="mv-sel-count" style="font-size:11px;color:#8B7355;margin-left:4px;"></span>
    </div>

    <div class="mv-body" id="mv-body"></div>

    <div class="mv-footer">
      <div class="mv-status" id="mv-status">就绪</div>
      <div class="mv-pager">
        <button class="mv-page-btn" id="mv-pgup" title="上翻">⬆</button>
        <button class="mv-page-btn" id="mv-pgdn" title="下翻">⬇</button>
      </div>
    </div>
  </div>

  <!-- 设置视图 -->
  <div id="mv-settings-view" class="mv-settings-view" style="display:none;">

    <div class="mv-set-section">
      <div class="mv-set-title">总开关</div>
      <label class="mv-set-label">
        <input type="checkbox" id="mv-set-enabled"> 启用糖🍬的记忆管理
      </label>
    </div>

    <div class="mv-set-section">
      <div class="mv-set-title">存储方案</div>
      <select id="mv-set-backend" class="mv-select" style="width:100%;margin-bottom:6px;">
        <option value="ext">后端保存（推荐，跟随ST数据）</option>
        <option value="local">浏览器保存（备选，清缓存丢失）</option>
      </select>
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
        <button class="mv-tbtn" id="mv-test-ext">测试①</button>
        <span id="mv-test-ext-result" class="mv-test-result"></span>
        <button class="mv-tbtn" id="mv-test-local">测试②</button>
        <span id="mv-test-local-result" class="mv-test-result"></span>
      </div>
    </div>

    <div class="mv-set-section">
      <div class="mv-set-title">注入设置</div>
      <div style="margin-bottom:6px;">
        <label class="mv-set-label" style="margin-bottom:4px;">注入位置:</label>
        <select id="mv-set-position" class="mv-select" style="width:100%;">
          <option value="in_chat">注入历史聊天（聊天记录最前方）</option>
          <option value="before_prompt">before_prompt（主提示词之前）</option>
          <option value="after_char">after_char（主提示词 / 角色卡之后）</option>
          <option value="authors_note">authors_note（聊天内深度 4）</option>
        </select>
      </div>
      <label class="mv-set-label" style="margin-bottom:4px;">
        <input type="checkbox" id="mv-set-pinned-first"> 置顶区块在前
      </label>
      <div style="display:flex;align-items:center;gap:6px;margin-top:4px;">
        <label class="mv-set-label">最近N条:
          <input type="number" id="mv-set-recent-n" class="mv-num-input" min="0" max="999">
        </label>
        <span style="font-size:11px;color:#8B7355;">(0=全发)</span>
      </div>
      <div style="display:flex;align-items:center;gap:6px;margin-top:4px;">
        <label class="mv-set-label">注入格式:</label>
        <select id="mv-set-inject-format" class="mv-select" style="flex:1;">
          <option value="lenitxt">带 &lt;Lenitxt&gt; 标签</option>
          <option value="plain">纯文本（日期|标签|内容）</option>
          <option value="lenitxt_single">整合记忆（仅一次 Lenitxt 包裹）</option>
        </select>
      </div>
    </div>

    <div class="mv-set-section">
      <div class="mv-set-title">默认重要度</div>
      <div style="display:flex;align-items:center;gap:6px;">
        <input type="number" id="mv-set-def-imp" class="mv-num-input" min="0" max="1" step="0.1">
        <span style="font-size:11px;color:#8B7355;">（0~1，步进0.1）</span>
      </div>
    </div>

    <div class="mv-set-section">
      <div class="mv-set-title">预设标签（新增/编辑记忆时可一键点选）</div>
      <div id="mv-preset-tags-box" style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:6px;min-height:20px;"></div>
      <div style="display:flex;gap:6px;">
        <input type="text" id="mv-preset-tag-input" class="mv-input" placeholder="新标签…" style="flex:1;">
        <button class="mv-tbtn" id="mv-preset-tag-add">添加</button>
      </div>
    </div>

    <div class="mv-set-section">
      <div class="mv-set-title">导出 / 导入</div>
      <div style="display:flex;flex-direction:column;gap:6px;">
        <button class="mv-tbtn" id="mv-export-all" style="width:100%;">全量导出 JSON</button>
        <button class="mv-tbtn" id="mv-export-chat" style="width:100%;">当前聊天导出</button>
        <button class="mv-tbtn" id="mv-import-btn" style="width:100%;">导入 JSON</button>
        <input type="file" id="mv-import-file" accept=".json" style="display:none;">
      </div>
    </div>

    <div class="mv-set-section">
      <div class="mv-set-title">操作工具</div>
      <div style="display:flex;flex-direction:column;gap:6px;">
        <button class="mv-tbtn" id="mv-open-vaults-btn" style="width:100%;">🗂️ 历史记忆库管理 / 重新绑定</button>
        <button class="mv-tbtn" id="mv-scan-chat-btn" style="width:100%;">🔍 手动扫描 &lt;Lenitxt&gt; 块</button>
        <button class="mv-tbtn" id="mv-restore-all-btn" style="width:100%;">↩ 一键还原所有记忆到来源楼层</button>
        <button class="mv-tbtn mv-danger-btn" id="mv-restore-chat-snap-btn" style="width:100%;">⚠️ 恢复聊天快照</button>
        <button class="mv-tbtn mv-danger-btn" id="mv-restore-db-snap-btn" style="width:100%;">⚠️ 恢复记忆库快照</button>
      </div>
    </div>

    <div class="mv-set-section">
      <div class="mv-set-title">还原行为</div>
      <label class="mv-set-label">
        <input type="checkbox" id="mv-set-auto-clean-restore"> 还原后自动清理遗弃区备份
      </label>
      <div style="font-size:11px;color:#8B7355;margin-top:2px;">
        关闭时还原的记忆会保留在遗弃区作为备份，需手动清理
      </div>
    </div>

    <div class="mv-set-section">
      <div class="mv-set-title">聊天切换复制记忆</div>
      <select id="mv-fp-chat-switch-copy" class="mv-select" style="width:100%;">
        <option value="never">从不复制</option>
        <option value="empty_only">仅新聊天记忆为空时询问</option>
        <option value="always">始终询问（保险机制）</option>
      </select>
      <div style="font-size:11px;color:#8B7355;margin-top:4px;">
        注：酒馆内改名会自动沿用原库；创建分支会自动复制独立库。此项仅控制普通切换到全新空白聊天时是否询问。
      </div>
    </div>

    <div class="mv-set-section">
      <div class="mv-set-title">自动捕获</div>
      <label class="mv-set-label" style="margin-bottom:6px;">
        <input type="checkbox" id="mv-set-scan-exclude-recent-n"> 手动扫描区块时同时排除最近N楼
      </label>
      <label class="mv-set-label" style="margin-bottom:6px;">
        <input type="checkbox" id="mv-set-auto-capture"> 启用自动捕获记忆
      </label>
      <div style="font-size:11px;color:#B71C1C;margin-bottom:6px;">
        ⚠️ 开启后，超出 N 楼的消息中 &lt;Lenitxt&gt; 块将被自动入库并从聊天记录中删除
      </div>
      <div style="display:flex;align-items:center;gap:6px;">
        <label class="mv-set-label">最近N楼不捕获:</label>
        <input type="number" id="mv-set-auto-capture-n" class="mv-num-input" min="0" max="999" value="6">
      </div>
    </div>

    <div style="height:12px;"></div>
    <button class="mv-tbtn mv-save-settings-btn" id="mv-save-settings-btn" style="width:100%;background:#C8A250;color:white;border-color:#B8956A;">💾 储存应用</button>
    <div style="height:12px;"></div>
  </div>
</div>

<!-- 合并弹窗 -->
<div id="mv-merge-modal" class="mv-modal">
  <div class="mv-modal-box">
    <div class="mv-modal-title">🔗 合并记忆（可编辑合并后内容）</div>
    <textarea id="mv-merge-content" class="mv-textarea" rows="6"></textarea>
    <div class="mv-modal-actions">
      <button class="mv-btn mv-btn-cancel" id="mv-merge-cancel">取消</button>
      <button class="mv-btn mv-btn-primary" id="mv-merge-confirm">确认合并</button>
    </div>
  </div>
</div>

<!-- 实际注入预览弹窗 -->
<div id="mv-inject-preview-modal" class="mv-modal">
  <div class="mv-modal-box mv-vaults-modal-box">
    <div class="mv-modal-title">👁️ 实际注入给 AI 的文本预览</div>
    <div id="mv-inject-preview-meta" class="mv-vaults-current"></div>
    <textarea id="mv-inject-preview-text" class="mv-textarea mv-inject-preview-ta" readonly rows="10"></textarea>
    <div class="mv-modal-actions">
      <button class="mv-btn mv-btn-copy" id="mv-inject-preview-copy">📋 复制文本</button>
      <button class="mv-btn mv-btn-cancel" id="mv-inject-preview-close">关闭</button>
    </div>
  </div>
</div>

<!-- 历史记忆库管理 / 重新绑定弹窗 -->
<div id="mv-vaults-modal" class="mv-modal">
  <div class="mv-modal-box mv-vaults-modal-box">
    <div class="mv-modal-title">🗂️ 历史记忆库管理 / 重新绑定</div>
    <div id="mv-vaults-current-info" class="mv-vaults-current"></div>
    <input type="text" id="mv-vaults-search" class="mv-input" placeholder="按聊天名、角色名或记忆内容搜索…">
    <div id="mv-vaults-list" class="mv-vaults-list"></div>
    <div class="mv-modal-actions">
      <button class="mv-btn mv-btn-cancel" id="mv-vaults-close">关闭</button>
    </div>
  </div>
</div>

<!-- 扫描弹窗（保留 DOM 兼容） -->
<div id="mv-scan-modal" class="mv-modal">
  <div class="mv-modal-box">
    <div class="mv-modal-title">🔍 扫描聊天中的 &lt;Lenitxt&gt; 块</div>
    <div id="mv-scan-list" class="mv-scan-list"></div>
    <div class="mv-modal-actions">
      <button class="mv-btn mv-btn-cancel" id="mv-scan-cancel">取消</button>
      <button class="mv-btn mv-btn-primary" id="mv-scan-confirm">导入选中</button>
    </div>
  </div>
</div>
`;

// ─── 初始化 ───────────────────────────────────────────────────────────────
export function initPanel() {
    if ($('#mv-panel').length) return;
    $('body').append(PANEL_HTML);
    bindPanelEvents();
}

export function showPanel() { $('#mv-panel').addClass('mv-active'); renderAll(); }
export function hidePanel() { $('#mv-panel').removeClass('mv-active'); }
export function togglePanel() {
    if ($('#mv-panel').hasClass('mv-active')) hidePanel(); else showPanel();
}

export function setStatus(t) { $('#mv-status').text(t); }

function switchView(v) {
    _view = v;
    if (v === 'settings') {
        $('#mv-main-view').hide();
        $('#mv-settings-view').show();
        $('#mv-settings-btn').text('◀');
    } else {
        $('#mv-settings-view').hide();
        $('#mv-main-view').show();
        $('#mv-settings-btn').text('⚙️');
        renderAll();
    }
}

// ─── 预设标签选择器组件（用于新增/编辑框） ────────────────────────────────
function buildPresetTagsPicker($tagsInput) {
    const presets = _settings.presetTags || [];
    if (!presets.length) return null;

    const $wrap = $('<div class="mv-preset-picker">');
    $wrap.append('<span class="mv-preset-picker-label">预设标签:</span>');

    const getCurrentTags = () => $tagsInput.val().split(',').map(t => t.trim()).filter(Boolean);

    const syncButtons = () => {
        const cur = new Set(getCurrentTags());
        $wrap.find('.mv-preset-pick').each(function() {
            const tag = $(this).data('tag');
            $(this).toggleClass('mv-preset-pick-active', cur.has(tag));
        });
    };

    presets.forEach(tag => {
        const $btn = $(`<button type="button" class="mv-preset-pick">#${esc(tag)}</button>`).data('tag', tag);
        $btn.on('click', () => {
            const cur = getCurrentTags();
            const idx = cur.indexOf(tag);
            if (idx === -1) cur.push(tag);
            else cur.splice(idx, 1);
            $tagsInput.val(cur.join(', '));
            syncButtons();
        });
        $wrap.append($btn);
    });

    $tagsInput.on('input', syncButtons);
    syncButtons();
    return $wrap;
}

// ─── 获取当前 Tab 展示的条目列表（用于「全选当前页」） ────────────────────
function getCurrentTabVisibleIds() {
    if (!_vaultId) return [];
    let list = loadMemories(_vaultId);
    if (_searchQuery.trim()) list = filterMemories(list, _searchQuery, []);
    if (_activeTab === 'pinned') {
        return getPinnedSorted(list).map(e => e.id);
    }
    if (_activeTab === 'recent') {
        const n = _settings.recentN ?? 5;
        const unpinned = getRecentUnpinned(list);
        const send = n === 0 ? unpinned : unpinned.slice(Math.max(0, unpinned.length - n));
        return send.map(e => e.id);
    }
    if (_activeTab === 'abandoned') {
        return getAbandoned(list).map(e => e.id);
    }
    return [];
}

// ─── 更新 Tab 角标 & 工具栏状态 ───────────────────────────────────────────
function syncHeaderAndTabs(rawList) {
    // 总开关关闭提示条
    $('#mv-disabled-banner').toggle(_settings.enabled === false);

    // 置顶排序仅在置顶 Tab 显示
    $('#mv-pin-sort-wrap').toggle(_activeTab === 'pinned');

    // 搜索清空按钮
    $('#mv-search-clear').toggle(_searchQuery.length > 0);

    // Tab 数量角标
    const pinnedCount = getPinnedSorted(rawList).length;
    const n = _settings.recentN ?? 5;
    const unpinned = getRecentUnpinned(rawList);
    const recentCount = n === 0 ? unpinned.length : Math.min(unpinned.length, n);
    const abandonedCount = getAbandoned(rawList).length;

    $('#mv-tab-pinned').text(pinnedCount ? `📌置顶(${pinnedCount})` : '📌置顶');
    $('#mv-tab-recent').text(recentCount ? `📋最近(${recentCount})` : '📋最近');
    $('#mv-tab-abandoned').text(abandonedCount ? `🗑️(${abandonedCount})` : '🗑️');
}

// ─── 完整渲染 ─────────────────────────────────────────────────────────────
export function renderAll() {
    if (_view !== 'main') return;
    const $body = $('#mv-body');

    if (!_vaultId) {
        syncHeaderAndTabs([]);
        $body.empty().append('<div class="mv-empty-hint">当前未打开聊天，请先进入一个角色或群聊窗口</div>');
        syncMultibar();
        return;
    }

    const rawList = loadMemories(_vaultId);
    syncHeaderAndTabs(rawList);

    let list = rawList;
    if (_searchQuery.trim()) list = filterMemories(list, _searchQuery, []);
    const scrollPos = $body.scrollTop();
    const tabScrollPos = $body.find('.mv-tab-content').scrollTop() || 0;
    $body.empty();

    // Tab 内容区（上半区）
    const $tabContent = $('<div class="mv-tab-content">');
    if (_activeTab === 'pinned') {
        $tabContent.append(buildPinnedSection(list));
    } else if (_activeTab === 'recent') {
        $tabContent.append(buildRecentSection(list));
    } else if (_activeTab === 'abandoned') {
        $tabContent.append(buildAbandonedSection(list));
    }
    $body.append($tabContent);

    // 记忆库区块（始终在 Tab 内容下方，可折叠）
    $body.append(buildVaultSection(list));

    syncMultibar();
    $body.scrollTop(scrollPos);
    $body.find('.mv-tab-content').scrollTop(tabScrollPos);
}

// ─── 置顶区块（支持一键收起/展开） ────────────────────────────────────────
function buildPinnedSection(list) {
    let pinned = getPinnedSorted(list);
    if (_pinnedSort === 'time_asc')  pinned = [...pinned].sort((a,b) => (a.timestamp||0) - (b.timestamp||0));
    if (_pinnedSort === 'time_desc') pinned = [...pinned].sort((a,b) => (b.timestamp||0) - (a.timestamp||0));
    if (_pinnedSort === 'imp_desc')  pinned = [...pinned].sort((a,b) => (b.importance||0) - (a.importance||0));
    if (_pinnedSort === 'imp_asc')   pinned = [...pinned].sort((a,b) => (a.importance||0) - (b.importance||0));

    const $sec = $('<div class="mv-section">');
    const arrow = _pinnedCollapsed ? '▶' : '▼';
    const toggleLabel = _pinnedCollapsed ? '展开' : '收起';
    const $title = $(`
      <div class="mv-sec-title mv-sec-collapsible" title="点击收起或展开置顶区块">
        <span class="mv-vault-arrow">${arrow}</span>
        <span>📌 置顶区块 (${pinned.length})</span>
        <span class="mv-toggle-arrow">${toggleLabel}</span>
      </div>
    `);
    $title.on('click', () => {
        _pinnedCollapsed = !_pinnedCollapsed;
        renderAll();
    });
    $sec.append($title);

    if (!_pinnedCollapsed) {
        if (!pinned.length) {
            const hint = _searchQuery.trim()
                ? `未找到包含「${esc(_searchQuery.trim())}」的置顶记忆`
                : '无置顶记忆';
            $sec.append(`<div class="mv-empty-hint">${hint}</div>`);
        } else {
            pinned.forEach((e, i) => $sec.append(buildItem(e, { showPinOrder: true, isFirst: i===0, isLast: i===pinned.length-1, section:'pinned' })));
        }
    }
    return $sec;
}

// ─── 最近N条区块 ──────────────────────────────────────────────────────────
function buildRecentSection(list) {
    const n        = _settings.recentN ?? 5;
    const unpinned = getRecentUnpinned(list);
    const send     = n === 0 ? unpinned : unpinned.slice(Math.max(0, unpinned.length - n));

    const $sec = $('<div class="mv-section">');
    $sec.append(`<div class="mv-sec-title">📋 最近记忆 (${send.length})</div>`);

    send.forEach(e => $sec.append(buildItem(e, { section:'recent' })));

    if (!unpinned.length) {
        const hint = _searchQuery.trim()
            ? `未找到包含「${esc(_searchQuery.trim())}」的记忆（点搜索框右侧 × 清空）`
            : '无记忆，可手动新增、扫描聊天，或点右上角 🗂️ 找回历史记忆库';
        $sec.append(`<div class="mv-empty-hint">${hint}</div>`);
    }
    return $sec;
}

// ─── 遗弃区块 ─────────────────────────────────────────────────────────────
function buildAbandonedSection(list) {
    const items = getAbandoned(list);
    const $sec  = $('<div class="mv-section">');
    $sec.append(`<div class="mv-sec-title">🗑 遗弃记忆 (${items.length})</div>`);
    if (items.length) {
        const $btnRow = $('<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px;">');

        const $clr = $('<button class="mv-tbtn mv-danger-btn" style="flex:1;">🗑 一键清空</button>');
        $clr.on('click', () => {
            if (!confirm('清空所有遗弃记忆？')) return;
            clearAbandoned(_vaultId); triggerSave(); updateInjection(_vaultId, _settings); renderAll(); setStatus('✅ 已清空');
        });

        const $selAll = $('<button class="mv-tbtn" style="flex:1;">全选</button>');
        $selAll.on('click', () => {
            items.forEach(e => _selectedIds.add(e.id));
            renderAll(); syncMultibar();
        });

        const $selNone = $('<button class="mv-tbtn" style="flex:1;">取消全选</button>');
        $selNone.on('click', () => {
            items.forEach(e => _selectedIds.delete(e.id));
            renderAll(); syncMultibar();
        });

        const selCount = items.filter(e => _selectedIds.has(e.id)).length;
        const $delSel  = $(`<button class="mv-tbtn mv-danger-btn" style="flex:1;">删除选中(${selCount})</button>`);
        $delSel.on('click', () => {
            const ids = items.filter(e => _selectedIds.has(e.id)).map(e => e.id);
            if (!ids.length) { setStatus('⚠️ 未选中任何条目'); return; }
            if (!confirm(`删除选中的 ${ids.length} 条遗弃记忆？`)) return;
            deleteMemories(_vaultId, ids);
            ids.forEach(id => _selectedIds.delete(id));
            triggerSave(); updateInjection(_vaultId, _settings); renderAll(); setStatus(`✅ 已删除 ${ids.length} 条`);
        });

        $btnRow.append($clr, $selAll, $selNone, $delSel);
        $sec.append($btnRow);
        items.forEach(e => $sec.append(buildItem(e, { section:'abandoned' })));
    } else {
        $sec.append('<div class="mv-empty-hint">无遗弃记忆</div>');
    }
    return $sec;
}

// ─── 记忆库区块（所有非遗弃记忆，减去最近N条展示的） ─────────────────────
function buildVaultSection(list) {
    const n        = _settings.recentN ?? 5;
    const unpinned = getRecentUnpinned(list);
    const recentSend = n === 0 ? unpinned : unpinned.slice(Math.max(0, unpinned.length - n));
    const recentSendIds = new Set(recentSend.map(e => e.id));

    const vaultItems = list.filter(e => !e.sourceDeleted && !e.pinned && !recentSendIds.has(e.id));

    const $sec = $('<div class="mv-vault-section">');
    const arrow = _vaultCollapsed ? '▶' : '▼';
    const $header = $(`<div class="mv-vault-header"><span class="mv-vault-arrow">${arrow}</span> 📚 记忆库 (${vaultItems.length})<span class="mv-vault-hint">不发送AI</span></div>`);
    $header.on('click', () => {
        _vaultCollapsed = !_vaultCollapsed;
        renderAll();
    });
    $sec.append($header);

    if (!_vaultCollapsed) {
        if (!vaultItems.length) {
            $sec.append('<div class="mv-empty-hint">记忆库为空</div>');
        } else {
            vaultItems.forEach(e => $sec.append(buildItem(e, { section: 'recent', muted: recentSend.length > 0 })));
        }
    }
    return $sec;
}

// ─── 单条记忆 ─────────────────────────────────────────────────────────────
function buildItem(entry, opts={}) {
    const { muted=false, showPinOrder=false, isFirst=false, isLast=false, section } = opts;
    const expanded   = _expandedIds.has(entry.id);
    const isSelected = _selectedIds.has(entry.id);

    const highlighted = _highlightIds.has(entry.id);
    const $item = $(`<div class="mv-item${muted?' mv-muted':''}${entry.pinned?' mv-pinned':''}${highlighted?' mv-highlight':''}" data-id="${esc(entry.id)}">`);
    const tagsHtml = (entry.tags||[]).map(t=>`<span class="mv-tag">#${esc(t)}</span>`).join(' ');

    $item.append(`
      <div class="mv-item-top">
        <input type="checkbox" class="mv-checkbox" data-id="${esc(entry.id)}" ${isSelected?'checked':''}>
        <span class="mv-floor">#${entry.linkedMessageId !== null && entry.linkedMessageId !== undefined ? entry.linkedMessageId + 1 : '—'}</span>
        <span class="mv-date">${esc(entry.date)}</span>
        <span class="mv-tags">${tagsHtml}</span>
        <span class="mv-imp">${(entry.importance||0).toFixed(1)}</span>
        <span class="mv-preview-short">${esc((entry.content||'').split('\n')[0].slice(0,60))}</span>
        <button class="mv-expand-arrow" data-id="${esc(entry.id)}">${expanded?'▲':'▼'}</button>
      </div>
    `);

    if (expanded) {
        $item.append(`<div class="mv-content-full">${esc(entry.content)}</div>`);

        if (showPinOrder) {
            const $ord = $(`
              <div class="mv-order-row">
                <label style="font-size:11px;color:#8B7355;">序号:</label>
                <input type="number" class="mv-num-input mv-pin-order-input" value="${entry.pinnedOrder ?? ''}" placeholder="留空排最前" data-id="${esc(entry.id)}">
                <button class="mv-obtn mv-pin-top-btn" data-id="${esc(entry.id)}" title="置顶">⬆</button>
                <button class="mv-obtn mv-pin-bottom-btn" data-id="${esc(entry.id)}" title="置底">⬇</button>
                <button class="mv-obtn mv-pin-up-btn" data-id="${esc(entry.id)}" ${isFirst?'disabled':''}>↑</button>
                <button class="mv-obtn mv-pin-down-btn" data-id="${esc(entry.id)}" ${isLast?'disabled':''}>↓</button>
              </div>
            `);
            $item.append($ord);
        }

        const pinLabel    = entry.pinned ? '取消置顶' : '置顶';
        const isAbandoned = section === 'abandoned';
        const canPin      = !isAbandoned;
        const canRestore  = entry.linkedMessageId !== null && entry.linkedMessageId !== undefined && entry.content;
        const canLocate   = entry.linkedMessageId !== null && entry.linkedMessageId !== undefined;
        const $act = $(`
          <div class="mv-actions">
            <button class="mv-btn mv-btn-edit" data-id="${esc(entry.id)}">编辑</button>
            <button class="mv-btn mv-btn-copy" data-id="${esc(entry.id)}">复制</button>
            <button class="mv-btn mv-btn-delete" data-id="${esc(entry.id)}">删除</button>
            ${isAbandoned?`<button class="mv-btn mv-btn-revive" data-id="${esc(entry.id)}">♻️恢复生效</button>`:''}
            ${canPin?`<button class="mv-btn mv-btn-pin" data-id="${esc(entry.id)}">${esc(pinLabel)}</button>`:''}
            ${canRestore?`<button class="mv-btn mv-btn-restore" data-id="${esc(entry.id)}">↩还原</button>`:''}
            ${canLocate?`<button class="mv-btn mv-btn-locate" data-id="${esc(entry.id)}">📍定位</button>`:''}
          </div>
        `);
        $item.append($act);
    }

    $item.find('.mv-item-top').on('click', () => {
        _expandedIds.has(entry.id) ? _expandedIds.delete(entry.id) : _expandedIds.add(entry.id);
        renderAll();
    });
    $item.find('.mv-expand-arrow').on('click', e => {
        e.stopPropagation();
        _expandedIds.has(entry.id) ? _expandedIds.delete(entry.id) : _expandedIds.add(entry.id);
        renderAll();
    });
    $item.find('.mv-checkbox').on('click', function(e) {
        e.stopPropagation();
    }).on('change', function(e) {
        e.stopPropagation();
        this.checked ? _selectedIds.add(entry.id) : _selectedIds.delete(entry.id);
        syncMultibar();
    });
    $item.find('.mv-btn-edit').on('click', () => openEditInline(entry));
    $item.find('.mv-btn-copy').on('click', () => {
        navigator.clipboard?.writeText(entry.content).catch(()=>{});
        setStatus('✅ 已复制');
    });
    $item.find('.mv-btn-delete').on('click', () => {
        if (!confirm('删除此条记忆？')) return;
        deleteMemory(_vaultId, entry.id);
        _selectedIds.delete(entry.id); _expandedIds.delete(entry.id);
        triggerSave(); updateInjection(_vaultId, _settings); renderAll(); setStatus('已删除');
    });
    $item.find('.mv-btn-revive').on('click', () => {
        updateMemory(_vaultId, entry.id, { sourceDeleted: false });
        triggerSave(); updateInjection(_vaultId, _settings); renderAll(); setStatus('✅ 已移出遗弃区并恢复生效');
    });
    $item.find('.mv-btn-pin').on('click', () => {
        if (entry.pinned) {
            unpinMemory(_vaultId, entry.id);
        } else {
            pinMemory(_vaultId, entry.id, null);
        }
        triggerSave(); updateInjection(_vaultId, _settings); renderAll();
    });
    $item.find('.mv-btn-restore').on('click', () => {
        if (!confirm('还原此记忆的原始块到来源楼层末尾？')) return;
        const ok = restoreOneToChat(_vaultId, entry.id);
        if (ok) {
            if (_settings.autoCleanAfterRestore) {
                deleteMemory(_vaultId, entry.id);
            }
            _mvSaveChat();
            triggerSave(); updateInjection(_vaultId, _settings); renderAll(); setStatus('✅ 已还原');
        }
        else setStatus('⚠️ 还原失败（来源楼层不存在）');
    });
    $item.find('.mv-btn-locate').on('click', () => {
        const mesId = entry.linkedMessageId;
        const $msg = $(`[mesid="${mesId}"]`);
        if ($msg.length) $msg[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
        else setStatus('⚠️ 未找到楼层');
    });
    $item.find('.mv-pin-order-input').on('change', function() {
        const val = $(this).val().trim();
        const order = val === '' ? null : (parseFloat(val) || 0);
        updateMemory(_vaultId, entry.id, { pinnedOrder: order });
        triggerSave(); updateInjection(_vaultId, _settings); renderAll();
    });
    $item.find('.mv-pin-top-btn').on('click',    () => { movePinnedTop(_vaultId, entry.id);    triggerSave(); updateInjection(_vaultId, _settings); renderAll(); });
    $item.find('.mv-pin-bottom-btn').on('click', () => { movePinnedBottom(_vaultId, entry.id); triggerSave(); updateInjection(_vaultId, _settings); renderAll(); });
    $item.find('.mv-pin-up-btn').on('click',     () => { movePinnedUp(_vaultId, entry.id);     triggerSave(); updateInjection(_vaultId, _settings); renderAll(); });
    $item.find('.mv-pin-down-btn').on('click',   () => { movePinnedDown(_vaultId, entry.id);   triggerSave(); updateInjection(_vaultId, _settings); renderAll(); });

    return $item;
}

// ─── 内联编辑 ─────────────────────────────────────────────────────────────
function openEditInline(entry) {
    const $item = $(`[data-id="${entry.id}"]`).first();
    $item.find('.mv-content-full, .mv-actions, .mv-order-row').hide();
    if ($item.find('.mv-edit-box').length) return;

    const currentFloor = entry.linkedMessageId !== null && entry.linkedMessageId !== undefined
        ? String(entry.linkedMessageId + 1) : '';

    const $box = $(`
      <div class="mv-edit-box">
        <textarea class="mv-textarea">${esc(entry.content)}</textarea>
        <input type="text" class="mv-input mv-edit-tags-input" placeholder="标签（逗号分隔）" value="${esc((entry.tags||[]).join(','))}">
        <div class="mv-preset-picker-slot"></div>
        <div style="display:flex;align-items:center;gap:8px;margin-top:4px;">
          <label style="font-size:11px;color:#5D4E37;">重要度:</label>
          <input type="number" class="mv-num-input" min="0" max="1" step="0.1" value="${entry.importance}">
          <label style="font-size:11px;color:#5D4E37;">日期:</label>
          <input type="date" class="mv-input" value="${entry.date}" style="flex:1;">
        </div>
        <div style="display:flex;align-items:center;gap:8px;margin-top:4px;">
          <label style="font-size:11px;color:#5D4E37;">楼层序号:</label>
          <input type="number" class="mv-num-input mv-edit-floor-input" min="1" step="1" placeholder="留空=末尾" value="${esc(currentFloor)}" style="width:80px;">
          <span style="font-size:11px;color:#8B7355;">（留空则排在末尾）</span>
        </div>
        <div class="mv-modal-actions">
          <button class="mv-btn mv-btn-cancel">取消</button>
          <button class="mv-btn mv-btn-primary">保存</button>
        </div>
      </div>
    `);

    const $picker = buildPresetTagsPicker($box.find('.mv-edit-tags-input'));
    if ($picker) $box.find('.mv-preset-picker-slot').append($picker);

    $item.append($box);
    $box.find('.mv-btn-cancel').on('click', () => { $box.remove(); $item.find('.mv-content-full,.mv-actions,.mv-order-row').show(); });
    $box.find('.mv-btn-primary').on('click', () => {
        const content  = $box.find('textarea').val().trim();
        const tags     = $box.find('.mv-edit-tags-input').val().split(',').map(t=>t.trim()).filter(Boolean);
        const imp      = Math.min(1,Math.max(0,parseFloat($box.find('input[type=number]').first().val())||0));
        const date     = $box.find('input[type=date]').val() || entry.date;
        const floorVal = $box.find('.mv-edit-floor-input').val().trim();
        const newLinkedId = floorVal === '' ? null : (parseInt(floorVal, 10) - 1);

        const floorChanged = newLinkedId !== entry.linkedMessageId;
        if (floorChanged) {
            const list = loadMemories(_vaultId);
            const filtered = list.filter(e => e.id !== entry.id);
            saveMemories(_vaultId, filtered);
            const newEntry = addMemoryAtFloor(_vaultId, {
                ...entry,
                content, tags, importance: imp, date,
                linkedMessageId: newLinkedId,
            });
            _expandedIds.add(newEntry.id);
        } else {
            updateMemory(_vaultId, entry.id, { content, tags, importance: imp, date });
            _expandedIds.add(entry.id);
        }
        triggerSave(); updateInjection(_vaultId, _settings); renderAll(); setStatus('✅ 已保存');
    });
}

// ─── 内联新增（未保存不写库，取消零残留） ─────────────────────────────────
function addInlineNewEntry() {
    if (!_vaultId) { setStatus('⚠️ 当前无聊天'); return; }
    if ($('#mv-new-entry-card').length) {
        $('#mv-new-entry-card textarea').focus();
        return;
    }

    const today = new Date().toISOString().slice(0, 10);
    const defImp = _settings.defaultImportance ?? 0.5;

    const $card = $(`
      <div id="mv-new-entry-card" class="mv-item mv-new-entry-card">
        <div class="mv-sec-title" style="margin-bottom:6px;">＋ 新增记忆（保存后入库）</div>
        <div class="mv-edit-box" style="margin-top:0;">
          <textarea class="mv-textarea" placeholder="输入记忆内容…"></textarea>
          <input type="text" class="mv-input mv-edit-tags-input" placeholder="标签（逗号分隔，可点下方预设标签）">
          <div class="mv-preset-picker-slot"></div>
          <div style="display:flex;align-items:center;gap:8px;margin-top:4px;">
            <label style="font-size:11px;color:#5D4E37;">重要度:</label>
            <input type="number" class="mv-num-input mv-new-imp" min="0" max="1" step="0.1" value="${defImp}">
            <label style="font-size:11px;color:#5D4E37;">日期:</label>
            <input type="date" class="mv-input mv-new-date" value="${today}" style="flex:1;">
          </div>
          <div style="display:flex;align-items:center;gap:8px;margin-top:4px;flex-wrap:wrap;">
            <label style="font-size:11px;color:#5D4E37;">楼层序号:</label>
            <input type="number" class="mv-num-input mv-new-floor" min="1" step="1" placeholder="留空=末尾" style="width:80px;">
            <label class="mv-set-label" style="margin-left:auto;">
              <input type="checkbox" class="mv-new-pinned" ${_activeTab === 'pinned' ? 'checked' : ''}> 直接置顶
            </label>
          </div>
          <div class="mv-modal-actions">
            <button class="mv-btn mv-btn-cancel">取消</button>
            <button class="mv-btn mv-btn-primary">保存</button>
          </div>
        </div>
      </div>
    `);

    const $picker = buildPresetTagsPicker($card.find('.mv-edit-tags-input'));
    if ($picker) $card.find('.mv-preset-picker-slot').append($picker);

    $card.find('.mv-btn-cancel').on('click', () => $card.remove());
    $card.find('.mv-btn-primary').on('click', () => {
        const content = $card.find('textarea').val().trim();
        if (!content) { setStatus('⚠️ 记忆内容不能为空'); $card.find('textarea').focus(); return; }
        const tags = $card.find('.mv-edit-tags-input').val().split(',').map(t=>t.trim()).filter(Boolean);
        const imp  = Math.min(1, Math.max(0, parseFloat($card.find('.mv-new-imp').val()) || 0));
        const date = $card.find('.mv-new-date').val() || today;
        const floorVal = $card.find('.mv-new-floor').val().trim();
        const linkedMessageId = floorVal === '' ? null : (parseInt(floorVal, 10) - 1);
        const pinned = $card.find('.mv-new-pinned').prop('checked');

        const fields = { content, tags, importance: imp, date, linkedMessageId, pinned, source: 'manual' };
        const entry = linkedMessageId !== null ? addMemoryAtFloor(_vaultId, fields) : addMemory(_vaultId, fields);
        _expandedIds.add(entry.id);
        _highlightIds.add(entry.id);
        if (pinned && _activeTab !== 'pinned') {
            _activeTab = 'pinned';
            _pinnedCollapsed = false;
            $('.mv-tab').removeClass('mv-tab-active');
            $('#mv-tab-pinned').addClass('mv-tab-active');
        } else if (!pinned && _activeTab !== 'recent') {
            _activeTab = 'recent';
            $('.mv-tab').removeClass('mv-tab-active');
            $('#mv-tab-recent').addClass('mv-tab-active');
        }
        triggerSave();
        updateInjection(_vaultId, _settings);
        renderAll();
        setTimeout(() => { _highlightIds.delete(entry.id); renderAll(); }, 1800);
        setStatus('✅ 已新增记忆');
    });

    $('#mv-body').prepend($card);
    $('#mv-body').scrollTop(0);
    $card.find('textarea').focus();
}

// ─── 实际注入预览弹窗 ─────────────────────────────────────────────────────
export function openInjectPreviewModal() {
    if (!_vaultId) { setStatus('⚠️ 当前无聊天'); return; }
    const list = loadMemories(_vaultId);
    const pinnedCount = getPinnedSorted(list).length;
    const n = _settings.recentN ?? 5;
    const unpinned = getRecentUnpinned(list);
    const recentCount = n === 0 ? unpinned.length : Math.min(unpinned.length, n);
    const text = _settings.enabled === false ? '' : buildPromptText(list, _settings);
    const { position, depth } = resolvePosition(_settings.injectionPosition);

    const posNames = {
        in_chat: `历史聊天最前 (IN_CHAT, depth=${depth})`,
        before_prompt: `主提示词之前 (BEFORE_PROMPT, depth=${depth})`,
        after_char: `主提示词/角色卡之后 (IN_PROMPT, depth=${depth})`,
        authors_note: `聊天内深度 ${depth} (IN_CHAT)`,
    };
    const posLabel = posNames[_settings.injectionPosition] || `position=${position}, depth=${depth}`;
    const statusLabel = _settings.enabled === false ? '⏸️ 已关闭（不会注入）' : '✅ 已启用';
    const charLen = text.length;

    $('#mv-inject-preview-meta').html(`
      <div><b>状态：</b>${statusLabel} ｜ <b>位置：</b>${esc(posLabel)}</div>
      <div><b>本次注入：</b>置顶 ${pinnedCount} 条 + 最近 ${recentCount} 条（共 ${pinnedCount + recentCount} 条，约 ${charLen} 字）</div>
    `);
    $('#mv-inject-preview-text').val(text || '（当前不会向 AI 注入任何记忆内容）');
    $('#mv-inject-preview-modal').addClass('mv-modal-active');
}

// ─── 历史记忆库管理 / 重新绑定弹窗 ────────────────────────────────────────

export function openVaultsModal() {
    _vaultSearch = '';
    _previewVaultId = null;
    $('#mv-vaults-search').val('');
    renderVaultsList();
    $('#mv-vaults-modal').addClass('mv-modal-active');
}

function renderVaultsList() {
    const currentChat = getCurrentChatId();
    const currentCount = _vaultId ? loadMemories(_vaultId).length : 0;
    $('#mv-vaults-current-info').html(
        currentChat
            ? `<div><b>当前聊天：</b>${esc(currentChat)}</div><div><b>当前绑定库：</b>${esc(_vaultId || '未绑定')}（${currentCount} 条）</div>`
            : `<div>⚠️ 当前未打开任何聊天窗口，请先进入一个聊天后再绑定。</div>`
    );

    const allVaults = listAllVaults(_vaultId);
    const q = _vaultSearch.trim().toLowerCase();
    const filtered = q
        ? allVaults.filter(v => {
            if (v.chatName.toLowerCase().includes(q) || v.charName.toLowerCase().includes(q) || v.vaultId.toLowerCase().includes(q)) {
                return true;
            }
            const mems = loadMemories(v.vaultId);
            return mems.some(m => (m.content || '').toLowerCase().includes(q) || (m.tags || []).some(t => t.toLowerCase().includes(q)));
        })
        : allVaults;

    const $list = $('#mv-vaults-list').empty();
    if (!filtered.length) {
        $list.append('<div class="mv-empty-hint">未找到匹配的历史记忆库</div>');
        return;
    }

    for (const v of filtered) {
        const isPreviewOpen = _previewVaultId === v.vaultId;
        const badge = v.isCurrent ? '<span class="mv-vault-badge">当前已绑定</span>' : '';
        const charTag = v.charName ? `<span class="mv-tag">${esc(v.charName)}</span>` : '';
        const $card = $(`
          <div class="mv-vault-card${v.isCurrent ? ' mv-vault-card-current' : ''}">
            <div class="mv-vault-card-head">
              <span class="mv-vault-card-name" title="${esc(v.vaultId)}">${esc(v.chatName)}</span>
              ${badge}
            </div>
            <div class="mv-vault-card-meta">
              ${charTag}
              <span>有效 ${v.activeCount} / 共 ${v.totalCount} 条</span>
              ${v.latestDate ? `<span>最近: ${esc(v.latestDate)}</span>` : ''}
            </div>
            ${v.preview ? `<div class="mv-vault-card-preview">${esc(v.preview)}</div>` : '<div class="mv-vault-card-preview">（空记忆库）</div>'}
            <div class="mv-vault-card-actions">
              <button class="mv-tbtn mv-vc-preview">${isPreviewOpen ? '收起预览' : '👁️ 预览'}</button>
              ${!v.isCurrent && currentChat ? '<button class="mv-tbtn mv-merge-btn mv-vc-bind">🔗 绑定到当前</button>' : ''}
              ${!v.isCurrent && currentChat && v.totalCount > 0 ? '<button class="mv-tbtn mv-vc-merge">➕ 合并到当前</button>' : ''}
              ${!v.isCurrent ? '<button class="mv-tbtn mv-danger-btn mv-vc-del">🗑️</button>' : ''}
            </div>
          </div>
        `);

        if (isPreviewOpen) {
            const mems = loadMemories(v.vaultId);
            const $prevBox = $('<div class="mv-vault-preview-box">');
            if (!mems.length) {
                $prevBox.append('<div class="mv-empty-hint">该库暂无记忆</div>');
            } else {
                const showMems = mems.slice(0, 20);
                for (const m of showMems) {
                    const statusMark = m.sourceDeleted ? '[遗弃] ' : (m.pinned ? '📌 ' : '');
                    $prevBox.append(
                        `<div class="mv-vault-preview-row"><b>${esc(m.date || '')}</b> ${statusMark}${esc((m.content || '').slice(0, 120))}</div>`
                    );
                }
                if (mems.length > 20) {
                    $prevBox.append(`<div class="mv-empty-hint">… 还有 ${mems.length - 20} 条未展示</div>`);
                }
            }
            $card.append($prevBox);
        }

        $card.find('.mv-vc-preview').on('click', () => {
            _previewVaultId = isPreviewOpen ? null : v.vaultId;
            renderVaultsList();
        });

        $card.find('.mv-vc-bind').on('click', () => {
            const msg = currentCount > 0
                ? `当前聊天已有 ${currentCount} 条记忆。\n确定改为绑定到「${v.chatName}」（${v.totalCount} 条）吗？\n（原记忆库不会被删除，随时可以再切回来）`
                : `确定将当前聊天绑定到历史记忆库「${v.chatName}」（${v.totalCount} 条）吗？`;
            if (!confirm(msg)) return;
            if (bindCurrentChatToVault(v.vaultId)) {
                _vaultId = v.vaultId;
                _selectedIds.clear();
                _expandedIds.clear();
                if (_onVaultBound) _onVaultBound(v.vaultId);
                $('#mv-vaults-modal').removeClass('mv-modal-active');
                switchView('main');
                setStatus(`✅ 已重新绑定到「${v.chatName}」`);
            }
        });

        $card.find('.mv-vc-merge').on('click', () => {
            if (!confirm(`确定将「${v.chatName}」中的记忆合并追加到当前聊天吗？（会自动去重，原库保留）`)) return;
            const added = mergeVaultInto(v.vaultId, _vaultId);
            triggerSave();
            updateInjection(_vaultId, _settings);
            renderAll();
            renderVaultsList();
            setStatus(`✅ 已从「${v.chatName}」合并 ${added} 条记忆`);
        });

        $card.find('.mv-vc-del').on('click', () => {
            if (!confirm(`⚠️ 确定永久删除历史记忆库「${v.chatName}」（共 ${v.totalCount} 条）？此操作不可撤销！`)) return;
            deleteVault(v.vaultId);
            if (_previewVaultId === v.vaultId) _previewVaultId = null;
            renderVaultsList();
            setStatus(`🗑 已删除记忆库「${v.chatName}」`);
        });

        $list.append($card);
    }
}

// ─── 多选工具栏 ───────────────────────────────────────────────────────────
function syncMultibar() {
    const count = _selectedIds.size;
    $('#mv-multibar').toggle(count > 0);
    $('#mv-sel-count').text(count ? `已选 ${count} 条` : '');
    $('#mv-merge-btn').toggle(count >= 2);
    $('#mv-del-sel-btn').toggle(count >= 1);
    const inAbandoned = _activeTab === 'abandoned';
    $('#mv-batch-pin-btn').toggle(count >= 1 && !inAbandoned);
    $('#mv-batch-unpin-btn').toggle(count >= 1 && !inAbandoned);
}

// ─── 面板事件 ─────────────────────────────────────────────────────────────
function bindPanelEvents() {
    $('#mv-close-btn').on('click', hidePanel);
    $('#mv-settings-btn').on('click', () => switchView(_view === 'settings' ? 'main' : 'settings'));
    $('#mv-preview-inject-btn').on('click', openInjectPreviewModal);
    $('#mv-vaults-btn, #mv-open-vaults-btn').on('click', openVaultsModal);

    // 停用横幅快捷开启（复用 #mv-set-enabled 的 change 逻辑）
    $('#mv-quick-enable-btn').on('click', () => {
        $('#mv-set-enabled').prop('checked', true).trigger('change');
        renderAll();
        setStatus('✅ 已开启记忆注入');
    });

    // 弹窗关闭 & 点击半透明遮罩层关闭
    $('#mv-vaults-close').on('click', () => $('#mv-vaults-modal').removeClass('mv-modal-active'));
    $('#mv-inject-preview-close').on('click', () => $('#mv-inject-preview-modal').removeClass('mv-modal-active'));
    $('#mv-inject-preview-copy').on('click', () => {
        const txt = $('#mv-inject-preview-text').val();
        navigator.clipboard?.writeText(txt).catch(() => {});
        setStatus('✅ 已复制注入文本');
    });
    $('.mv-modal').on('click', function(e) {
        if (e.target === this) $(this).removeClass('mv-modal-active');
    });

    $('#mv-vaults-search').on('input', function() {
        _vaultSearch = $(this).val();
        renderVaultsList();
    });

    // Tab 切换
    $(document).on('click', '.mv-tab', function() {
        _activeTab = $(this).data('tab');
        $('.mv-tab').removeClass('mv-tab-active');
        $(this).addClass('mv-tab-active');
        renderAll();
    });

    $('#mv-pin-sort').on('change', function() { _pinnedSort = $(this).val(); renderAll(); });
    $('#mv-search-input').on('input', function() {
        _searchQuery = $(this).val();
        $('#mv-search-clear').toggle(_searchQuery.length > 0);
        renderAll();
    });
    $('#mv-search-clear').on('click', () => {
        _searchQuery = '';
        $('#mv-search-input').val('').focus();
        $('#mv-search-clear').hide();
        renderAll();
    });
    $('#mv-add-btn').on('click', addInlineNewEntry);

    // 仅全选当前 Tab 可见条目
    $('#mv-sel-all').on('click', () => {
        getCurrentTabVisibleIds().forEach(id => _selectedIds.add(id));
        renderAll();
        syncMultibar();
    });
    $('#mv-sel-none').on('click', () => { _selectedIds.clear(); renderAll(); syncMultibar(); });

    // 批量置顶 / 取消置顶
    $('#mv-batch-pin-btn').on('click', () => {
        if (!_vaultId || !_selectedIds.size) return;
        const list = loadMemories(_vaultId);
        let changed = 0;
        for (const e of list) {
            if (_selectedIds.has(e.id) && !e.sourceDeleted && !e.pinned) {
                e.pinned = true;
                e.pinnedOrder = null;
                changed++;
            }
        }
        if (changed > 0) saveMemories(_vaultId, list);
        _selectedIds.clear();
        triggerSave(); updateInjection(_vaultId, _settings); renderAll();
        setStatus(`✅ 已批量置顶 ${changed} 条`);
    });
    $('#mv-batch-unpin-btn').on('click', () => {
        if (!_vaultId || !_selectedIds.size) return;
        const list = loadMemories(_vaultId);
        let changed = 0;
        for (const e of list) {
            if (_selectedIds.has(e.id) && e.pinned) {
                e.pinned = false;
                e.pinnedOrder = null;
                changed++;
            }
        }
        if (changed > 0) saveMemories(_vaultId, list);
        _selectedIds.clear();
        triggerSave(); updateInjection(_vaultId, _settings); renderAll();
        setStatus(`✅ 已取消置顶 ${changed} 条`);
    });

    $('#mv-merge-btn').on('click', openMergeModal);
    $('#mv-del-sel-btn').on('click', () => {
        if (!confirm(`删除选中的 ${_selectedIds.size} 条？`)) return;
        deleteMemories(_vaultId, [..._selectedIds]); _selectedIds.clear();
        triggerSave(); updateInjection(_vaultId, _settings); renderAll(); setStatus('✅ 已批量删除');
    });

    // 合并弹窗
    $('#mv-merge-cancel').on('click', () => $('#mv-merge-modal').removeClass('mv-modal-active'));
    $('#mv-merge-confirm').on('click', () => {
        const content = $('#mv-merge-content').val().trim();
        if (!content) return;
        const merged = mergeMemories(_vaultId, [..._selectedIds], content);
        _selectedIds.clear(); $('#mv-merge-modal').removeClass('mv-modal-active'); triggerSave(); updateInjection(_vaultId, _settings);
        if (merged) {
            _highlightIds.add(merged.id);
            renderAll();
            const $target = $(`[data-id="${merged.id}"]`);
            if ($target.length) $target[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
            setTimeout(() => { _highlightIds.delete(merged.id); renderAll(); }, 2000);
        } else {
            renderAll();
        }
        setStatus('✅ 合并完成');
    });

    // 扫描弹窗
    $('#mv-scan-cancel').on('click', () => $('#mv-scan-modal').removeClass('mv-modal-active'));
    $('#mv-scan-confirm').on('click', commitScanImport);

    // 翻页按钮
    $('#mv-pgup').on('click', () => {
        const $body = $('#mv-body');
        $body.scrollTop($body.scrollTop() - $body.height() * 0.8);
    });
    $('#mv-pgdn').on('click', () => {
        const $body = $('#mv-body');
        $body.scrollTop($body.scrollTop() + $body.height() * 0.8);
    });

    // 设置视图储存应用
    $(document).on('click', '#mv-save-settings-btn', () => {
        triggerSave();
        setStatus('✅ 设置已储存');
    });
}

function openMergeModal() {
    const list = loadMemories(_vaultId);
    const selected = list.filter(e => _selectedIds.has(e.id));
    selected.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    const lines = [];
    let lastDate = null;
    for (const e of selected) {
        const tagsStr = (e.tags || []).join(',');
        const imp = (e.importance || 0).toFixed(1);
        if (e.date !== lastDate) {
            lines.push(`${e.date}|${tagsStr}|${imp}|${e.content}`);
            lastDate = e.date;
        } else {
            lines.push(`${tagsStr}|${imp}|${e.content}`);
        }
    }
    $('#mv-merge-content').val(lines.join('\n'));
    $('#mv-merge-modal').addClass('mv-modal-active');
}

// ─── 手动扫描 ─────────────────────────────────────────────────────────────
export function openScanModal() {
    try {
        if (!_vaultId) { setStatus('⚠️ 当前无聊天'); return; }
        const ctx  = SillyTavern.getContext();
        const chat = ctx?.chat;
        if (!chat?.length) { setStatus('⚠️ 无聊天数据'); return; }

        const existing = loadMemories(_vaultId);
        const excludeThreshold = _settings.scanExcludeRecentN
            ? chat.length - (_settings.autoCaptureExcludeN ?? 0)
            : chat.length;
        const newBlocks = [];
        chat.forEach((msg, mi) => {
            if (mi >= excludeThreshold) return;
            const re = /<Lenitxt>([\s\S]*?)<\/Lenitxt>/gi;
            let m, bi = 0;
            while ((m = re.exec(msg.mes || '')) !== null) {
                const already = isBlockAlreadyStored(existing, mi, { originalText: m[0] });
                if (!already) {
                    newBlocks.push({ mi, bi, content: m[1].trim(), full: m[0], start: m.index });
                }
                bi++;
            }
        });

        if (!newBlocks.length) { setStatus('未找到新的 <Lenitxt> 块'); return; }

        const floors    = newBlocks.map(b => b.mi + 1);
        const minFloor  = Math.min(...floors);
        const maxFloor  = Math.max(...floors);
        const count     = newBlocks.length;

        if (!confirm(`捕获到第${minFloor}楼到第${maxFloor}楼的${count}个Lenitxt块，是否导入？`)) return;

        const added = doImportBlocks(newBlocks);
        setStatus(`✅ 导入 ${added} 条`);
    } catch(e) { setStatus('⚠️ 扫描失败: '+e.message); }
}

function doImportBlocks(blocksToImport) {
    const ctx   = SillyTavern.getContext();
    const chat  = ctx?.chat;
    if (!chat || !_vaultId) return 0;

    const existing  = loadMemories(_vaultId);
    saveDbSnapshot(_vaultId);
    const chatSnap  = {};
    const byMsg     = {};
    blocksToImport.forEach(b => { (byMsg[b.mi] = byMsg[b.mi]||[]).push(b); });

    let added = 0;
    const allEntries = [...existing];

    for (const miStr of Object.keys(byMsg)) {
        const mi  = parseInt(miStr, 10);
        const msg = chat[mi];
        if (!msg) continue;
        const originalMes = msg.mes;
        const { newEntries, modifiedText } = _mvScanAndStore(_vaultId, mi, originalMes, allEntries, _settings.defaultImportance ?? 0.5);
        if (!newEntries.length) continue;

        chatSnap[mi] = originalMes;
        for (const entry of newEntries) {
            let insertPos = allEntries.length;
            for (let j = allEntries.length - 1; j >= 0; j--) {
                if (allEntries[j].linkedMessageId !== null && allEntries[j].linkedMessageId !== undefined &&
                    allEntries[j].linkedMessageId <= entry.linkedMessageId) {
                    insertPos = j + 1;
                    break;
                }
            }
            const firstBigger = allEntries.findIndex(e => e.linkedMessageId !== null && e.linkedMessageId !== undefined && e.linkedMessageId > entry.linkedMessageId);
            if (firstBigger !== -1 && insertPos === allEntries.length) insertPos = firstBigger;
            allEntries.splice(insertPos, 0, entry);
        }
        msg.mes = modifiedText;
        added += newEntries.length;
    }

    if (added > 0) {
        saveMemories(_vaultId, allEntries);
        saveChatSnapshot(_vaultId, chatSnap, true);
        _mvSaveChat();
        triggerSave();
        renderAll();
        updateInjection(_vaultId, _settings);
    }
    return added;
}

function commitScanImport() {
    const found = $('#mv-scan-modal').data('blocks') ?? [];
    const checked = new Set();
    $('#mv-scan-list input[type=checkbox]:checked').each(function() { checked.add(parseInt($(this).data('idx'), 10)); });
    const toImport = found.filter((_,i) => checked.has(i));
    if (!toImport.length) { $('#mv-scan-modal').removeClass('mv-modal-active'); return; }

    $('#mv-scan-modal').removeClass('mv-modal-active');
    const added = doImportBlocks(toImport);
    setStatus(`✅ 导入 ${added} 条`);
}

// 注入回调供扫描和还原使用（index.js 设置）
let _mvScanAndStore = null;
let _mvSaveChat     = () => {};
export function setUiHelpers(scanFn, saveChatFn) {
    _mvScanAndStore = scanFn;
    _mvSaveChat     = saveChatFn;
}

// ─── 外部调用 ─────────────────────────────────────────────────────────────
export function onNewMemoriesAdded(count) {
    if (!$('#mv-panel').hasClass('mv-active')) return;
    renderAll(); setStatus(`✅ 自动入库 ${count} 条`);
}

export function onChatChanged(statusMsg = '') {
    _selectedIds.clear(); _expandedIds.clear();
    if ($('#mv-panel').hasClass('mv-active') && _view === 'main') renderAll();
    if (statusMsg) setStatus(statusMsg);
}

// ─── 设置面板同步（唯一入口，供 index.js 调用） ───────────────────────────
export function syncSettings(s) {
    _settings = s;
    $('#mv-set-enabled').prop('checked', s.enabled);
    $('#mv-set-backend').val(s.backend);
    $('#mv-set-position').val(s.injectionPosition);
    $('#mv-set-pinned-first').prop('checked', s.pinnedFirst);
    $('#mv-set-recent-n').val(s.recentN);
    $('#mv-set-def-imp').val(s.defaultImportance);
    $('#mv-set-inject-format').val(s.injectFormat || 'lenitxt');
    $('#mv-set-scan-exclude-recent-n').prop('checked', s.scanExcludeRecentN);
    $('#mv-set-auto-capture').prop('checked', s.autoCapture);
    $('#mv-set-auto-capture-n').val(s.autoCaptureExcludeN ?? 6);
    $('#mv-set-auto-clean-restore').prop('checked', s.autoCleanAfterRestore);
    $('#mv-fp-chat-switch-copy').val(s.chatSwitchCopy || 'empty_only');
    const $box = $('#mv-preset-tags-box').empty();
    (s.presetTags||[]).forEach((tag,i) => {
        $box.append(`<span class="mv-preset-tag">#${esc(tag)} <button class="mv-preset-tag-del" data-idx="${i}">×</button></span>`);
    });
}