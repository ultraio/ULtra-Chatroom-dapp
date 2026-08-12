<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import 'emoji-picker-element';
import emojiDataUrl from 'emoji-picker-element-data/en/emojibase/data.json?url';
import { state, signAndPush } from '../connection';
import { buildSendMessageAction, buildTipAction } from '../chatClient';
import { validateMessage, friendlyChainError, byteLength, insertAtCaret } from '../chatMath';
import { isTipCommand, parseTipCommand } from '../tipCommand';
import { MAX_MESSAGE_LENGTH } from '../config';
import type { EmojiClickDetail } from '../emoji-picker';

const emit = defineEmits<{ (e: 'sent'): void }>();

const draft = ref('');
const error = ref('');
const inputEl = ref<HTMLInputElement | null>(null);

// A "/tip …" draft is sent as a canonical memo (see tipCommand), not the raw
// text — so in tip mode count the memo the contract will actually store.
const tipMode = computed(() => isTipCommand(draft.value));
const parsedTip = computed(() => (tipMode.value ? parseTipCommand(draft.value, state.account) : null));
const effectiveText = computed(() => {
  const p = parsedTip.value;
  return p && p.ok && p.memo ? p.memo : draft.value.trim();
});

// Byte-based to match the contract's memo.size() cap (see byteLength) — the
// effective text (memo for tips, trimmed draft otherwise) is what gets sent.
const remaining = computed(() => MAX_MESSAGE_LENGTH - byteLength(effectiveText.value));
const canSend = computed(
  () => state.connected && !state.busy && remaining.value >= 0 && draft.value.trim().length > 0,
);

// --- Emoji picker ---------------------------------------------------------
const pickerOpen = ref(false);
// The app is dark-first (light only when the OS asks); emoji-picker-element is
// the reverse, so drive its light/dark class to match the app instead of
// letting the two defaults diverge (e.g. dark app + light picker on no-pref).
const lightQuery = window.matchMedia('(prefers-color-scheme: light)');
const pickerTheme = ref(lightQuery.matches ? 'light' : 'dark');
const onThemeChange = (e: MediaQueryListEvent) => (pickerTheme.value = e.matches ? 'light' : 'dark');
lightQuery.addEventListener('change', onThemeChange);
const popoverEl = ref<HTMLElement | null>(null);
const emojiBtnEl = ref<HTMLButtonElement | null>(null);
// Last caret position in the input; kept fresh so an emoji lands where the
// cursor was even though clicking the picker blurs the input. null = end.
const caretStart = ref<number | null>(null);
const caretEnd = ref<number | null>(null);
// Briefly flags an insert rejected for exceeding the byte cap, to flash the
// counter (the picker can't build a message the chain would reject).
const blocked = ref(false);
let blockTimer: ReturnType<typeof setTimeout> | undefined;

function trackCaret() {
  caretStart.value = inputEl.value?.selectionStart ?? null;
  caretEnd.value = inputEl.value?.selectionEnd ?? null;
}

function togglePicker() {
  pickerOpen.value = !pickerOpen.value;
}

function closePicker() {
  pickerOpen.value = false;
}

function onEmojiClick(event: CustomEvent<EmojiClickDetail>) {
  const emoji = event.detail?.unicode;
  if (!emoji) return;
  const next = insertAtCaret(draft.value, emoji, caretStart.value, caretEnd.value);
  if (byteLength(next.text) > MAX_MESSAGE_LENGTH) {
    // Would overflow the on-chain cap — reject and flash the counter.
    blocked.value = true;
    clearTimeout(blockTimer);
    blockTimer = setTimeout(() => (blocked.value = false), 600);
    return;
  }
  draft.value = next.text;
  // Chain consecutive inserts from the new caret (setSelectionRange fires no
  // input event, so update our tracked position by hand).
  caretStart.value = next.caret;
  caretEnd.value = next.caret;
  nextTick(() => {
    inputEl.value?.focus();
    inputEl.value?.setSelectionRange(next.caret, next.caret);
  });
}

