<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue';
import type { ChatMessage } from '../chatClient';
import { shortenAddress, formatTimestamp } from '../chatMath';

const props = defineProps<{ messages: ChatMessage[] }>();

const feedEl = ref<HTMLDivElement | null>(null);

function scrollToBottom() {
  const el = feedEl.value;
  if (el) el.scrollTop = el.scrollHeight;
}

onMounted(scrollToBottom);
// New messages (ours or anyone else's) push the composer line down — follow
// it so the prompt stays where you'd expect it: right under the last line.
watch(
  () => props.messages.length,
  () => nextTick(scrollToBottom),
);
</script>

<template>
  <div class="feed" ref="feedEl">
    <p v-if="messages.length === 0" class="empty">no messages yet. say something</p>
    <div v-for="m in messages" :key="m.id" class="message-row">
      <span class="time">{{ formatTimestamp(m.sent_at) }}</span>
      <span class="addr">{{ shortenAddress(m.sender) }}</span>
      <span class="text">{{ m.text }}</span>
    </div>
    <slot />
  </div>
</template>
