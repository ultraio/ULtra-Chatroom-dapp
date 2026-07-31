import { assert, assertAsyncThrow } from '@ultraos/ultratest/apis/testApi';
import { UltraTest, UltraTestAPI } from '@ultraos/ultratest/interfaces/test';
import { UltraAPIv2, ultraStartup } from 'ultratest-ultra-startup-plugin';
import { ultraContracts } from 'ultratest-ultra-contracts-plugin';
import { genesis } from 'ultratest-genesis-plugin/genesis';
import { system, SystemAPI } from 'ultratest-system-plugin/system';

// Run with (KB 04 §2):
//   ultratest2 --contracts-dir-path=<...>/build/contracts \
//     -t <...>/ultratests/chatroom/chatroom.spec.ts > /tmp/chatroom-spec.log 2>&1
// NOT executed in the dappbuilder sandbox (no nodeos/CDT available there) —
// verify on a machine with the toolchain (KB 00 §3 or 02 §1) before trusting it.
// 5s cooldown / 50-per-day flood control (chatroom.hpp COOLDOWN_SECONDS /
// MAX_MSGS_PER_DAY) makes tests that fire the same sender twice in a row
// order-sensitive: any successful send starts that sender's cooldown, so a
// second send from the same account moments later reverts unless the test
// waits it out. Below, 'carol' takes over the boundary-case send (previously
// bob's second message) purely to keep that test independent of timing;
// 'dave' is reserved for the dedicated cooldown tests at the end so they
// don't perturb the message-count assertions earlier in the file.
function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default class Test extends UltraTest {
  requiredAccounts() { return ['alice', 'bob', 'carol', 'dave']; }
  nodeosConfigs() { return { config: { 'abi-serializer-max-time-ms': 100000 } }; }

  async onChainStart(ultra: UltraTestAPI) {
    ultra.addPlugins([genesis(ultra), system(ultra), ultraContracts(ultra), await ultraStartup(ultra)]);
  }

  async tests(ultra: UltraTestAPI) {
    const ultraAPI = new UltraAPIv2(ultra);
    const systemAPI = new SystemAPI(ultra);

    return {
      'setup: create + deploy chatroom1': async () => {
        await systemAPI.createAccountFull({ name: 'chatroom1', giftRam: 5 * 1024 * 1024 }, 'eosio');
        await systemAPI.publishContract('chatroom1', '../../contracts/chatroom/build/');
        await ultraAPI.token.transferTokens('ultra.eosio', 'alice', 10);
        await ultraAPI.token.transferTokens('ultra.eosio', 'bob', 10);
        await ultraAPI.token.transferTokens('ultra.eosio', 'carol', 10);
        await ultraAPI.token.transferTokens('ultra.eosio', 'dave', 10);
      },

      'alice posts a message: row is written with her account, text and an id': async () => {
        await ultraAPI.token.transferCustomTokens('alice', 'chatroom1', '0.00000001 UOS', 'gm ultra');
        const { rows } = await systemAPI.getTableRows('chatroom1', 'chatroom1', 'messages.a');
        assert(rows.length === 1, 'exactly one message row after alice posts');
        assert(rows[0].id === 0, 'first message gets id 0');
        assert(rows[0].sender === 'alice', 'row records the sender');
        assert(rows[0].text === 'gm ultra', 'row records the exact memo text');
      },

      'bob posts a second message: id increments and both rows persist': async () => {
        await ultraAPI.token.transferCustomTokens('bob', 'chatroom1', '0.00000001 UOS', 'hello alice');
        const { rows } = await systemAPI.getTableRows('chatroom1', 'chatroom1', 'messages.a');
        assert(rows.length === 2, 'both messages present — nothing is overwritten');
        assert(rows[1].id === 1, 'second message gets the next id');
        assert(rows[1].sender === 'bob', 'second row records bob as sender');
        assert(rows[1].text === 'hello alice', 'second row records its own text');
      },

      'empty memo reverts and writes no row': async () => {
        await assertAsyncThrow(
          ultraAPI.token.transferCustomTokens('alice', 'chatroom1', '0.00000001 UOS', ''),
          'message cannot be empty');
        const { rows } = await systemAPI.getTableRows('chatroom1', 'chatroom1', 'messages.a');
        assert(rows.length === 2, 'no row added by the reverted transfer');
      },

      'over-length memo (257 chars) reverts': async () => {
        // eosio.token itself enforces a 256-byte memo cap and rejects this
        // before chatroom's own on_transfer ever runs, so the revert comes
        // from eosio.token, not our "message too long" check (which is
        // therefore unreachable in practice — see DEPLOYMENT.md).
        const tooLong = 'x'.repeat(257);
        await assertAsyncThrow(
          ultraAPI.token.transferCustomTokens('alice', 'chatroom1', '0.00000001 UOS', tooLong),
          'memo has more than 256 bytes');
      },

      'exactly-256-char memo is accepted (boundary case)': async () => {
        const atLimit = 'y'.repeat(256);
        await ultraAPI.token.transferCustomTokens('carol', 'chatroom1', '0.00000001 UOS', atLimit);
        const { rows } = await systemAPI.getTableRows('chatroom1', 'chatroom1', 'messages.a');
        assert(rows.length === 3, 'the 256-char message is accepted, not rejected');
        assert(rows[2].text.length === 256, 'full 256 characters are stored, not truncated');
        assert(rows[2].sender === 'carol', 'the boundary-case row records carol as sender');
      },

      'second message from the same sender within 5s reverts (cooldown)': async () => {
        await ultraAPI.token.transferCustomTokens('dave', 'chatroom1', '0.00000001 UOS', 'first from dave');
        await assertAsyncThrow(
          ultraAPI.token.transferCustomTokens('dave', 'chatroom1', '0.00000001 UOS', 'too soon'),
          'sending too fast');
        const { rows } = await systemAPI.getTableRows('chatroom1', 'chatroom1', 'messages.a');
        assert(rows.length === 4, 'the cooldown-rejected send writes no row');
      },

      'after the cooldown elapses, the sender can post again and their day_count increments': async () => {
        await sleep(5500);
        await ultraAPI.token.transferCustomTokens('dave', 'chatroom1', '0.00000001 UOS', 'second from dave');
        const { rows } = await systemAPI.getTableRows('chatroom1', 'chatroom1', 'messages.a');
        assert(rows.length === 5, 'the post-cooldown send is accepted');

        const { rows: senderRows } = await systemAPI.getTableRows('chatroom1', 'chatroom1', 'senders.a');
        const dave = senderRows.find((r: { sender: string }) => r.sender === 'dave');
        assert(dave !== undefined, 'dave has a senders.a row');
        assert(dave.day_count === 2, 'day_count tracks both of dave\'s successful sends');
      },

      // The 50/day cap shares this same check()/day_count path, but exhausting
      // it here would need ~245s of real waiting (49 more sends x 5s cooldown)
      // — impractical for this suite. Not exercised end-to-end; the cooldown
      // test above already proves the revert-on-check()-failure mechanism,
      // and the day_count assertion above proves the counter increments
      // correctly, so the remaining risk is narrow (the >= vs > boundary at
      // day_count === 50, verified by code review in chatroom.cpp).
    };
  }
}
