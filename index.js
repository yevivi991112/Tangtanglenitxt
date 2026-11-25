/**
 * index.js — Memory Vault 扩展主入口
 * SillyTavern 1.18 / 1.19+ extension — ES Module (type:module in ST)
 *
 * 设计不变量：
 * 1. 通过 chatMetadata + CHAT_RENAMED 双保险追踪当前聊天的 vaultId：
 *    - 酒馆内重命名聊天时自动无缝沿用原记忆库；
 *    - 创建分支（Branch）时自动复制一份独立记忆库，不串戏。
 * 2. 修改聊天楼层正文（自动捕获 / 手动扫描 / 还原 / 恢复聊天快照）后，
 *    必须调用 refreshChatMessages() 触发 ST 1.19+ updateMessageBlock 实时刷新楼层 DOM。
 * 3. 多分区捕获：单次扫描可同时捕获 settings.zones 中所有自定义标签块并按分区存储。
 */

import {
    mvWrite, SETTINGS_STORE_KEY,
    StorageBackend, setBackend, testBackend, migrateBackendData,
    exportAll, exportChat, importData,
} from './src/storage.js';

import {
    DEFAULT_ZONES, normalizeZones, hasAnyZoneTag,
    resolveActiveVault, loadMemories, saveMemories,
    saveDbSnapshot, saveChatSnapshot, markOutOfRangeDeleted,
    restoreAllToChat, restoreDbSnapshot, getChatSnapshot,
    scanAndStoreMessage, copyMemories,
} from './src/memory.js';

import { updateInjection, clearInjection } from './src/inject.js';

import {
    initPanel, togglePanel,
    setUiChatId, setUiSettings, setUiSaveCallback, setUiHelpers, setUiVaultBoundCallback,
    renderAll, onNewMemoriesAdded, onChatChanged, openScanModal, syncSettings, setStatus,
} from './src/ui.js';

// ─── 全局设置默认值 ───────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
    enabled:              true,
    backend:              StorageBackend.EXT,
    injectionPosition:    'in_chat',
    pinnedFirst:          true,
    recentN:              5,
    defaultImportance:    0.5,
    previewLines:         2,
    presetTags:           [],
    zones:                DEFAULT_ZONES.map(z => ({ ...z })),
    autoCapture:          false,
    autoCaptureExcludeN:  6,
    scanExcludeRecentN:   false,
    injectFormat:         'lenitxt',
    autoCleanAfterRestore: false,
    chatSwitchCopy:       'empty_only',
};

let settings      = { ...DEFAULT_SETTINGS };
let activeVaultId = null;
let recentRename  = null;

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
    settings.zones = normalizeZones(settings.zones);
    setBackend(settings.backend);
}

function savePluginSettings() {
    settings.zones = normalizeZones(settings.zones);
    mvWrite(SETTINGS_STORE_KEY, settings);
    setUiSettings(settings);
}

// ─── saveChat & 实时刷新楼层 DOM（ST 1.19+ updateMessageBlock） ──────────

function doSaveChat() {
    try {
        const ctx = SillyTavern.getContext();
        if (typeof ctx?.saveChat === 'function') {
            Promise.resolve(ctx.saveChat()).catch(e => console.warn('[MemoryVault] saveChat error:', e));
            return;
        }
    } catch {}
    if (typeof window !== 'undefined' && typeof window.saveChat === 'function') {
        Promise.resolve(window.saveChat()).catch(() => {});
    } else if (typeof saveChat === 'function') {
        Promise.resolve(saveChat()).catch(() => {});
    }
}

function refreshChatMessages(mesids) {
    try {
        const ctx = SillyTavern.getContext();
        if (!ctx?.chat || typeof ctx.updateMessageBlock !== 'function') return;
        const unique = [...new Set(mesids)].filter(id => typeof id === 'number' && !isNaN(id) && id >= 0 && ctx.chat[id]);
        for (const id of unique) {
            ctx.updateMessageBlock(id, ctx.chat[id], { rerenderMessage: true });
        }
    } catch (e) {
        console.warn('[MemoryVault] refreshChatMessages error:', e);
    }
}

