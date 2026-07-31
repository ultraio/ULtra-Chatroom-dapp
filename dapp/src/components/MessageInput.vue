<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import { state, signAndPush } from '../connection';
import { buildSendMessageAction } from '../chatClient';
import { validateMessage, friendlyChainError } from '../chatMath';
import { shortenAddress } from '../chatMath';

const emit = defineEmits<{ (e: 'sent'): void }>();

const draft = ref('');
const error = ref('');
const focused = ref(false);
const inputEl = ref<HTMLInputElement | null>(null);

function onFocus() {
  focused.value = true;
  inputEl.value?.scrollIntoView({ block: 'end' });
}

// The input only enters the DOM once state.connected flips true (see v-if
// below), so the static `autofocus` attribute never gets a chance to fire —
// focus it explicitly as soon as it mounts.
watch(
  () => state.connected,
  async (connected) => {
    if (!connected) return;
    await nextTick();
    inputEl.value?.focus();
  },
);

async function send() {
  if (!state.connected || state.busy) return;
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
    // busy briefly disables (and thus blurs) the input — reclaim focus so
    // it's always ready for the next line, like a real terminal prompt.
    await nextTick();
    inputEl.value?.focus();
  }
}
</script>

<template>
  <p v-if="error" class="shell-error">{{ error }}</p>
  <form class="composer-line" @submit.prevent="send">
    <template v-if="state.connected">
      <span class="prompt">{{ shortenAddress(state.account) }}@ultra:~$</span>
      <span v-if="!draft && focused" class="cursor">█</span>
      <input
        ref="inputEl"
        type="text"
        v-model="draft"
        :disabled="state.busy"
        :class="{ 'caret-hidden': !draft }"
        maxlength="256"
        autofocus
        @focus="onFocus"
        @blur="focused = false"
      />
    </template>
    <span v-else class="prompt prompt-disconnected">guest@ultra:~$ connect wallet to send messages</span>
  </form>
</template>
