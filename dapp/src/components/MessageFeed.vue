<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import type { ChatMessage } from '../chatClient';
import { formatTimestamp } from '../chatMath';
import { parseTipMessage } from '../tipCommand';
import { TIP_BADGE_MIN_ID } from '../config';
import { state } from '../connection';

const props = defineProps<{ messages: ChatMessage[] }>();

// A row is a VERIFIED tip only if it starts with "/tip " AND its id is above the
// deploy-time high-water-mark — see config.TIP_BADGE_MIN_ID and the design spec
// §2. This is what stops a pre-upgrade "/tip …" row (which the old contract
// stored as plain text, no funds moved) from being badged as a real tip.
const rendered = computed(() =>
  props.messages.map((m) => ({
    m,
    tip: m.id > TIP_BADGE_MIN_ID ? parseTipMessage(m.text) : null,
  })),
);

const feedEl = ref<HTMLDivElement | null>(null);

function scrollToBottom() {
  const el = feedEl.value;
  if (el) el.scrollTop = el.scrollHeight;
}

onMounted(scrollToBottom);
// New messages (ours or anyone else's) grow the feed — follow to the bottom so
// the latest line stays in view, like any chat app.
watch(
  () => props.messages.length,
  () => nextTick(scrollToBottom),
);

// Deterministic avatar tint per account name — same name, same colour, every
// session, so the eye can track who's who without a profile system.
const AVATAR_COLORS = ['#7a29ff', '#5e6bff', '#9b5eff', '#3aa0ff', '#e0559b', '#22c55e', '#f59e0b', '#14b8a6'];
function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
function initials(name: string): string {
  return name.slice(0, 2);
}
function isMine(sender: string): boolean {
  return !!state.account && sender === state.account;
}
</script>

<template>
  <div class="feed" ref="feedEl">
    <div v-if="messages.length === 0" class="empty">
      <div class="big">No messages yet</div>
      <div>Connect your wallet and write the first line — it's stored on the Ultra chain, forever.</div>
    </div>

    <div v-for="{ m, tip } in rendered" :key="m.id" class="msg" :class="{ mine: isMine(m.sender) }">
      <div class="avatar" :style="{ background: avatarColor(m.sender) }">{{ initials(m.sender) }}</div>
      <div class="bubble" :class="{ tip: !!tip }">
        <div class="sender">{{ m.sender }}</div>
        <!-- Verified tip: rendered from the stored text, TEXT-ONLY (never v-html)
             since the note is attacker-controlled memo content. -->
        <div v-if="tip" class="tip-line">
          <span class="tip-badge">💸 Tip</span>
          <span class="tip-body">
            <b>{{ tip.amount }} UOS</b> to <b>@{{ tip.receiver }}</b><template v-if="tip.note"> — {{ tip.note }}</template>
          </span>
        </div>
        <div v-else class="text">{{ m.text }}</div>
        <div class="meta">
          <span class="time">{{ formatTimestamp(m.sent_at) }}</span>
          <span class="id" :title="`onchain message #${m.id}`">{{ m.id }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
