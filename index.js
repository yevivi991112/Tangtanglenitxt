/**
 * index.js — Memory Vault 扩展主入口
 * SillyTavern 1.18 extension — ES Module (type:module in ST)
 */

import {
    mvRead, mvWrite, SETTINGS_STORE_KEY,
    StorageBackend, setBackend, testBackend,
    exportAll, exportChat, importData,
} from './src/storage.js';

import {
    getCurrentChatId, loadMemories, saveMemories,
    saveDbSnapshot, markSourceDeleted,
    restoreAllToChat, restoreDbSnapshot, getChatSnapshot,
    scanAndStoreMessage,
} from './src/memory.js';

import { updateInjection, clearInjection } from './src/inject.js';

import {
    initPanel, showPanel, hidePanel, togglePanel,
    setUiChatId, setUiSettings, setUiSaveCallback, setUiHelpers,
    renderAll, onNewMemoriesAdded, onChatChanged, openScanModal,
} from './src/ui.js';

// ─── 全局设置默认值 ───────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
    enabled:              true,
    backend:              StorageBackend.EXT,
    injectionPosition:    'in_chat',
    pinnedFirst:          true,
    recentN:              5,
    defaultImportance:    0.5,
    presetTags:           [],
    autoCapture:          false,
    autoCaptureExcludeN:  6,
};

let settings = { ...DEFAULT_SETTINGS };
let chatId   = null;

// ─── 设置持久化 ───────────────────────────────────────────────────────────

function loadSettings() {
    let saved = null;
    try {
        const ctx = SillyTavern.getContext();
        saved = ctx?.extensionSettings?.memory_vault?.settings ?? null;
    } catch {}
    if (!saved) {
        try {
            const raw = localStorage.getItem('mv_settings');
            if (raw) saved = JSON.parse(raw);
        } catch {}
    }
    if (saved) settings = { ...DEFAULT_SETTINGS, ...saved };
    setBackend(settings.backend);
}

function savePluginSettings() {
    mvWrite(SETTINGS_STORE_KEY, settings);
    setUiSettings(settings);
}

// ─── saveChat 工具 ────────────────────────────────────────────────────────

function doSaveChat() {
    try {
        const ctx = SillyTavern.getContext();
        if (typeof ctx?.saveChat === 'function') { ctx.saveChat(); return; }
    } catch {}
    if (typeof saveChat === 'function') saveChat();
}

// ─── 聊天切换 ─────────────────────────────────────────────────────────────

function handleChatChanged() {
    chatId = getCurrentChatId();
    setUiChatId(chatId);
    clearInjection();
    if (chatId && settings.enabled) updateInjection(chatId, settings);
    onChatChanged();
    syncSettingsPanel();
}

// ─── 自动扫描新消息 ───────────────────────────────────────────────────────

function handleNewMessage(mesid) {
    if (!settings.enabled || !chatId) return;
    if (!settings.autoCapture) return;
    try {
        const ctx = SillyTavern.getContext();
        const chat = ctx?.chat;
        if (!chat?.length) return;

        const existing = loadMemories(chatId);
        const threshold = chat.length - settings.autoCaptureExcludeN;
        let totalNew = 0;

        for (let i = 0; i < threshold; i++) {
            const msg = chat[i];
            if (!msg?.mes) continue;
            if (!/<Lenitxt>/i.test(msg.mes)) continue;

            const { newEntries, modifiedText } = scanAndStoreMessage(
                chatId, i, msg.mes, [...existing], settings.defaultImportance
            );
            if (!newEntries.length) continue;

            if (totalNew === 0) saveDbSnapshot(chatId);

            // 按楼层顺序插入内存数组（最后统一 saveMemories）
            for (const entry of newEntries) {
                let insertPos = existing.length;
                for (let j = existing.length - 1; j >= 0; j--) {
                    if (existing[j].linkedMessageId !== null && existing[j].linkedMessageId !== undefined &&
                        existing[j].linkedMessageId <= entry.linkedMessageId) {
                        insertPos = j + 1;
                        break;
                    }
                }
                const firstBigger = existing.findIndex(e => e.linkedMessageId !== null && e.linkedMessageId !== undefined && e.linkedMessageId > entry.linkedMessageId);
                if (firstBigger !== -1 && insertPos === existing.length) insertPos = firstBigger;
                existing.splice(insertPos, 0, entry);
            }
            msg.mes = modifiedText;
            totalNew += newEntries.length;
        }

        if (totalNew > 0) {
            saveMemories(chatId, existing);
            doSaveChat();
            updateInjection(chatId, settings);
            onNewMemoriesAdded(totalNew);
        }
    } catch (e) {
        console.warn('[MemoryVault] handleNewMessage error:', e);
    }
}