// ─── 聊天切换 / 改名 / 分支处理 ───────────────────────────────────────────

let _chatChangeTimer = null;

function handleChatChanged() {
    const oldVaultId = activeVaultId;
    const resolved = resolveActiveVault(recentRename);
    const newVaultId = resolved.vaultId;

    if (resolved.action === 'renamed') {
        recentRename = null;
    }

    activeVaultId = newVaultId;
    setUiChatId(activeVaultId);
    clearInjection();

    let statusMsg = '';
    if (resolved.action === 'renamed') {
        statusMsg = '✅ 检测到聊天改名，已自动沿用原记忆库';
        console.log(`[MemoryVault] 聊天改名后自动沿用记忆库: ${activeVaultId}`);
    } else if (resolved.action === 'branched') {
        statusMsg = `✅ 检测到聊天分支，已自动复制 ${resolved.copiedCount || 0} 条记忆为独立库`;
        console.log(`[MemoryVault] 检测到分支，已复制 ${resolved.copiedCount || 0} 条记忆到新库: ${activeVaultId}`);
    } else if (
        resolved.action === 'new'
        && newVaultId
        && oldVaultId
        && newVaultId !== oldVaultId
        && settings.chatSwitchCopy !== 'never'
    ) {
        const srcMemories = loadMemories(oldVaultId);
        const dstMemories = loadMemories(newVaultId);
        const shouldPrompt = settings.chatSwitchCopy === 'always'
            ? srcMemories.length > 0
            : (srcMemories.length > 0 && dstMemories.length === 0);
        if (shouldPrompt) {
            if (confirm(`检测到聊天切换，是否从旧聊天复制 ${srcMemories.length} 条记忆到新聊天？`)) {
                copyMemories(oldVaultId, newVaultId);
                statusMsg = `✅ 已从旧聊天复制 ${srcMemories.length} 条记忆`;
                console.log(`[MemoryVault] 用户确认：已从 ${oldVaultId} 复制记忆到 ${newVaultId}`);
            }
        }
    }

    if (activeVaultId && settings.enabled) updateInjection(activeVaultId, settings);
    onChatChanged(statusMsg);
    syncSettings(settings);
}

function scheduleChatChanged(delayMs = 300) {
    if (_chatChangeTimer) clearTimeout(_chatChangeTimer);
    _chatChangeTimer = setTimeout(() => {
        _chatChangeTimer = null;
        handleChatChanged();
    }, delayMs);
}

// ─── 自动扫描新消息（支持多分区 + 实时刷新 DOM） ──────────────────────────

function handleNewMessage() {
    if (!settings.enabled || !activeVaultId) return;
    if (!settings.autoCapture) return;
    try {
        const ctx = SillyTavern.getContext();
        const chat = ctx?.chat;
        if (!chat?.length) return;

        const zones = normalizeZones(settings.zones);
        const existing = loadMemories(activeVaultId);
        const threshold = chat.length - settings.autoCaptureExcludeN;
        let totalNew = 0;
        const chatSnap = {};
        const changedMesIds = [];

        for (let i = 0; i < threshold; i++) {
            const msg = chat[i];
            if (!msg?.mes) continue;
            if (!hasAnyZoneTag(msg.mes, zones)) continue;

            const originalMes = msg.mes;
            const { newEntries, modifiedText } = scanAndStoreMessage(
                activeVaultId, i, originalMes, existing, settings.defaultImportance, zones
            );
            if (!newEntries.length) continue;

            if (totalNew === 0) saveDbSnapshot(activeVaultId);
            chatSnap[i] = originalMes;

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
            changedMesIds.push(i);
            totalNew += newEntries.length;
        }

        if (totalNew > 0) {
            saveMemories(activeVaultId, existing);
            saveChatSnapshot(activeVaultId, chatSnap, true);
            refreshChatMessages(changedMesIds);
            doSaveChat();
            updateInjection(activeVaultId, settings);
            onNewMemoriesAdded(totalNew);
        }
    } catch (e) {
        console.warn('[MemoryVault] handleNewMessage error:', e);
    }
}

