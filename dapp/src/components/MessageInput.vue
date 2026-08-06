<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { state, signAndPush } from '../connection';
import { buildSendMessageAction } from '../chatClient';
import { validateMessage, friendlyChainError, byteLength } from '../chatMath';
import { MAX_MESSAGE_LENGTH } from '../config';

const emit = defineEmits<{ (e: 'sent'): void }>();

const draft = ref('');
const error = ref('');
const inputEl = ref<HTMLInputElement | null>(null);

// Byte-based to match the contract's memo.size() cap (see byteLength) — the
// trimmed text is what actually gets sent, so count that.
const remaining = computed(() => MAX_MESSAGE_LENGTH - byteLength(draft.value.trim()));
const canSend = computed(
  () => state.connected && !state.busy && remaining.value >= 0 && draft.value.trim().length > 0,
);

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
  const result = validateMessage(draft.value);
  if (!result.ok) {
    error.value = result.error ?? 'Invalid message.';
    return;
  }
  try {
    const actions = buildSendMessageAction(state.account, state.permission, result.text);
    await signAndPush(actions);
    draft.value = '';
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
    <form @submit.prevent="send">
      <input
        ref="inputEl"
        type="text"
        v-model="draft"
        :placeholder="state.connected ? 'Message the chain…' : 'Connect your wallet to start chatting'"
        :disabled="!state.connected || state.busy"
        maxlength="256"
      />
      <button type="submit" class="solid send" :disabled="!canSend">
        {{ state.busy ? 'Sending…' : 'Send' }}
      </button>
    </form>
    <div class="hint">
      <span v-if="error" class="send-error">{{ error }}</span>
      <span v-else>Each message is a real transaction on Ultra mainnet.</span>
      <span v-if="draft" class="count" :class="{ over: remaining < 0 }">{{ remaining }}</span>
    </div>
  </div>
</template>