// ─── 消息删除事件 ─────────────────────────────────────────────────────────

function handleMessageDeleted(mesid) {
    if (!chatId) return;
    const changed = markSourceDeleted(chatId, mesid);
    if (changed) {
        updateInjection(chatId, settings);
        renderAll();
    }
}

// ─── 提取 mesid（ST 事件参数格式不稳定） ─────────────────────────────────

function extractMesid(arg) {
    if (typeof arg === 'number') return arg;
    if (typeof arg === 'object' && arg !== null) {
        return arg.messageId ?? arg.mesid ?? arg.index ?? null;
    }
    return null;
}

// ─── 注册 ST 事件 ─────────────────────────────────────────────────────────

function registerEvents() {
    let installed = false;

    function tryInstall() {
        if (installed) return true;
        let ctx;
        try { ctx = SillyTavern.getContext(); } catch { return false; }
        const es    = ctx.eventSource;
        const types = ctx.event_types ?? ctx.eventTypes;
        if (!es || !types) return false;

        es.on(types.CHARACTER_MESSAGE_RENDERED, (arg) => {
            const id = extractMesid(arg);
            if (id !== null) handleNewMessage(id);
        });

        es.on(types.MESSAGE_DELETED, (arg) => {
            const id = extractMesid(arg);
            if (id !== null) handleMessageDeleted(id);
        });

        es.on(types.CHAT_CHANGED, () => {
            setTimeout(handleChatChanged, 300);
        });

        if (types.MESSAGE_SWIPED) {
            es.on(types.MESSAGE_SWIPED, (arg) => {
                const id = extractMesid(arg);
                if (id !== null) handleMessageDeleted(id);
            });
        }

        installed = true;
        console.log('[MemoryVault] ✅ 事件钩子已注册');
        return true;
    }

    if (tryInstall()) return;
    let retries = 0;
    const iv = setInterval(() => {
        retries++;
        if (tryInstall() || retries >= 20) clearInterval(iv);
    }, 1500);
}

// ─── 设置面板同步 ─────────────────────────────────────────────────────────

function syncSettingsPanel() {
    jQuery('#mv-set-enabled').prop('checked', settings.enabled);
    jQuery('#mv-set-backend').val(settings.backend);
    jQuery('#mv-set-position').val(settings.injectionPosition);
    jQuery('#mv-set-pinned-first').prop('checked', settings.pinnedFirst);
    jQuery('#mv-set-recent-n').val(settings.recentN);
    jQuery('#mv-set-def-imp').val(settings.defaultImportance);
    jQuery('#mv-set-auto-capture').prop('checked', settings.autoCapture);
    jQuery('#mv-set-auto-capture-n').val(settings.autoCaptureExcludeN);
    renderPresetTags();
}

function renderPresetTags() {
    const $box = jQuery('#mv-preset-tags-box').empty();
    (settings.presetTags ?? []).forEach((tag, i) => {
        const $t = jQuery(`<span class="mv-preset-tag">#${jQuery('<div>').text(tag).html()} <button class="mv-preset-tag-del" data-idx="${i}">×</button></span>`);
        $box.append($t);
    });
}

