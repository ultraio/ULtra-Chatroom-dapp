<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { state, getClient, initWalletSync, teardownWalletSync, tryReconnect } from './connection';
import { readAllMessages, readNewMessages, type ChatMessage } from './chatClient';
import { POLL_INTERVAL_MS } from './config';
import ConnectButton from './components/ConnectButton.vue';
import MessageFeed from './components/MessageFeed.vue';
import MessageInput from './components/MessageInput.vue';

const messages = ref<ChatMessage[]>([]);
let pollHandle: ReturnType<typeof setInterval> | undefined;

function lastId(): number {
  return messages.value.length ? messages.value[messages.value.length - 1].id : -1;
}

async function loadFullFeed() {
  try {
    messages.value = await readAllMessages(getClient());
  } catch (e) {
    state.error = e instanceof Error ? `Failed to load message history: ${e.message}` : 'Failed to load message history.';
  }
}

async function pollForNew() {
  try {
    const fresh = await readNewMessages(getClient(), lastId());
    if (fresh.length) messages.value = [...messages.value, ...fresh];
  } catch {
    // transient RPC hiccup — next poll tick will retry
  }
}

onMounted(async () => {
  initWalletSync();
  // History is public chain data — load it up front so it's visible before
  // (or even without) a wallet connection; don't gate it behind reconnect.
  await loadFullFeed();
  await tryReconnect();
  pollHandle = setInterval(pollForNew, POLL_INTERVAL_MS);
});

onUnmounted(() => {
  if (pollHandle) clearInterval(pollHandle);
  teardownWalletSync();
});
</script>

<template>
  <header class="topbar">
    <h1>ultra chat room</h1>
    <ConnectButton />
  </header>

  <p v-if="state.networkMismatch" class="error-banner">
    Wallet is on a different network than this dapp (mainnet). Switch networks in the extension.
  </p>
  <p v-if="state.error" class="error-banner">{{ state.error }}</p>

  <MessageFeed :messages="messages">
    <MessageInput @sent="pollForNew" />
  </MessageFeed>
</template>
