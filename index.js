/**
 * index.js — Memory Vault 扩展主入口
 * SillyTavern 1.18 / 1.19+ extension — ES Module (type:module in ST)
 *
 * 设计不变量：
 * 1. 通过 chatMetadata + CHAT_RENAMED 双保险追踪当前聊天的 vaultId：
 *    - 酒馆内重命名聊天时自动无缝沿用原记忆库；
 *    - 创建分支（Branch）时自动复制一份独立记忆库，不串戏；
 *    - 任何时候都可在前端 🗂️ 历史记忆库管理中搜索、预览、重绑或合并历史记忆库。
 * 2. 翻页（MESSAGE_SWIPED）不再自动遗弃记忆；仅在真删除楼层（MESSAGE_DELETED）时，
 *    依据 ST 1.19+ 传入的剩余 chat.length 将超出范围的楼层记忆标记为遗弃。
 * 3. 自动捕获修改消息前必须增量保存 chatSnapshot，确保「恢复聊天快照」可用。
 */

import {
    mvWrite, SETTINGS_STORE_KEY,
    StorageBackend, setBackend, testBackend,
    exportAll, exportChat, importData,
} from './src/storage.js';

import {
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
    presetTags:           [],
    autoCapture:          false,
    autoCaptureExcludeN:  6,
    scanExcludeRecentN:   false,
    injectFormat:         'lenitxt',
    autoCleanAfterRestore: false,
    chatSwitchCopy:       'empty_only', // 'never' | 'empty_only' | 'always'
};

let settings      = { ...DEFAULT_SETTINGS };
let activeVaultId = null;
let recentRename  = null; // { oldFileName, newFileName, ts }

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

// ─── saveChat 工具（兼容 ST 1.19+） ───────────────────────────────────────

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

// ─── 聊天切换 / 改名 / 分支处理 ───────────────────────────────────────────

let _chatChangeTimer = null;

function handleChatChanged() {
    const oldVaultId = activeVaultId;
    const resolved = resolveActiveVault(recentRename);
    const newVaultId = resolved.vaultId;

    // 消费已匹配的近期改名记录
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
        // 仅在普通切换到全新空白聊天时，按用户设置询问是否复制旧聊天记忆
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

// ─── 自动扫描新消息 ───────────────────────────────────────────────────────

function handleNewMessage() {
    if (!settings.enabled || !activeVaultId) return;
    if (!settings.autoCapture) return;
    try {
        const ctx = SillyTavern.getContext();
        const chat = ctx?.chat;
        if (!chat?.length) return;

        const existing = loadMemories(activeVaultId);
        const threshold = chat.length - settings.autoCaptureExcludeN;
        let totalNew = 0;
        const chatSnap = {};

        for (let i = 0; i < threshold; i++) {
            const msg = chat[i];
            if (!msg?.mes) continue;
            if (!/<Lenitxt>/i.test(msg.mes)) continue;

            const originalMes = msg.mes;
            const { newEntries, modifiedText } = scanAndStoreMessage(
                activeVaultId, i, originalMes, existing, settings.defaultImportance
            );
            if (!newEntries.length) continue;

            if (totalNew === 0) saveDbSnapshot(activeVaultId);
            chatSnap[i] = originalMes;

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
            saveMemories(activeVaultId, existing);
            saveChatSnapshot(activeVaultId, chatSnap, true);
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

        // 监听 ST 1.19+ 原生聊天重命名事件，确保改名时无缝沿用原记忆库
        if (types.CHAT_RENAMED) {
            es.on(types.CHAT_RENAMED, (data) => {
                if (data?.oldFileName && data?.newFileName) {
                    recentRename = {
                        oldFileName: String(data.oldFileName),
                        newFileName: String(data.newFileName),
                        ts: Date.now(),
                    };
                    // 立即重新调度以尽快应用改名绑定
                    scheduleChatChanged(150);
                }
            });
        }

        // 注意：按设计决定，不再监听 MESSAGE_SWIPED 自动遗弃记忆，避免翻页误丢记忆

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
        // 切换存储后端后重新解析当前聊天记忆库
        handleChatChanged();
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

    doc.on('change', '#mv-set-auto-clean-restore', function() {
        settings.autoCleanAfterRestore = this.checked;
        savePluginSettings();
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
        syncSettings(settings);
    });
    doc.on('click', '.mv-preset-tag-del', function() {
        const idx = parseInt(jQuery(this).data('idx'), 10);
        settings.presetTags.splice(idx, 1);
        savePluginSettings();
        syncSettings(settings);
    });

    // 导出
    doc.on('click', '#mv-export-all', () => {
        const data = exportAll();
        downloadJson(data, 'memory-vault-all.json');
    });
    doc.on('click', '#mv-export-chat', () => {
        if (!activeVaultId) { alert('⚠️ 当前无聊天'); return; }
        downloadJson(exportChat(activeVaultId), `memory-vault-${activeVaultId}.json`);
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

    // 一键还原
    doc.on('click', '#mv-restore-all-btn', () => {
        if (!activeVaultId) return;
        if (!confirm('将所有有来源的记忆还原到对应楼层末尾？')) return;
        const count = restoreAllToChat(activeVaultId);
        doSaveChat();
        updateInjection(activeVaultId, settings);
        renderAll();
        alert(`✅ 已还原 ${count} 条记忆到来源楼层，这些记忆已移至遗弃区备份。\n如不需要可在遗弃区全选删除。`);
    });

    // 聊天快照恢复
    doc.on('click', '#mv-restore-chat-snap-btn', () => {
        if (!activeVaultId) return;
        const snap = getChatSnapshot(activeVaultId);
        if (!Object.keys(snap).length) { alert('无聊天快照'); return; }
        if (!confirm('⚠️ 将被修改的消息恢复到提取前的状态？')) return;
        try {
            const ctx = SillyTavern.getContext();
            for (const [mesid, text] of Object.entries(snap)) {
                const msg = ctx?.chat?.[parseInt(mesid, 10)];
                if (msg) msg.mes = text;
            }
            doSaveChat();
            alert('✅ 聊天快照已恢复');
        } catch (e) { alert('❌ 恢复失败: ' + e.message); }
    });

    // 记忆库快照恢复
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

// ─── 菜单按钮（ST 1.18 / 1.19+ 标准方式） ────────────────────────────────

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
        setUiHelpers(scanAndStoreMessage, doSaveChat);
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
            console.log('[MemoryVault] ✅ v1.1.0 已加载，vaultId:', activeVaultId);
        }, 800);
    }, 500);
})();