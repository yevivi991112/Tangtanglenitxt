/**
 * ui.js — 浮动面板：多分区切换 + 主视图 + 置顶拖拽排序 + 标签点击筛选 + 内置设置视图 + 历史记忆库管理 + 注入预览弹窗
 *
 * 设计不变量：
 * 1. 所有设置控件集中在浮动面板内，避免与外部 settings.html 产生 DOM ID 冲突。
 * 2. 「全选当前页」仅作用于当前所在 Tab 与当前分区的可见条目，防止误删其他分区的数据。
 * 3. 编辑楼层序号重新插入时，必须完整保留原条目的 pinned / pinnedOrder / sourceDeleted / zoneId 状态。
 * 4. 新增记忆采用临时编辑表单，仅点击「保存」时写入数据库，点「取消」不会残留空白记录。
 * 5. 置顶区块支持鼠标与手机触摸拖动排序，同时保留展开后的序号输入与 ↑/↓ 微调。
 * 6. 修改聊天原文（扫描入库 / 还原）后通过 _mvRefreshMsgs 立即刷新酒馆楼层 DOM。
 */

import {
    loadMemories, saveMemories, addMemory, addMemoryAtFloor, updateMemory, deleteMemory, deleteMemories,
    mergeMemories, getPinnedSorted, getRecentUnpinned, getAbandoned,
    pinMemory, unpinMemory, clearAbandoned, restoreOneToChat,
    movePinnedTop, movePinnedBottom, movePinnedUp, movePinnedDown, reorderPinned,
    saveDbSnapshot, saveChatSnapshot, isBlockAlreadyStored,
    getCurrentChatId, bindCurrentChatToVault, mergeVaultInto,
    normalizeZones, getEntryZoneId, extractBlocksForZones,
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
function getZones() { return normalizeZones(_settings.zones); }

// ─── 状态 ─────────────────────────────────────────────────────────────────
let _selectedIds     = new Set();
let _expandedIds     = new Set();
let _pinnedSort      = 'order';
let _searchQuery     = '';
let _activeTagFilter = null;
let _activeZone      = 'all'; // 'all' | zone.id
let _view            = 'main'; // 'main' | 'settings'
let _activeTab       = 'pinned'; // 'pinned' | 'recent' | 'abandoned'
let _pinnedCollapsed = false;
let _vaultCollapsed  = true;
let _highlightIds    = new Set();
let _vaultSearch     = '';
let _previewVaultId  = null;
let _draggingId      = null;

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

    <!-- 多分区快速切换栏（仅配置 >=2 个分区时显示） -->
    <div id="mv-zone-bar" class="mv-zone-bar" style="display:none;"></div>

    <!-- Tab 切换栏 -->
    <div class="mv-tab-bar">
      <button class="mv-tab mv-tab-active" data-tab="pinned" id="mv-tab-pinned">📌置顶</button>
      <button class="mv-tab" data-tab="recent" id="mv-tab-recent">📋最近</button>
      <button class="mv-tab mv-tab-trash" data-tab="abandoned" id="mv-tab-abandoned">🗑️</button>
    </div>

    <div class="mv-toolbar">
      <label class="mv-label" id="mv-pin-sort-wrap" style="margin-left:0;">置顶排序:
        <select id="mv-pin-sort" class="mv-select">
          <option value="order">拖动/序号(默认楼层)</option>
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

    <!-- 当前标签筛选条 -->
    <div id="mv-tag-filter-bar" class="mv-tag-filter-bar" style="display:none;">
      <span>🏷️ 标签筛选：<b id="mv-tag-filter-name"></b></span>
      <button class="mv-tbtn mv-tag-filter-clear" id="mv-tag-filter-clear">× 清除</button>
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
      <div class="mv-set-title">分区与捕获标签（可同时捕获多个代码块并分区管理）</div>
      <div id="mv-zones-editor" class="mv-zones-editor"></div>
      <button class="mv-tbtn" id="mv-zone-add-btn" style="width:100%;margin-top:6px;">＋ 新增分区（如大总结 / Summary）</button>
      <div style="font-size:11px;color:#8B7355;margin-top:4px;">
        标签名不带尖括号（例如填 Lenitxt 匹配 &lt;Lenitxt&gt;...&lt;/Lenitxt&gt;）。配置 2 个及以上分区时，主界面顶部会自动出现快捷切换条。
      </div>
    </div>

    <div class="mv-set-section">
      <div class="mv-set-title">存储方案</div>
      <select id="mv-set-backend" class="mv-select" style="width:100%;margin-bottom:6px;">
        <option value="ext">后端保存（推荐，跟随ST数据）</option>
        <option value="local">浏览器保存（备选，清缓存丢失）</option>
      </select>
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:6px;">
        <button class="mv-tbtn" id="mv-test-ext">测试①</button>
        <span id="mv-test-ext-result" class="mv-test-result"></span>
        <button class="mv-tbtn" id="mv-test-local">测试②</button>
        <span id="mv-test-local-result" class="mv-test-result"></span>
      </div>
      <button class="mv-tbtn" id="mv-migrate-backend-btn" style="width:100%;">🔄 从另一存储后端一键迁移数据到当前后端</button>
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
        <span style="font-size:11px;color:#8B7355;">(0=全发，按楼层排序)</span>
      </div>
      <div style="display:flex;align-items:center;gap:6px;margin-top:4px;">
        <label class="mv-set-label">注入格式:</label>
        <select id="mv-set-inject-format" class="mv-select" style="flex:1;">
          <option value="lenitxt">带分区标签（如 &lt;Lenitxt&gt;）</option>
          <option value="plain">纯文本（日期|标签|内容）</option>
          <option value="lenitxt_single">整合记忆（每分区仅包裹一次）</option>
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
        <button class="mv-tbtn" id="mv-scan-chat-btn" style="width:100%;">🔍 手动扫描聊天中的分区标签块</button>
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
        ⚠️ 开启后，超出 N 楼的消息中已配置分区的标签块将被自动入库并从聊天记录中删除
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
    <div class="mv-modal-title">🔍 扫描聊天中的分区标签块</div>
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

export function showPanel() {
    $('#extensionsMenu').hide();
    $('#mv-panel').css({ left: '', right: '', top: '', transform: '' }).addClass('mv-active');
    renderAll();
}
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
        renderZonesEditor();
    } else {
        $('#mv-settings-view').hide();
        $('#mv-main-view').show();
        $('#mv-settings-btn').text('⚙️');
        renderAll();
    }
}