// ─── 设置面板事件（事件委托，防时序问题） ────────────────────────────────

function bindSettingsPanel() {
    const doc = jQuery(document);

    doc.on('change', '#mv-set-enabled', function() {
        settings.enabled = this.checked;
        savePluginSettings();
        if (!settings.enabled) clearInjection();
        else if (chatId) updateInjection(chatId, settings);
    });

    doc.on('change', '#mv-set-backend', function() {
        settings.backend = jQuery(this).val();
        setBackend(settings.backend);
        savePluginSettings();
    });

    doc.on('change', '#mv-set-position', function() {
        settings.injectionPosition = jQuery(this).val();
        savePluginSettings();
        if (chatId && settings.enabled) updateInjection(chatId, settings);
    });

    doc.on('change', '#mv-set-pinned-first', function() {
        settings.pinnedFirst = this.checked;
        savePluginSettings();
        if (chatId && settings.enabled) updateInjection(chatId, settings);
    });

    doc.on('change input', '#mv-set-recent-n', function() {
        const n = parseInt(jQuery(this).val(), 10);
        if (!isNaN(n) && n >= 0) {
            settings.recentN = n;
            savePluginSettings();
            if (chatId && settings.enabled) updateInjection(chatId, settings);
        }
    });

    doc.on('change input', '#mv-set-def-imp', function() {
        const v = parseFloat(jQuery(this).val());
        if (!isNaN(v)) { settings.defaultImportance = Math.min(1, Math.max(0, v)); savePluginSettings(); }
    });

    // 测试存储后端
    doc.on('click', '#mv-test-ext', async () => {
        const ok = await testBackend(StorageBackend.EXT);
        jQuery('#mv-test-ext-result').text(ok ? '✅ 可用' : '❌ 不可用');
    });
    doc.on('click', '#mv-test-local', async () => {
        const ok = await testBackend(StorageBackend.LOCAL);
        jQuery('#mv-test-local-result').text(ok ? '✅ 可用' : '❌ 不可用');
    });

    // 预设标签
    doc.on('click', '#mv-preset-tag-add', () => {
        const val = jQuery('#mv-preset-tag-input').val().trim();
        if (!val) return;
        if (!settings.presetTags) settings.presetTags = [];
        settings.presetTags.push(val);
        jQuery('#mv-preset-tag-input').val('');
        savePluginSettings();
        renderPresetTags();
    });
    doc.on('click', '.mv-preset-tag-del', function() {
        const idx = parseInt(jQuery(this).data('idx'));
        settings.presetTags.splice(idx, 1);
        savePluginSettings();
        renderPresetTags();
    });

    // 导出
    doc.on('click', '#mv-export-all', () => {
        const data = exportAll();
        downloadJson(data, 'memory-vault-all.json');
    });
    doc.on('click', '#mv-export-chat', () => {
        if (!chatId) { alert('⚠️ 当前无聊天'); return; }
        downloadJson(exportChat(chatId), `memory-vault-${chatId}.json`);
    });

    // 导入
    doc.on('click', '#mv-import-btn', () => jQuery('#mv-import-file').click());
    doc.on('change', '#mv-import-file', function() {
        const file = this.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            try {
                const dump = JSON.parse(ev.target.result);
                const mode = prompt('导入模式：输入 merge 合并，输入 overwrite 覆盖', 'merge');
                if (!mode) return;
                importData(dump, mode.trim() === 'overwrite' ? 'overwrite' : 'merge');
                renderAll();
                alert('✅ 导入完成');
            } catch { alert('❌ 文件解析失败'); }
        };
        reader.readAsText(file);
        this.value = '';
    });

    // 一键还原
    doc.on('click', '#mv-restore-all-btn', () => {
        if (!chatId) return;
        if (!confirm('将所有有来源的记忆还原到对应楼层末尾？')) return;
        const count = restoreAllToChat(chatId);
        doSaveChat();
        renderAll();
        alert(`✅ 已还原 ${count} 条记忆到来源楼层，这些记忆已移至遗弃区备份。\n如不需要可在遗弃区全选删除。`);
    });

    // 聊天快照恢复
    doc.on('click', '#mv-restore-chat-snap-btn', () => {
        if (!chatId) return;
        const snap = getChatSnapshot(chatId);
        if (!Object.keys(snap).length) { alert('无聊天快照'); return; }
        if (!confirm('⚠️ 将被修改的消息恢复到提取前的状态？')) return;
        try {
            const ctx = SillyTavern.getContext();
            for (const [mesid, text] of Object.entries(snap)) {
                const msg = ctx?.chat?.[parseInt(mesid)];
                if (msg) msg.mes = text;
            }
            doSaveChat();
            alert('✅ 聊天快照已恢复');
        } catch (e) { alert('❌ 恢复失败: ' + e.message); }
    });

    // 记忆库快照恢复
    doc.on('click', '#mv-restore-db-snap-btn', () => {
        if (!chatId) return;
        if (!confirm('⚠️ 将记忆库恢复到最近一次写库前的状态？')) return;
        const ok = restoreDbSnapshot(chatId);
        if (ok) { renderAll(); alert('✅ 记忆库快照已恢复'); }
        else alert('无记忆库快照');
    });

    // 手动扫描
    doc.on('click', '#mv-scan-chat-btn', openScanModal);

    // 自动捕获
    doc.on('change', '#mv-set-auto-capture', function() {
        settings.autoCapture = this.checked;
        savePluginSettings();
    });
    doc.on('change input', '#mv-set-auto-capture-n', function() {
        const n = parseInt(jQuery(this).val(), 10);
        if (!isNaN(n) && n >= 0) {
            settings.autoCaptureExcludeN = n;
            savePluginSettings();
        }
    });

    // 抽屉设置储存应用
    doc.on('click', '#mv-drawer-save-btn', () => {
        savePluginSettings();
        jQuery('#mv-drawer-save-btn').text('✅ 已储存').delay(1500).queue(function(next) {
            jQuery(this).text('💾 储存应用'); next();
        });
    });
}