// Close on outside click / Escape only while open, so there's no idle listener.
function onDocPointer(e: MouseEvent) {
  const t = e.target as Node;
  if (popoverEl.value?.contains(t) || emojiBtnEl.value?.contains(t)) return;
  closePicker();
}
function onDocKey(e: KeyboardEvent) {
  if (e.key === 'Escape') closePicker();
}
watch(pickerOpen, (open) => {
  if (open) {
    document.addEventListener('mousedown', onDocPointer);
    document.addEventListener('keydown', onDocKey);
  } else {
    document.removeEventListener('mousedown', onDocPointer);
    document.removeEventListener('keydown', onDocKey);
  }
});
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocPointer);
  document.removeEventListener('keydown', onDocKey);
  lightQuery.removeEventListener('change', onThemeChange);
  clearTimeout(blockTimer);
});

// Focus the input as soon as a wallet connects, so you can start typing.
watch(
  () => state.connected,
  async (connected) => {
    if (!connected) return;
    await nextTick();
    inputEl.value?.focus();
  },
);

async function send() {
  if (!canSend.value) return;
  error.value = '';
  // Build the actions first so a validation error never clears the draft.
  let actions;
  if (isTipCommand(draft.value)) {
    const tip = parseTipCommand(draft.value, state.account);
    if (!tip.ok) {
      error.value = tip.error ?? 'Invalid tip.';
      return;
    }
    actions = buildTipAction(state.account, state.permission, tip.quantity!, tip.memo!);
  } else {
    const result = validateMessage(draft.value);
    if (!result.ok) {
      error.value = result.error ?? 'Invalid message.';
      return;
    }
    actions = buildSendMessageAction(state.account, state.permission, result.text);
  }
  try {
    await signAndPush(actions);
    draft.value = '';
    closePicker();
    emit('sent');
  } catch (e) {
    const raw = e instanceof Error ? e.message : 'Send failed.';
    error.value = friendlyChainError(raw);
  } finally {
    // busy briefly disables (and thus blurs) the input — reclaim focus so it's
    // always ready for the next message.
    await nextTick();
    inputEl.value?.focus();
  }
}
</script>

<template>
  <div class="composer">
    <div v-if="pickerOpen" ref="popoverEl" class="emoji-popover">
      <emoji-picker :data-source="emojiDataUrl" :class="pickerTheme" @emoji-click="onEmojiClick"></emoji-picker>
    </div>
    <form @submit.prevent="send">
      <button
        ref="emojiBtnEl"
        type="button"
        class="emoji-toggle"
        :class="{ active: pickerOpen }"
        :disabled="!state.connected || state.busy"
        :aria-expanded="pickerOpen"
        aria-label="Insert emoji"
        title="Insert emoji"
        @click="togglePicker"
      >
        😊
      </button>
      <input
        ref="inputEl"
        type="text"
        v-model="draft"
        :placeholder="state.connected ? 'Message the chain…' : 'Connect your wallet to start chatting'"
        :disabled="!state.connected || state.busy"
        maxlength="256"
        @input="trackCaret"
        @click="trackCaret"
        @keyup="trackCaret"
        @select="trackCaret"
      />
      <button type="submit" class="solid send" :disabled="!canSend">
        {{ state.busy ? 'Sending…' : 'Send' }}
      </button>
    </form>
    <div class="hint">
      <span v-if="error" class="send-error">{{ error }}</span>
      <span v-else-if="tipMode" class="tip-hint">💸 <b>/tip</b> &lt;account&gt; &lt;amount&gt; [note] — sends UOS to the recipient on-chain.</span>
      <span v-else>Each message is a real transaction on Ultra mainnet. Tip someone with <b>/tip</b>.</span>
      <span v-if="draft" class="count" :class="{ over: remaining < 0 || blocked }">{{ remaining }}</span>
    </div>
  </div>
</template>