// ─── 设置页：分区与捕获标签编辑器 ─────────────────────────────────────────
function renderZonesEditor() {
    const zones = getZones();
    _settings.zones = zones;
    const $box = $('#mv-zones-editor').empty();

    zones.forEach((z, idx) => {
        const canDelete = zones.length > 1;
        const $row = $(`
          <div class="mv-zone-row" data-idx="${idx}">
            <div class="mv-zone-row-top">
              <input type="text" class="mv-input mv-zone-name" placeholder="分区名（如记忆/大总结）" value="${esc(z.name)}">
              <input type="text" class="mv-input mv-zone-tag" placeholder="标签名（如Lenitxt）" value="${esc(z.tag)}">
              ${canDelete ? '<button type="button" class="mv-tbtn mv-danger-btn mv-zone-del" title="删除分区">×</button>' : ''}
            </div>
            <label class="mv-set-label" style="margin-top:4px;font-size:11px;">
              <input type="checkbox" class="mv-zone-defpin" ${z.defaultPinned ? 'checked' : ''}> 捕获到该分区时默认置顶
            </label>
          </div>
        `);

        $row.find('.mv-zone-name').on('change', function() {
            const val = $(this).val().trim();
            if (!val) { $(this).val(z.name); return; }
            _settings.zones[idx].name = val;
            triggerSave();
            if (_vaultId && _settings.enabled) updateInjection(_vaultId, _settings);
        });

        $row.find('.mv-zone-tag').on('change', function() {
            const val = $(this).val().trim().replace(/[<>\/]/g, '');
            if (!val) { $(this).val(z.tag); return; }
            $(this).val(val);
            _settings.zones[idx].tag = val;
            triggerSave();
            if (_vaultId && _settings.enabled) updateInjection(_vaultId, _settings);
        });

        $row.find('.mv-zone-defpin').on('change', function() {
            _settings.zones[idx].defaultPinned = this.checked;
            triggerSave();
        });

        $row.find('.mv-zone-del').on('click', () => {
            if (!confirm(`确定删除分区「${z.name}」吗？\n（该分区内已有记忆不会丢失，会自动归入第一个分区）`)) return;
            const removedId = _settings.zones[idx].id;
            _settings.zones.splice(idx, 1);
            if (_activeZone === removedId) _activeZone = 'all';
            triggerSave();
            renderZonesEditor();
            if (_vaultId && _settings.enabled) updateInjection(_vaultId, _settings);
        });

        $box.append($row);
    });
}

