// emoji-picker-element registers <emoji-picker> as a custom element at runtime
// (see the import in MessageInput.vue). Declare it here so vue-tsc type-checks
// the template. Only the props/events the composer actually uses are typed;
// @emoji-click maps to the onEmojiClick prop, and its detail carries `unicode`
// (the final emoji string, skin tone applied).
import type { DefineComponent } from 'vue';

export interface EmojiClickDetail {
  unicode?: string;
  skinTone?: number;
  emoji: unknown;
}

declare module 'vue' {
  interface GlobalComponents {
    'emoji-picker': DefineComponent<{
      'data-source'?: string;
      locale?: string;
      onEmojiClick?: (event: CustomEvent<EmojiClickDetail>) => void;
    }>;
  }
}

export {};
