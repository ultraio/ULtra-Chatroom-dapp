import { assert, assertAsyncThrow } from '@ultraos/ultratest/apis/testApi';
import { UltraTest, UltraTestAPI } from '@ultraos/ultratest/interfaces/test';
import { UltraAPIv2, ultraStartup } from 'ultratest-ultra-startup-plugin';
import { ultraContracts } from 'ultratest-ultra-contracts-plugin';
import { genesis } from 'ultratest-genesis-plugin/genesis';
import { system, SystemAPI } from 'ultratest-system-plugin/system';

// Verified /tip command (see docs/superpowers/specs/2026-08-12-chatroom-tip-command-design.md).
// Run with (default window = 1000 build, same as chatroom.spec.ts):
//   ultratest2 --contracts-dir-path=<system contracts>/build/contracts \
//     -t <...>/ultratests/chatroom/chatroom.tip.spec.ts
//
// The tip path inline-forwards to the recipient, so chatroom1@active MUST carry
// chatroom1@eosio.code — the setup grants it via updateauth (mirrors the
// DEPLOYMENT.md mainnet step). Reverted transfers roll back the senders table,
// so a rejected tip consumes no 5s cooldown; that's why 'erin' can fire many
// reverting attempts back-to-back. Only SUCCESSFUL sends start a cooldown, so
// each successful send below uses a distinct account (alice / carol / dave).

const CONTRACT = 'chatroom1';
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

export default class Test extends UltraTest {
  requiredAccounts() { return ['alice', 'bob', 'carol', 'dave', 'erin']; }
  nodeosConfigs() { return { config: { 'abi-serializer-max-time-ms': 100000 } }; }

  async onChainStart(ultra: UltraTestAPI) {
    ultra.addPlugins([genesis(ultra), system(ultra), ultraContracts(ultra), await ultraStartup(ultra)]);
  }

