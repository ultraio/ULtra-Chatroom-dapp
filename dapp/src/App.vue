<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { state, getClient, initWalletSync, teardownWalletSync, tryReconnect } from './connection';
import { readAllMessages, readNewMessages, readBannedAccounts, type ChatMessage } from './chatClient';
import { POLL_INTERVAL_MS } from './config';
import ConnectButton from './components/ConnectButton.vue';
import MessageFeed from './components/MessageFeed.vue';
import MessageInput from './components/MessageInput.vue';

const messages = ref<ChatMessage[]>([]);
const banned = ref<Set<string>>(new Set());
// Bans are rare and owner-driven — no need to re-read every poll tick.
const BANNED_REFRESH_MS = 30_000;
let pollHandle: ReturnType<typeof setInterval> | undefined;
let bannedHandle: ReturnType<typeof setInterval> | undefined;

// Hide banned senders' already-stored messages. The contract blocks them from
// posting new ones; this filters the ones already on chain (until they scroll
// out of the retention window). lastId() below still tracks the raw feed so
// polling isn't affected by what's hidden.
const visibleMessages = computed(() => messages.value.filter((m) => !banned.value.has(m.sender)));

async function refreshBanned() {
  try {
    banned.value = await readBannedAccounts(getClient());
  } catch {
    // transient RPC hiccup — keep the last known ban list until next refresh
  }
}

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
  await Promise.all([loadFullFeed(), refreshBanned()]);
  await tryReconnect();
  pollHandle = setInterval(pollForNew, POLL_INTERVAL_MS);
  bannedHandle = setInterval(refreshBanned, BANNED_REFRESH_MS);
});

onUnmounted(() => {
  if (pollHandle) clearInterval(pollHandle);
  if (bannedHandle) clearInterval(bannedHandle);
  teardownWalletSync();
});
</script>

<template>
  <header class="topbar">
    <div class="brand">
      <img src="/ultra-logo.png" alt="Ultra" />
      <span class="title">Ultra <b>Chat</b></span>
      <span class="chain-tag">mainnet</span>
    </div>
    <span class="spacer" />
    <ConnectButton />
  </header>

  <p v-if="state.networkMismatch" class="error-banner">
    Your wallet is on a different network. Switch to Ultra mainnet in the extension to send messages.
  </p>
  <p v-if="state.error" class="error-banner">{{ state.error }}</p>

  <MessageFeed :messages="visibleMessages" />
  <MessageInput @sent="pollForNew" />
</template>
