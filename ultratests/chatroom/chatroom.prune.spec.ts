import { assert } from '@ultraos/ultratest/apis/testApi';
import { UltraTest, UltraTestAPI } from '@ultraos/ultratest/interfaces/test';
import { UltraAPIv2, ultraStartup } from 'ultratest-ultra-startup-plugin';
import { ultraContracts } from 'ultratest-ultra-contracts-plugin';
import { genesis } from 'ultratest-genesis-plugin/genesis';
import { system, SystemAPI } from 'ultratest-system-plugin/system';

// Prune / retention window test — REQUIRES A SMALL-WINDOW BUILD.
//
// The production retention window is MAX_ROOM_MESSAGES = 1000 (chatroom.hpp).
// Driving 1000+ messages through the 5s cooldown to observe a prune is
// impractical in a test suite (the same reason the 50/day cap isn't tested
// end-to-end in chatroom.spec.ts). So the constant is compile-time
// overridable — build the contract with a window of 3 first, THEN run this
// spec against that build:
//
//   cd contracts/chatroom && rm -rf build && mkdir build && cd build
//   cmake -DCHATROOM_MAX_ROOM_MESSAGES=3 .. && make
//   ultratest2 --contracts-dir-path=<...>/build/contracts \
//     -t <...>/ultratests/chatroom/chatroom.prune.spec.ts > /tmp/prune.log 2>&1
//
// Do NOT run this against the default (1000) build — at these low ids nothing
// is pruned and the assertions below will (correctly) fail. Conversely, do NOT
// run chatroom.spec.ts against the window=3 build — its ~7 messages would get
// pruned and its exact row-count assertions would break. One build per spec.
//
// Five distinct senders post one message each, so no 5s cooldown wait is
// needed. With a window of 3, ids climb 0..4 while the table is held at 3 rows
// and the two oldest ids (0, then 1) are pruned on write.
const WINDOW = 3;

export default class Test extends UltraTest {
  requiredAccounts() { return ['alice', 'bob', 'carol', 'dave', 'erin']; }
  nodeosConfigs() { return { config: { 'abi-serializer-max-time-ms': 100000 } }; }

  async onChainStart(ultra: UltraTestAPI) {
    ultra.addPlugins([genesis(ultra), system(ultra), ultraContracts(ultra), await ultraStartup(ultra)]);
  }

  async tests(ultra: UltraTestAPI) {
    const ultraAPI = new UltraAPIv2(ultra);
    const systemAPI = new SystemAPI(ultra);

    const post = (from: string, text: string) =>
      ultraAPI.token.transferCustomTokens(from, 'chatroom1', '0.00000001 UOS', text);
    const messages = async () =>
      (await systemAPI.getTableRows('chatroom1', 'chatroom1', 'messages.a')).rows as Array<{ id: number; sender: string; text: string }>;

    return {
      'setup: create + deploy the small-window chatroom1, fund five senders': async () => {
        await systemAPI.createAccountFull({ name: 'chatroom1', giftRam: 5 * 1024 * 1024 }, 'eosio');
        await systemAPI.publishContract('chatroom1', '../../contracts/chatroom/build/');
        for (const acc of ['alice', 'bob', 'carol', 'dave', 'erin']) {
          await ultraAPI.token.transferTokens('ultra.eosio', acc, 10);
        }
      },

      'filling the window exactly (3 messages) prunes nothing': async () => {
        await post('alice', 'm0');
        await post('bob', 'm1');
        await post('carol', 'm2');
        const rows = await messages();
        assert(rows.length === WINDOW, 'all three fit within the window — nothing pruned yet');
        assert(rows[0].id === 0, 'oldest is still id 0');
        assert(rows[rows.length - 1].id === 2, 'newest is id 2');
      },

      'the 4th message prunes the single oldest row (id 0)': async () => {
        await post('dave', 'm3');
        const rows = await messages();
        assert(rows.length === WINDOW, 'table is held at the window size, not grown to 4');
        assert(rows[0].id === 1, 'id 0 was pruned; oldest retained is now id 1');
        assert(rows[rows.length - 1].id === 3, 'the new message got id 3');
        assert(rows[rows.length - 1].sender === 'dave', 'newest row records dave');
        assert(rows.every((r) => r.id >= 1), 'no row older than id 1 remains');
      },

      'the 5th message prunes the next oldest (id 1); ids stay monotonic': async () => {
        await post('erin', 'm4');
        const rows = await messages();
        assert(rows.length === WINDOW, 'still exactly the window size');
        assert(rows[0].id === 2, 'id 1 was pruned; oldest retained is now id 2');
        assert(rows[rows.length - 1].id === 4, 'ids keep climbing — id 4 is NOT reused despite deletions');
        assert(rows.map((r) => r.id).join(',') === '2,3,4', 'the retained window is exactly the newest three ids');
      },

      'a pruned id is genuinely gone, not just hidden from the default page': async () => {
        // Query from the very bottom of the table — the smallest surviving id
        // must be 2, proving ids 0 and 1 were erased (RAM refunded), not merely
        // paged past.
        const { rows } = await systemAPI.getTableRows('chatroom1', 'chatroom1', 'messages.a', 10, false, '0');
        assert(rows.length === WINDOW, 'only the windowed rows exist on chain');
        assert(rows[0].id === 2, 'lowest id on chain is 2 — 0 and 1 are truly erased');
      },
    };
  }
}
