import { UltraTest, UltraTestAPI } from '@ultraos/ultratest/interfaces/test';
import { UltraAPIv2, ultraStartup } from 'ultratest-ultra-startup-plugin';
import { ultraContracts } from 'ultratest-ultra-contracts-plugin';
import { genesis } from 'ultratest-genesis-plugin/genesis';
import { system, SystemAPI } from 'ultratest-system-plugin/system';

// Seeds a keep-alive local chain for dapp E2E / manual QA (KB 04 §6):
//   ultratest2 --contracts-dir-path=<...>/build/contracts \
//     -t $PWD/e2e_setup.ts --keep-alive
// RPC ends up at http://127.0.0.1:8888. Deploys chatroom1, funds alice/bob,
// seeds one starter message, then re-keys alice/bob to the well-known dev
// key LAST so an external signer (Playwright mock wallet, the real
// extension) can act as them. NOT executed in the dappbuilder sandbox — no
// local nodeos/CDT available there.
const DEV_PUBLIC_KEY = 'EOS6MRyAjQq8ud7hVNYcfnVPJqcVpscN5So8BhtHuGYqET5GDW5CV';

export default class E2ESetup extends UltraTest {
  requiredAccounts() { return ['alice', 'bob']; }
  nodeosConfigs() { return { config: { 'abi-serializer-max-time-ms': 100000 } }; }

  async onChainStart(ultra: UltraTestAPI) {
    ultra.addPlugins([genesis(ultra), system(ultra), ultraContracts(ultra), await ultraStartup(ultra)]);
  }

  async tests(ultra: UltraTestAPI) {
    const ultraAPI = new UltraAPIv2(ultra);
    const systemAPI = new SystemAPI(ultra);

    return {
      'seed: deploy chatroom1, fund users, post a starter message, re-key to dev key': async () => {
        await systemAPI.createAccountFull({ name: 'chatroom1', giftRam: 5 * 1024 * 1024 }, 'eosio');
        await systemAPI.publishContract('chatroom1', '../../contracts/chatroom/build/');

        await ultraAPI.token.transferTokens('ultra.eosio', 'alice', 10);
        await ultraAPI.token.transferTokens('ultra.eosio', 'bob', 10);

        await ultraAPI.token.transferCustomTokens('alice', 'chatroom1', '0.00000001 UOS', 'no messages yet — say something');

        // Re-key LAST (KB 04 §5/§6): requiredAccounts() get random keys the
        // runner holds; the Playwright mock-wallet signer needs the dev key
        // to sign as alice/bob from outside the process. updateAuth lives
        // directly on ultraAPI (not ultraAPI.system) and takes positional
        // args, not an auth object.
        const devKeys = [{ key: DEV_PUBLIC_KEY, weight: 1 }];
        await ultraAPI.updateAuth('alice', 'active', 'owner', 1, devKeys, []);
        await ultraAPI.updateAuth('bob', 'active', 'owner', 1, devKeys, []);
      },
    };
  }
}
