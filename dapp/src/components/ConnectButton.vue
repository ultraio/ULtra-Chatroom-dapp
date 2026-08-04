<script setup lang="ts">
import { state, connect, disconnect } from '../connection';
import { shortenAddress } from '../chatMath';
</script>

<template>
  <button v-if="!state.walletAvailable" class="ghost" disabled title="Install the Ultra Wallet extension">
    Install Ultra Wallet
  </button>
  <button v-else-if="!state.connected" class="solid" @click="connect">Connect Wallet</button>
  <span v-else class="account-group">
    <span class="account">{{ shortenAddress(state.account) }}</span>
    <button class="ghost" @click="disconnect">Disconnect</button>
  </span>
</template>