// ─── 预设标签选择器组件 ───────────────────────────────────────────────────
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

// ─── 过滤辅助：按分区 + 搜索词 + 点击标签 ─────────────────────────────────
function filterByZone(rawList) {
    const zones = getZones();
    if (_activeZone === 'all' || !zones.some(z => z.id === _activeZone)) {
        _activeZone = 'all';
        return rawList;
    }
    return rawList.filter(e => getEntryZoneId(e, zones) === _activeZone);
}

function getCurrentTabVisibleIds() {
    if (!_vaultId) return [];
    let list = filterByZone(loadMemories(_vaultId));
    const tagArr = _activeTagFilter ? [_activeTagFilter] : [];
    if (_searchQuery.trim() || tagArr.length) list = filterMemories(list, _searchQuery, tagArr);

    if (_activeTab === 'pinned') return getPinnedSorted(list).map(e => e.id);
    if (_activeTab === 'recent') {
        const n = _settings.recentN ?? 5;
        const unpinned = getRecentUnpinned(list);
        const send = n === 0 ? unpinned : unpinned.slice(Math.max(0, unpinned.length - n));
        return send.map(e => e.id);
    }
    if (_activeTab === 'abandoned') return getAbandoned(list).map(e => e.id);
    return [];
}

// ─── 渲染分区切换条 & Tab 角标 & 工具栏状态 ───────────────────────────────
function syncHeaderAndTabs(rawList) {
    const zones = getZones();
    $('#mv-disabled-banner').toggle(_settings.enabled === false);
    $('#mv-pin-sort-wrap').toggle(_activeTab === 'pinned');
    $('#mv-search-clear').toggle(_searchQuery.length > 0);

    // 标签筛选提示条
    if (_activeTagFilter) {
        $('#mv-tag-filter-name').text('#' + _activeTagFilter);
        $('#mv-tag-filter-bar').show();
    } else {
        $('#mv-tag-filter-bar').hide();
    }

    // 多分区快捷切换条
    const $zoneBar = $('#mv-zone-bar');
    if (zones.length > 1) {
        if (_activeZone !== 'all' && !zones.some(z => z.id === _activeZone)) _activeZone = 'all';
        const validAll = rawList.filter(e => !e.sourceDeleted);
        $zoneBar.empty().show();

        const $allPill = $(`<button class="mv-zone-pill${_activeZone === 'all' ? ' mv-zone-pill-active' : ''}">全部(${validAll.length})</button>`);
        $allPill.on('click', () => { _activeZone = 'all'; renderAll(); });
        $zoneBar.append($allPill);

        zones.forEach(z => {
            const cnt = validAll.filter(e => getEntryZoneId(e, zones) === z.id).length;
            const $pill = $(`<button class="mv-zone-pill${_activeZone === z.id ? ' mv-zone-pill-active' : ''}">${esc(z.name)}(${cnt})</button>`);
            $pill.on('click', () => { _activeZone = z.id; renderAll(); });
            $zoneBar.append($pill);
        });
    } else {
        _activeZone = 'all';
        $zoneBar.hide();
    }

    // Tab 数量角标（按当前所选分区统计）
    const zonedList = filterByZone(rawList);
    const pinnedCount = getPinnedSorted(zonedList).length;
    const n = _settings.recentN ?? 5;
    const unpinned = getRecentUnpinned(zonedList);
    const recentCount = n === 0 ? unpinned.length : Math.min(unpinned.length, n);
    const abandonedCount = getAbandoned(zonedList).length;

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

    let list = filterByZone(rawList);
    const tagArr = _activeTagFilter ? [_activeTagFilter] : [];
    if (_searchQuery.trim() || tagArr.length) list = filterMemories(list, _searchQuery, tagArr);

    const scrollPos = $body.scrollTop();
    const tabScrollPos = $body.find('.mv-tab-content').scrollTop() || 0;
    $body.empty();

    const $tabContent = $('<div class="mv-tab-content">');
    if (_activeTab === 'pinned') {
        $tabContent.append(buildPinnedSection(list));
    } else if (_activeTab === 'recent') {
        $tabContent.append(buildRecentSection(list));
    } else if (_activeTab === 'abandoned') {
        $tabContent.append(buildAbandonedSection(list));
    }
    $body.append($tabContent);

    $body.append(buildVaultSection(list));

    syncMultibar();
    $body.scrollTop(scrollPos);
    $body.find('.mv-tab-content').scrollTop(tabScrollPos);
}

