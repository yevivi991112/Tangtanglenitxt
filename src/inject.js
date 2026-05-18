/**
 * inject.js — 把记忆注入 ST prompt（使用 setExtensionPrompt）
 */

import { getPinnedSorted, getRecentUnpinned, loadMemories } from './memory.js';

const INJECTION_KEY = 'memory-vault';

function buildPromptText(list, settings) {
  const { recentN = 5, pinnedFirst = true, injectFormat = 'lenitxt' } = settings;

  const pinned = getPinnedSorted(list);
  const unpinned = getRecentUnpinned(list, recentN);
  const recent = recentN === 0 ? unpinned : unpinned.slice(-recentN);

  const ordered = pinnedFirst
    ? [...pinned, ...recent]
    : [...recent, ...pinned];

  const lines = [];
  let lastDate = null;
  for (const e of ordered) {
    const dateStr = (e.date === lastDate) ? '' : e.date;
    const plainLine = dateStr
      ? `${dateStr}|${e.tags.join(',')}|${e.content}`
      : `|${e.tags.join(',')}|${e.content}`;
    if (injectFormat === 'plain' || injectFormat === 'lenitxt_single') {
      lines.push(plainLine);
    } else {
      lines.push(`<Lenitxt>${plainLine}</Lenitxt>`);
    }
    lastDate = e.date;
  }
  const joined = lines.join('\n');
  return injectFormat === 'lenitxt_single' ? `<Lenitxt>\n${joined}\n</Lenitxt>` : joined;
}

function getSetExtensionPrompt() {
  try {
    const ctx = SillyTavern.getContext();
    if (typeof ctx?.setExtensionPrompt === 'function') return ctx.setExtensionPrompt.bind(ctx);
  } catch {}
  if (typeof window !== 'undefined' && typeof window.setExtensionPrompt === 'function')
    return window.setExtensionPrompt;
  return null;
}

export function updateInjection(chatId, settings) {
  try {
    const fn = getSetExtensionPrompt();
    if (!fn) return;
    const list = loadMemories(chatId);
    const text = buildPromptText(list, settings);
    const { position, depth } = resolvePosition(settings.injectionPosition);
    fn(INJECTION_KEY, text, position, depth);
  } catch (e) {
    console.warn('[MemoryVault] inject 失败:', e);
  }
}

export function clearInjection() {
  try {
    const fn = getSetExtensionPrompt();
    if (fn) fn(INJECTION_KEY, '', 0, 0);
  } catch {}
}

function resolvePosition(pos) {
  const MAP = {
    in_chat: { position: 1, depth: 9999 },
    before_prompt: { position: 0, depth: 0 },
    after_char: { position: 1, depth: 0 },
    authors_note: { position: 2, depth: 0 },
  };
  return MAP[pos] ?? { position: 0, depth: 0 };
}