// ─── 工具：下载 JSON ──────────────────────────────────────────────────────

function downloadJson(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
}

// ─── 菜单按钮（ST 1.18 标准方式） ────────────────────────────────────────

function addMenuButton() {
    const $btn = jQuery('<div class="list-group-item flex-container flexGap5" id="mv-menu-btn">')
        .html('<i class="fa-solid fa-vault"></i><span>糖🍬的记忆管理</span>')
        .on('click', togglePanel);

    // 优先追加到扩展菜单，兜底追加到 body
    if (jQuery('#extensionsMenu').length) {
        jQuery('#extensionsMenu').append($btn);
    } else {
        jQuery('body').append($btn);
    }
}

// ─── 入口 ─────────────────────────────────────────────────────────────────

(function waitAndBoot() {
    const waitIv = setInterval(() => {
        if (typeof jQuery === 'undefined') return;
        if (typeof SillyTavern === 'undefined') return;
        if (!jQuery('#extensionsMenu').length) return;
        clearInterval(waitIv);

        try {
            loadSettings();
        } catch (e) {
            console.warn('[MemoryVault] loadSettings error:', e);
        }

        initPanel();
        setUiHelpers(scanAndStoreMessage, doSaveChat);
        setUiSettings(settings);
        setUiSaveCallback(savePluginSettings);
        bindSettingsPanel();
        addMenuButton();
        registerEvents();

        setTimeout(() => {
            chatId = getCurrentChatId();
            setUiChatId(chatId);
            if (chatId && settings.enabled) updateInjection(chatId, settings);
            syncSettingsPanel();
            console.log('[MemoryVault] ✅ v1.0.0 已加载，chatId:', chatId);
        }, 800);
    }, 500);
})();