  async tests(ultra: UltraTestAPI) {
    const ultraAPI = new UltraAPIv2(ultra);
    const systemAPI = new SystemAPI(ultra);

    const balance = async (a: string) => (await ultraAPI.token.getAccountBalance(a)) ?? 0;
    const messages = async () => (await systemAPI.getTableRows(CONTRACT, CONTRACT, 'messages.a')).rows;

    return {
      'setup: create chatroom1, grant eosio.code, deploy, fund accounts': async () => {
        await systemAPI.createAccountFull({ name: CONTRACT, giftRam: 5 * 1024 * 1024 }, 'eosio');

        // Grant chatroom1@active the eosio.code authority so the contract can
        // sign its own inline forward (transfer). Preserve the existing active
        // key read from the account so we only ADD the code permission.
        const acct: any = await systemAPI.getAccount(CONTRACT);
        const active = acct.permissions.find((p: any) => p.perm_name === 'active');
        const activeKey = active.required_auth.keys[0].key;
        await ultraAPI.transactOrThrow([{
          account: 'eosio', name: 'updateauth',
          authorization: [{ actor: CONTRACT, permission: 'owner' }],
          data: {
            account: CONTRACT, permission: 'active', parent: 'owner',
            auth: {
              threshold: 1,
              keys: [{ key: activeKey, weight: 1 }],
              accounts: [{ permission: { actor: CONTRACT, permission: 'eosio.code' }, weight: 1 }],
              waits: [],
            },
          },
        }], 'grant eosio.code to chatroom1@active');

        await systemAPI.publishContract(CONTRACT, '../../contracts/chatroom/build/');
        for (const a of ['alice', 'bob', 'carol', 'dave', 'erin']) {
          await ultraAPI.token.transferTokens('ultra.eosio', a, 10);
        }
      },

      'valid tip: alice tips bob 5 — bob +5, alice -5, room keeps 0, message stored': async () => {
        const aliceBefore = await balance('alice');
        const bobBefore = await balance('bob');
        const roomBefore = await balance(CONTRACT);

        await ultraAPI.token.transferCustomTokens('alice', CONTRACT, '5.00000000 UOS', '/tip bob 5 gg wp');

        assert(near(await balance('bob') - bobBefore, 5), 'bob received exactly 5 UOS');
        assert(near(aliceBefore - (await balance('alice')), 5), 'alice paid exactly 5 UOS');
        assert(near(await balance(CONTRACT) - roomBefore, 0), 'the room forwarded everything — keeps 0');

        const rows = await messages();
        assert(rows.length === 1, 'exactly one message row after the tip');
        assert(rows[0].sender === 'alice', 'row records the tipper as sender');
        assert(rows[0].text === '/tip bob 5 gg wp', 'row stores the verbatim tip memo');
      },

      'no-note tip: carol tips bob 2 — bob +2, message stored verbatim': async () => {
        const bobBefore = await balance('bob');
        await ultraAPI.token.transferCustomTokens('carol', CONTRACT, '2.00000000 UOS', '/tip bob 2');
        assert(near(await balance('bob') - bobBefore, 2), 'bob received exactly 2 UOS');
        const rows = await messages();
        assert(rows.length === 2, 'second message row present');
        assert(rows[1].text === '/tip bob 2', 'no-note tip stored verbatim');
      },

      'anti-fake: postage-sized transfer with a /tip memo reverts and stores no row': async () => {
        const before = (await messages()).length;
        const bobBefore = await balance('bob');
        await assertAsyncThrow(
          ultraAPI.token.transferCustomTokens('erin', CONTRACT, '0.00000001 UOS', '/tip bob 5 fake'),
          'tip amount does not match the transfer');
        assert((await messages()).length === before, 'no forged tip row was written');
        assert(near(await balance('bob'), bobBefore), 'bob received nothing from the fake');
      },

      'stated amount != received reverts': async () => {
        const before = (await messages()).length;
        await assertAsyncThrow(
          ultraAPI.token.transferCustomTokens('erin', CONTRACT, '3.00000000 UOS', '/tip bob 5 sneaky'),
          'tip amount does not match the transfer');
        assert((await messages()).length === before, 'mismatched-amount tip wrote no row');
      },

      'non-numeric amount reverts': async () => {
        await assertAsyncThrow(
          ultraAPI.token.transferCustomTokens('erin', CONTRACT, '5.00000000 UOS', '/tip bob 5abc x'),
          'tip amount is not a number');
      },

      'too many decimal places reverts': async () => {
        await assertAsyncThrow(
          ultraAPI.token.transferCustomTokens('erin', CONTRACT, '5.12345678 UOS', '/tip bob 5.123456789 x'),
          'tip amount has too many decimal places');
      },

      'trailing decimal point reverts': async () => {
        await assertAsyncThrow(
          ultraAPI.token.transferCustomTokens('erin', CONTRACT, '5.00000000 UOS', '/tip bob 5. x'),
          'tip amount has a trailing decimal point');
      },

      'leading decimal point reverts (missing integer part)': async () => {
        await assertAsyncThrow(
          ultraAPI.token.transferCustomTokens('erin', CONTRACT, '5.00000000 UOS', '/tip bob .5 x'),
          'tip amount is missing its integer part');
      },

      'more than one decimal point reverts': async () => {
        await assertAsyncThrow(
          ultraAPI.token.transferCustomTokens('erin', CONTRACT, '5.00000000 UOS', '/tip bob 5.5.5 x'),
          'tip amount has more than one decimal point');
      },

      'missing amount reverts': async () => {
        await assertAsyncThrow(
          ultraAPI.token.transferCustomTokens('erin', CONTRACT, '5.00000000 UOS', '/tip bob'),
          'tip amount is missing');
      },

      'prefix only (no receiver) reverts as a nonexistent recipient': async () => {
        await assertAsyncThrow(
          ultraAPI.token.transferCustomTokens('erin', CONTRACT, '5.00000000 UOS', '/tip '),
          'tip recipient does not exist');
      },

      'unknown recipient reverts (no funds move, no row)': async () => {
        const before = (await messages()).length;
        await assertAsyncThrow(
          ultraAPI.token.transferCustomTokens('erin', CONTRACT, '5.00000000 UOS', '/tip nosuch11 5 x'),
          'tip recipient does not exist');
        assert((await messages()).length === before, 'tip to a nonexistent account wrote no row');
      },

      'cannot tip yourself': async () => {
        await assertAsyncThrow(
          ultraAPI.token.transferCustomTokens('erin', CONTRACT, '5.00000000 UOS', '/tip erin 5 x'),
          'cannot tip yourself');
      },

      'cannot tip the room contract': async () => {
        await assertAsyncThrow(
          ultraAPI.token.transferCustomTokens('erin', CONTRACT, '5.00000000 UOS', `/tip ${CONTRACT} 5 x`),
          'cannot tip the room');
      },

      'a non-tip transfer must still be exactly postage': async () => {
        await assertAsyncThrow(
          ultraAPI.token.transferCustomTokens('erin', CONTRACT, '2.00000000 UOS', 'just a normal message'),
          'transfer must be exactly the postage amount');
      },

      'a normal postage message still posts (regression)': async () => {
        const before = (await messages()).length;
        await ultraAPI.token.transferCustomTokens('dave', CONTRACT, '0.00000001 UOS', 'gm — normal message');
        const rows = await messages();
        assert(rows.length === before + 1, 'the normal message was stored');
        assert(rows[rows.length - 1].sender === 'dave', 'newest row records dave');
        assert(rows[rows.length - 1].text === 'gm — normal message', 'newest row stores its text');
      },

      'erin was never cooled down or banned by her reverts — she can post normally': async () => {
        const before = (await messages()).length;
        await ultraAPI.token.transferCustomTokens('erin', CONTRACT, '0.00000001 UOS', 'erin is fine');
        assert((await messages()).length === before + 1, 'erin posts fine after many reverted attempts');
      },
    };
  }
}