// ─── 置顶区块（支持一键收起/展开 + 鼠标/触摸拖动排序） ────────────────────
function buildPinnedSection(list) {
    let pinned = getPinnedSorted(list);
    if (_pinnedSort === 'time_asc')  pinned = [...pinned].sort((a,b) => (a.timestamp||0) - (b.timestamp||0));
    if (_pinnedSort === 'time_desc') pinned = [...pinned].sort((a,b) => (b.timestamp||0) - (a.timestamp||0));
    if (_pinnedSort === 'imp_desc')  pinned = [...pinned].sort((a,b) => (b.importance||0) - (a.importance||0));
    if (_pinnedSort === 'imp_asc')   pinned = [...pinned].sort((a,b) => (a.importance||0) - (b.importance||0));

    const $sec = $('<div class="mv-section">');
    const arrow = _pinnedCollapsed ? '▶' : '▼';
    const toggleLabel = _pinnedCollapsed ? '展开' : '收起';
    const dragHint = (!_pinnedCollapsed && _pinnedSort === 'order' && pinned.length > 1)
        ? '<span class="mv-drag-tip">可按住 ⋮⋮ 拖动排序</span>' : '';
    const $title = $(`
      <div class="mv-sec-title mv-sec-collapsible" title="点击收起或展开置顶区块">
        <span class="mv-vault-arrow">${arrow}</span>
        <span>📌 置顶区块 (${pinned.length})</span>
        ${dragHint}
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
            const hint = (_searchQuery.trim() || _activeTagFilter)
                ? '未找到匹配的置顶记忆'
                : '无置顶记忆';
            $sec.append(`<div class="mv-empty-hint">${hint}</div>`);
        } else {
            const allowDrag = _pinnedSort === 'order' && pinned.length > 1;
            pinned.forEach((e, i) => $sec.append(buildItem(e, {
                showPinOrder: true,
                allowDrag,
                isFirst: i === 0,
                isLast: i === pinned.length - 1,
                section: 'pinned',
            })));
        }
    }
    return $sec;
}

// ─── 最近N条区块（按楼层排序） ────────────────────────────────────────────
function buildRecentSection(list) {
    const n        = _settings.recentN ?? 5;
    const unpinned = getRecentUnpinned(list);
    const send     = n === 0 ? unpinned : unpinned.slice(Math.max(0, unpinned.length - n));

    const $sec = $('<div class="mv-section">');
    $sec.append(`<div class="mv-sec-title">📋 最近记忆 (${send.length})<span class="mv-toggle-arrow">按楼层排序</span></div>`);

    send.forEach(e => $sec.append(buildItem(e, { section:'recent' })));

    if (!unpinned.length) {
        const hint = (_searchQuery.trim() || _activeTagFilter)
            ? '未找到匹配的记忆（可清除搜索或标签筛选）'
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

// ─── 记忆库区块（未置顶且不在最近 N 条里的记忆） ──────────────────────────
function buildVaultSection(list) {
    const n        = _settings.recentN ?? 5;
    const unpinned = getRecentUnpinned(list);
    const recentSend = n === 0 ? unpinned : unpinned.slice(Math.max(0, unpinned.length - n));
    const recentSendIds = new Set(recentSend.map(e => e.id));

    const vaultItems = unpinned.filter(e => !recentSendIds.has(e.id));

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

// ─── 绑定置顶拖拽（PC 鼠标 + 手机触摸） ───────────────────────────────────
function bindPinnedDragEvents($item, entry) {
    $item.attr('draggable', 'true').attr('data-pinned-drag', '1');

    // PC HTML5 Drag & Drop
    $item.on('dragstart', function(e) {
        _draggingId = entry.id;
        $(this).addClass('mv-dragging');
        if (e.originalEvent?.dataTransfer) {
            e.originalEvent.dataTransfer.effectAllowed = 'move';
            e.originalEvent.dataTransfer.setData('text/plain', entry.id);
        }
    });

    $item.on('dragover', function(e) {
        if (!_draggingId || _draggingId === entry.id) return;
        e.preventDefault();
        const rect = this.getBoundingClientRect();
        const isTop = (e.originalEvent.clientY - rect.top) < rect.height / 2;
        $('.mv-item').removeClass('mv-drag-over-top mv-drag-over-bottom');
        $(this).addClass(isTop ? 'mv-drag-over-top' : 'mv-drag-over-bottom');
    });

    $item.on('dragleave', function() {
        $(this).removeClass('mv-drag-over-top mv-drag-over-bottom');
    });

    $item.on('drop', function(e) {
        e.preventDefault();
        if (!_draggingId || _draggingId === entry.id) return;
        const rect = this.getBoundingClientRect();
        const insertBefore = (e.originalEvent.clientY - rect.top) < rect.height / 2;
        const dragged = _draggingId;
        _draggingId = null;
        $('.mv-item').removeClass('mv-dragging mv-drag-over-top mv-drag-over-bottom');
        if (reorderPinned(_vaultId, dragged, entry.id, insertBefore)) {
            triggerSave();
            updateInjection(_vaultId, _settings);
            renderAll();
            setStatus('✅ 已调整置顶顺序');
        }
    });

    $item.on('dragend', function() {
        _draggingId = null;
        $('.mv-item').removeClass('mv-dragging mv-drag-over-top mv-drag-over-bottom');
    });

    // 手机端触摸拖拽（仅按住 ⋮⋮ 手柄触发，不影响正常滑动滚动）
    let touchTargetId = null;
    let touchInsertBefore = true;
    const $handle = $item.find('.mv-drag-handle');

    $handle.on('touchstart', function(e) {
        e.stopPropagation();
        _draggingId = entry.id;
        touchTargetId = null;
        $item.addClass('mv-dragging');
    });

    $handle.on('touchmove', function(e) {
        if (!_draggingId) return;
        e.preventDefault();
        const touch = e.originalEvent.touches?.[0];
        if (!touch) return;
        const el = document.elementFromPoint(touch.clientX, touch.clientY);
        const $target = el ? $(el).closest('.mv-item[data-pinned-drag="1"]') : $();
        $('.mv-item').removeClass('mv-drag-over-top mv-drag-over-bottom');
        if ($target.length && $target.data('id') !== _draggingId) {
            const rect = $target[0].getBoundingClientRect();
            touchInsertBefore = (touch.clientY - rect.top) < rect.height / 2;
            touchTargetId = String($target.data('id'));
            $target.addClass(touchInsertBefore ? 'mv-drag-over-top' : 'mv-drag-over-bottom');
        } else {
            touchTargetId = null;
        }
    });

    $handle.on('touchend touchcancel', function() {
        const dragged = _draggingId;
        const target = touchTargetId;
        _draggingId = null;
        touchTargetId = null;
        $('.mv-item').removeClass('mv-dragging mv-drag-over-top mv-drag-over-bottom');
        if (dragged && target && dragged !== target) {
            if (reorderPinned(_vaultId, dragged, target, touchInsertBefore)) {
                triggerSave();
                updateInjection(_vaultId, _settings);
                renderAll();
                setStatus('✅ 已调整置顶顺序');
            }
        }
    });
}

// ─── 单条记忆 ─────────────────────────────────────────────────────────────
function buildItem(entry, opts={}) {
    const { muted=false, showPinOrder=false, allowDrag=false, isFirst=false, isLast=false, section } = opts;
    const expanded   = _expandedIds.has(entry.id);
    const isSelected = _selectedIds.has(entry.id);
    const zones      = getZones();

    const highlighted = _highlightIds.has(entry.id);
    const $item = $(`<div class="mv-item${muted?' mv-muted':''}${entry.pinned?' mv-pinned':''}${highlighted?' mv-highlight':''}" data-id="${esc(entry.id)}">`);

    // 全部视图下配置了多分区时显示分区小徽章
    let zoneBadgeHtml = '';
    if (zones.length > 1 && _activeZone === 'all') {
        const zId = getEntryZoneId(entry, zones);
        const zObj = zones.find(z => z.id === zId);
        if (zObj) zoneBadgeHtml = `<span class="mv-zone-badge">${esc(zObj.name)}</span>`;
    }

    const tagsHtml = (entry.tags||[]).map(t => {
        const activeCls = _activeTagFilter === t ? ' mv-tag-active' : '';
        return `<span class="mv-tag mv-tag-clickable${activeCls}" data-tag="${esc(t)}" title="点击按此标签筛选">#${esc(t)}</span>`;
    }).join(' ');

    const dragHandleHtml = allowDrag ? '<span class="mv-drag-handle" title="按住上下拖动排序">⋮⋮</span>' : '';

    const previewText = (entry.content || '').replace(/\s+/g, ' ').trim();
    $item.append(`
      <div class="mv-item-top${expanded ? ' mv-item-top-expanded' : ''}">
        <div class="mv-item-main-row">
          ${dragHandleHtml}
          <input type="checkbox" class="mv-checkbox" data-id="${esc(entry.id)}" ${isSelected?'checked':''}>
          ${expanded
            ? `<div class="mv-content-full mv-content-inline">${esc(entry.content)}</div>`
            : `<div class="mv-preview-2line">${esc(previewText || '（无内容）')}</div>`
          }
          <button class="mv-expand-arrow" data-id="${esc(entry.id)}">${expanded?'▲':'▼'}</button>
        </div>
        <div class="mv-item-meta-row${expanded ? ' mv-item-meta-expanded' : ''}">
          <span class="mv-floor">#${entry.linkedMessageId !== null && entry.linkedMessageId !== undefined ? entry.linkedMessageId + 1 : '—'}</span>
          ${zoneBadgeHtml}
          <span class="mv-date">${esc(entry.date)}</span>
          <span class="mv-imp">${(entry.importance||0).toFixed(1)}</span>
          <span class="mv-tags">${tagsHtml}</span>
        </div>
      </div>
    `);

    if (expanded) {

        if (showPinOrder) {
            const $ord = $(`
              <div class="mv-order-row">
                <label style="font-size:11px;color:#8B7355;">序号:</label>
                <input type="number" class="mv-num-input mv-pin-order-input" value="${entry.pinnedOrder ?? ''}" placeholder="默认楼层" data-id="${esc(entry.id)}">
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

    if (allowDrag) bindPinnedDragEvents($item, entry);

    // 点击标签胶囊直接筛选
    $item.find('.mv-tag-clickable').on('click', function(e) {
        e.stopPropagation();
        const tag = String($(this).data('tag') || '');
        if (!tag) return;
        _activeTagFilter = (_activeTagFilter === tag) ? null : tag;
        renderAll();
    });

    $item.find('.mv-drag-handle').on('click', e => e.stopPropagation());

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
        const ok = restoreOneToChat(_vaultId, entry.id, getZones());
        if (ok) {
            if (_settings.autoCleanAfterRestore) {
                deleteMemory(_vaultId, entry.id);
            }
            _mvRefreshMsgs([entry.linkedMessageId]);
            _mvSaveChat();
            triggerSave(); updateInjection(_vaultId, _settings); renderAll(); setStatus('✅ 已还原并刷新楼层');
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

    const zones = getZones();
    const curZoneId = getEntryZoneId(entry, zones);
    const zoneSelectHtml = zones.length > 1
        ? `<div style="display:flex;align-items:center;gap:8px;margin-top:4px;">
             <label style="font-size:11px;color:#5D4E37;">所属分区:</label>
             <select class="mv-select mv-edit-zone-select" style="flex:1;">
               ${zones.map(z => `<option value="${esc(z.id)}" ${z.id === curZoneId ? 'selected' : ''}>${esc(z.name)} (&lt;${esc(z.tag)}&gt;)</option>`).join('')}
             </select>
           </div>`
        : '';

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
        ${zoneSelectHtml}
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
        const newZoneId = zones.length > 1 ? ($box.find('.mv-edit-zone-select').val() || curZoneId) : curZoneId;

        const floorChanged = newLinkedId !== entry.linkedMessageId;
        if (floorChanged) {
            const list = loadMemories(_vaultId);
            const filtered = list.filter(e => e.id !== entry.id);
            saveMemories(_vaultId, filtered);
            const newEntry = addMemoryAtFloor(_vaultId, {
                ...entry,
                content, tags, importance: imp, date,
                zoneId: newZoneId,
                linkedMessageId: newLinkedId,
            });
            _expandedIds.add(newEntry.id);
        } else {
            updateMemory(_vaultId, entry.id, { content, tags, importance: imp, date, zoneId: newZoneId });
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

    const zones = getZones();
    const defaultZone = (_activeZone !== 'all' && zones.find(z => z.id === _activeZone)) || zones[0];
    const today = new Date().toISOString().slice(0, 10);
    const defImp = _settings.defaultImportance ?? 0.5;
    const defaultPinChecked = _activeTab === 'pinned' || Boolean(defaultZone.defaultPinned);

    const zoneSelectHtml = zones.length > 1
        ? `<div style="display:flex;align-items:center;gap:8px;margin-top:4px;">
             <label style="font-size:11px;color:#5D4E37;">所属分区:</label>
             <select class="mv-select mv-new-zone" style="flex:1;">
               ${zones.map(z => `<option value="${esc(z.id)}" ${z.id === defaultZone.id ? 'selected' : ''}>${esc(z.name)} (&lt;${esc(z.tag)}&gt;)</option>`).join('')}
             </select>
           </div>`
        : '';

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
              <input type="checkbox" class="mv-new-pinned" ${defaultPinChecked ? 'checked' : ''}> 直接置顶
            </label>
          </div>
          ${zoneSelectHtml}
          <div class="mv-modal-actions">
            <button class="mv-btn mv-btn-cancel">取消</button>
            <button class="mv-btn mv-btn-primary">保存</button>
          </div>
        </div>
      </div>
    `);

    const $picker = buildPresetTagsPicker($card.find('.mv-edit-tags-input'));
    if ($picker) $card.find('.mv-preset-picker-slot').append($picker);

    $card.find('.mv-new-zone').on('change', function() {
        const z = zones.find(item => item.id === $(this).val());
        if (z) $card.find('.mv-new-pinned').prop('checked', Boolean(z.defaultPinned) || _activeTab === 'pinned');
    });

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
        const zoneId = zones.length > 1 ? ($card.find('.mv-new-zone').val() || defaultZone.id) : defaultZone.id;

        const fields = { content, tags, importance: imp, date, linkedMessageId, pinned, zoneId, source: 'manual' };
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

    // 新增分区
    $('#mv-zone-add-btn').on('click', () => {
        const zones = getZones();
        const isSecond = zones.length === 1;
        zones.push({
            id: 'zone_' + Date.now().toString(36),
            name: isSecond ? '大总结' : `分区${zones.length + 1}`,
            tag: isSecond ? 'Summary' : `Mem${zones.length + 1}`,
            defaultPinned: isSecond,
        });
        _settings.zones = zones;
        triggerSave();
        renderZonesEditor();
    });

    // 停用横幅快捷开启
    $('#mv-quick-enable-btn').on('click', () => {
        $('#mv-set-enabled').prop('checked', true).trigger('change');
        renderAll();
        setStatus('✅ 已开启记忆注入');
    });

    // 清除标签筛选
    $('#mv-tag-filter-clear').on('click', () => {
        _activeTagFilter = null;
        renderAll();
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

    $('#mv-sel-all').on('click', () => {
        getCurrentTabVisibleIds().forEach(id => _selectedIds.add(id));
        renderAll();
        syncMultibar();
    });
    $('#mv-sel-none').on('click', () => { _selectedIds.clear(); renderAll(); syncMultibar(); });

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

    $('#mv-scan-cancel').on('click', () => $('#mv-scan-modal').removeClass('mv-modal-active'));
    $('#mv-scan-confirm').on('click', commitScanImport);

    $('#mv-pgup').on('click', () => {
        const $body = $('#mv-body');
        $body.scrollTop($body.scrollTop() - $body.height() * 0.8);
    });
    $('#mv-pgdn').on('click', () => {
        const $body = $('#mv-body');
        $body.scrollTop($body.scrollTop() + $body.height() * 0.8);
    });

    $(document).on('click', '#mv-save-settings-btn', () => {
        triggerSave();
        setStatus('✅ 设置已储存');
    });
}

function openMergeModal() {
    const list = loadMemories(_vaultId);
    const selected = list.filter(e => _selectedIds.has(e.id));
    selected.sort((a, b) => (a.linkedMessageId ?? Infinity) - (b.linkedMessageId ?? Infinity));
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

// ─── 手动扫描（支持同时扫描所有配置分区） ─────────────────────────────────
export function openScanModal() {
    try {
        if (!_vaultId) { setStatus('⚠️ 当前无聊天'); return; }
        const ctx  = SillyTavern.getContext();
        const chat = ctx?.chat;
        if (!chat?.length) { setStatus('⚠️ 无聊天数据'); return; }

        const zones = getZones();
        const existing = loadMemories(_vaultId);
        const excludeThreshold = _settings.scanExcludeRecentN
            ? chat.length - (_settings.autoCaptureExcludeN ?? 0)
            : chat.length;
        const newBlocks = [];
        chat.forEach((msg, mi) => {
            if (mi >= excludeThreshold) return;
            const blocks = extractBlocksForZones(msg.mes || '', zones);
            for (const b of blocks) {
                if (!isBlockAlreadyStored(existing, mi, b)) {
                    newBlocks.push({ mi, content: b.innerText, full: b.originalText, zoneName: b.zoneName });
                }
            }
        });

        const tagSummary = zones.map(z => `<${z.tag}>`).join(' / ');
        if (!newBlocks.length) { setStatus(`未找到新的 ${tagSummary} 块`); return; }

        const floors    = newBlocks.map(b => b.mi + 1);
        const minFloor  = Math.min(...floors);
        const maxFloor  = Math.max(...floors);
        const count     = newBlocks.length;

        if (!confirm(`捕获到第${minFloor}楼到第${maxFloor}楼共 ${count} 个标签块（${tagSummary}），是否导入？`)) return;

        const added = doImportBlocks(newBlocks);
        setStatus(`✅ 导入 ${added} 条并已刷新楼层`);
    } catch(e) { setStatus('⚠️ 扫描失败: '+e.message); }
}

function doImportBlocks(blocksToImport) {
    const ctx   = SillyTavern.getContext();
    const chat  = ctx?.chat;
    if (!chat || !_vaultId) return 0;

    const zones     = getZones();
    const existing  = loadMemories(_vaultId);
    saveDbSnapshot(_vaultId);
    const chatSnap  = {};
    const byMsg     = {};
    blocksToImport.forEach(b => { (byMsg[b.mi] = byMsg[b.mi]||[]).push(b); });

    let added = 0;
    const changedMesIds = [];
    const allEntries = [...existing];

    for (const miStr of Object.keys(byMsg)) {
        const mi  = parseInt(miStr, 10);
        const msg = chat[mi];
        if (!msg) continue;
        const originalMes = msg.mes;
        const { newEntries, modifiedText } = _mvScanAndStore(_vaultId, mi, originalMes, allEntries, _settings.defaultImportance ?? 0.5, zones);
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
        changedMesIds.push(mi);
        added += newEntries.length;
    }

    if (added > 0) {
        saveMemories(_vaultId, allEntries);
        saveChatSnapshot(_vaultId, chatSnap, true);
        _mvRefreshMsgs(changedMesIds);
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

// 注入回调（index.js 设置）
let _mvScanAndStore = null;
let _mvSaveChat     = () => {};
let _mvRefreshMsgs  = () => {};
export function setUiHelpers(scanFn, saveChatFn, refreshMsgsFn = () => {}) {
    _mvScanAndStore = scanFn;
    _mvSaveChat     = saveChatFn;
    _mvRefreshMsgs  = refreshMsgsFn;
}

// ─── 外部调用 ─────────────────────────────────────────────────────────────
export function onNewMemoriesAdded(count) {
    if (!$('#mv-panel').hasClass('mv-active')) return;
    renderAll(); setStatus(`✅ 自动入库 ${count} 条`);
}

export function onChatChanged(statusMsg = '') {
    _selectedIds.clear(); _expandedIds.clear(); _activeTagFilter = null;
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
    renderZonesEditor();
}