// ─── 消息删除事件（适配 ST 1.19+：参数为删除后的 chat.length） ─────────────

function handleMessageDeleted(arg) {
    if (!activeVaultId) return;
    let chatLen = null;
    try {
        const ctx = SillyTavern.getContext();
        if (Array.isArray(ctx?.chat)) chatLen = ctx.chat.length;
    } catch {}
    if (chatLen === null && typeof arg === 'number') {
        chatLen = arg;
    }
    if (chatLen === null) return;

    const changed = markOutOfRangeDeleted(activeVaultId, chatLen);
    if (changed) {
        updateInjection(activeVaultId, settings);
        renderAll();
    }
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

        es.on(types.CHARACTER_MESSAGE_RENDERED, () => {
            handleNewMessage();
        });

        es.on(types.MESSAGE_DELETED, (arg) => {
            handleMessageDeleted(arg);
        });

        es.on(types.CHAT_CHANGED, () => {
            scheduleChatChanged(300);
        });

        if (types.CHAT_RENAMED) {
            es.on(types.CHAT_RENAMED, (data) => {
                if (data?.oldFileName && data?.newFileName) {
                    recentRename = {
                        oldFileName: String(data.oldFileName),
                        newFileName: String(data.newFileName),
                        ts: Date.now(),
                    };
                    scheduleChatChanged(150);
                }
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

// ─── 设置面板事件（事件委托，防时序问题） ────────────────────────────────

function bindSettingsPanel() {
    const doc = jQuery(document);

    doc.on('change', '#mv-set-enabled', function() {
        settings.enabled = this.checked;
        savePluginSettings();
        if (!settings.enabled) clearInjection();
        else if (activeVaultId) updateInjection(activeVaultId, settings);
    });

    doc.on('change', '#mv-set-backend', function() {
        settings.backend = jQuery(this).val();
        setBackend(settings.backend);
        savePluginSettings();
        handleChatChanged();
    });

    // 一键从另一存储后端迁移数据到当前后端
    doc.on('click', '#mv-migrate-backend-btn', () => {
        const toBackend = settings.backend;
        const fromBackend = toBackend === StorageBackend.EXT ? StorageBackend.LOCAL : StorageBackend.EXT;
        const fromLabel = fromBackend === StorageBackend.EXT ? '后端保存(ST数据)' : '浏览器保存(localStorage)';
        const toLabel   = toBackend === StorageBackend.EXT ? '后端保存(ST数据)' : '浏览器保存(localStorage)';
        if (!confirm(`确定将「${fromLabel}」中的所有记忆库合并迁移到当前的「${toLabel}」吗？\n（会自动按 ID 去重，不会覆盖现有数据，原后端数据也会保留）`)) {
            return;
        }
        const { vaultCount, entryCount } = migrateBackendData(fromBackend, toBackend);
        if (entryCount === 0) {
            alert(`未在「${fromLabel}」中发现需要新增迁移的记忆数据。`);
        } else {
            if (activeVaultId && settings.enabled) updateInjection(activeVaultId, settings);
            renderAll();
            alert(`✅ 迁移完成！共合并迁移 ${vaultCount} 个聊天库、新增 ${entryCount} 条记忆到「${toLabel}」。`);
        }
    });

    doc.on('change', '#mv-set-position', function() {
        settings.injectionPosition = jQuery(this).val();
        savePluginSettings();
        if (activeVaultId && settings.enabled) updateInjection(activeVaultId, settings);
    });

    doc.on('change', '#mv-set-pinned-first', function() {
        settings.pinnedFirst = this.checked;
        savePluginSettings();
        if (activeVaultId && settings.enabled) updateInjection(activeVaultId, settings);
    });

    doc.on('change input', '#mv-set-recent-n', function() {
        const n = parseInt(jQuery(this).val(), 10);
        if (!isNaN(n) && n >= 0) {
            settings.recentN = n;
            savePluginSettings();
            if (activeVaultId && settings.enabled) updateInjection(activeVaultId, settings);
        }
    });

    doc.on('change input', '#mv-set-def-imp', function() {
        const v = parseFloat(jQuery(this).val());
        if (!isNaN(v)) { settings.defaultImportance = Math.min(1, Math.max(0, v)); savePluginSettings(); }
    });

    doc.on('change input', '#mv-set-preview-lines', function() {
        const n = parseInt(jQuery(this).val(), 10);
        if (!isNaN(n) && n >= 1 && n <= 10) {
            settings.previewLines = n;
            savePluginSettings();
            renderAll();
        }
    });

    doc.on('change', '#mv-set-auto-clean-restore', function() {
        settings.autoCleanAfterRestore = this.checked;
        savePluginSettings();
    });

    doc.on('click', '#mv-test-ext', async () => {
        const ok = await testBackend(StorageBackend.EXT);
        jQuery('#mv-test-ext-result').text(ok ? '✅ 可用' : '❌ 不可用');
    });
    doc.on('click', '#mv-test-local', async () => {
        const ok = await testBackend(StorageBackend.LOCAL);
        jQuery('#mv-test-local-result').text(ok ? '✅ 可用' : '❌ 不可用');
    });

    doc.on('click', '#mv-preset-tag-add', () => {
        const val = jQuery('#mv-preset-tag-input').val().trim();
        if (!val) return;
        if (!settings.presetTags) settings.presetTags = [];
        settings.presetTags.push(val);
        jQuery('#mv-preset-tag-input').val('');
        savePluginSettings();
        syncSettings(settings);
    });
    doc.on('click', '.mv-preset-tag-del', function() {
        const idx = parseInt(jQuery(this).data('idx'), 10);
        settings.presetTags.splice(idx, 1);
        savePluginSettings();
        syncSettings(settings);
    });

    doc.on('click', '#mv-export-all', () => {
        const data = exportAll();
        downloadJson(data, 'memory-vault-all.json');
    });
    doc.on('click', '#mv-export-chat', () => {
        if (!activeVaultId) { alert('⚠️ 当前无聊天'); return; }
        downloadJson(exportChat(activeVaultId), `memory-vault-${activeVaultId}.json`);
    });

    doc.on('click', '#mv-import-btn', () => jQuery('#mv-import-file').click());
    doc.on('change', '#mv-import-file', function() {
        const file = this.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            try {
                const dump = JSON.parse(ev.target.result);
                const merge = confirm('导入模式选择：\n\n点击「确定」= 合并模式（保留现有记忆，追加新记忆）\n点击「取消」= 进入覆盖模式确认');
                let importMode;
                if (merge) {
                    importMode = 'merge';
                } else {
                    const overwrite = confirm('⚠️ 覆盖模式将替换同 chatId 下的所有现有记忆！\n\n确定要使用覆盖模式吗？');
                    if (!overwrite) return;
                    importMode = 'overwrite';
                }
                const result = importData(dump, importMode);
                if (!result.success) {
                    alert('❌ 导入失败：' + result.error);
                    return;
                }
                const importedKeys = result.importedKeys || [];
                const currentKey = activeVaultId ? 'chat_' + activeVaultId : null;
                const hasCurrentChat = currentKey && importedKeys.includes(currentKey);

                if (activeVaultId && settings.enabled) updateInjection(activeVaultId, settings);
                renderAll();

                if (hasCurrentChat) {
                    alert('✅ 导入完成，当前聊天的记忆已更新');
                } else {
                    const chatCount = importedKeys.length;
                    alert(`✅ 导入完成（共 ${chatCount} 个聊天的记忆）。\n当前聊天无直接匹配记忆，可点击面板右上角「🗂️ 历史记忆库管理」一键绑定或合并到当前聊天。`);
                }
            } catch { alert('❌ 文件解析失败：不是有效的 JSON 文件'); }
        };
        reader.readAsText(file);
        this.value = '';
    });

    // 一键还原（带实时刷新 DOM）
    doc.on('click', '#mv-restore-all-btn', () => {
        if (!activeVaultId) return;
        if (!confirm('将所有有来源的记忆还原到对应楼层末尾？')) return;
        const { count, mesids } = restoreAllToChat(activeVaultId);
        refreshChatMessages(mesids);
        doSaveChat();
        updateInjection(activeVaultId, settings);
        renderAll();
        alert(`✅ 已还原 ${count} 条记忆到来源楼层并实时刷新显示，这些记忆已移至遗弃区备份。\n如不需要可在遗弃区全选删除。`);
    });

    // 聊天快照恢复（带实时刷新 DOM）
    doc.on('click', '#mv-restore-chat-snap-btn', () => {
        if (!activeVaultId) return;
        const snap = getChatSnapshot(activeVaultId);
        if (!Object.keys(snap).length) { alert('无聊天快照'); return; }
        if (!confirm('⚠️ 将被修改的消息恢复到提取前的状态？')) return;
        try {
            const ctx = SillyTavern.getContext();
            const restoredIds = [];
            for (const [mesid, text] of Object.entries(snap)) {
                const idx = parseInt(mesid, 10);
                const msg = ctx?.chat?.[idx];
                if (msg) {
                    msg.mes = text;
                    restoredIds.push(idx);
                }
            }
            refreshChatMessages(restoredIds);
            doSaveChat();
            alert(`✅ 聊天快照已恢复（已实时刷新 ${restoredIds.length} 个楼层）`);
        } catch (e) { alert('❌ 恢复失败: ' + e.message); }
    });

    doc.on('click', '#mv-restore-db-snap-btn', () => {
        if (!activeVaultId) return;
        if (!confirm('⚠️ 将记忆库恢复到最近一次写库前的状态？')) return;
        const ok = restoreDbSnapshot(activeVaultId);
        if (ok) {
            if (settings.enabled) updateInjection(activeVaultId, settings);
            renderAll();
            alert('✅ 记忆库快照已恢复');
        } else {
            alert('无记忆库快照');
        }
    });

    doc.on('click', '#mv-scan-chat-btn', openScanModal);

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

    doc.on('change', '#mv-set-scan-exclude-recent-n', function() {
        settings.scanExcludeRecentN = this.checked;
        savePluginSettings();
    });

    doc.on('change', '#mv-set-inject-format', function() {
        settings.injectFormat = jQuery(this).val();
        savePluginSettings();
        if (activeVaultId && settings.enabled) updateInjection(activeVaultId, settings);
    });

    doc.on('change', '#mv-fp-chat-switch-copy', function() {
        settings.chatSwitchCopy = jQuery(this).val();
        savePluginSettings();
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

// ─── 菜单按钮 ─────────────────────────────────────────────────────────────

function addMenuButton() {
    if (jQuery('#mv-menu-btn').length) return;
    const $btn = jQuery('<div class="list-group-item flex-container flexGap5" id="mv-menu-btn">')
        .html('<i class="fa-solid fa-vault"></i><span>糖🍬的记忆管理</span>')
        .on('click', togglePanel);

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
        setUiHelpers(scanAndStoreMessage, doSaveChat, refreshChatMessages);
        setUiSettings(settings);
        setUiSaveCallback(savePluginSettings);
        setUiVaultBoundCallback((newVaultId) => {
            activeVaultId = newVaultId;
            if (activeVaultId && settings.enabled) updateInjection(activeVaultId, settings);
            renderAll();
            setStatus('✅ 已重新绑定记忆库');
        });
        bindSettingsPanel();
        addMenuButton();
        registerEvents();

        setTimeout(() => {
            const resolved = resolveActiveVault(null);
            activeVaultId = resolved.vaultId;
            setUiChatId(activeVaultId);
            if (activeVaultId && settings.enabled) updateInjection(activeVaultId, settings);
            syncSettings(settings);
            renderAll();
            console.log('[MemoryVault] ✅ v1.2.0 已加载，vaultId:', activeVaultId);
        }, 800);
    }, 500);
})();