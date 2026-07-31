// Node-side "real signer" for the Playwright mock wallet (KB 05 §6 / 06 §8):
// builds, signs (with the well-known local dev key), and pushes a real
// transaction to the seeded ultratest2 --keep-alive chain at :8888, so
// contract asserts surface through Playwright exactly like a real wallet
// would reject them.
//
// UNVERIFIED IN THIS SANDBOX: there is no nodeos/CDT/Docker here, so this
// file has never been run against a live chain. The TAPOS (ref_block_num /
// ref_block_prefix) calculation below is the standard Antelope algorithm,
// but validate this end to end on a machine with the toolchain (KB 00 §3 or
// 02 §1) before trusting it — see KB 04 §5/§6 for the re-keying this depends on.
import { APIClient, Bytes, Checksum256, PrivateKey, SignedTransaction, Transaction } from '@wharfkit/antelope';

const NODE_URL = 'http://127.0.0.1:8888';
const DEV_PRIVATE_KEY = '5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFD3'; // local/dev only — KB 06 §7.1

export interface RawAction {
  account: string;
  name: string;
  authorization: { actor: string; permission: string }[];
  data: Record<string, unknown>;
}

const client = new APIClient({ url: NODE_URL });

export async function pushAsDevKey(actions: RawAction[]): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  try {
    const info = await client.v1.chain.get_info();

    // Standard TAPOS calculation: ref_block_num = low 16 bits of the head
    // block number; ref_block_prefix = the second little-endian uint32 word
    // of the head block id.
    const idBytes = info.head_block_id.array;
    const prefixView = new DataView(idBytes.buffer, idBytes.byteOffset + 8, 4);
    const refBlockPrefix = prefixView.getUint32(0, true);
    const refBlockNum = Number(info.head_block_num) & 0xffff;

    const abis = await Promise.all(
      [...new Set(actions.map((a) => a.account))].map(async (account) => ({
        contract: account,
        abi: (await client.v1.chain.get_abi(account)).abi!,
      })),
    );

    const expiration = new Date(Date.now() + 60_000).toISOString().slice(0, 19);

    const transaction = Transaction.from(
      {
        expiration,
        ref_block_num: refBlockNum,
        ref_block_prefix: refBlockPrefix,
        max_net_usage_words: 0,
        max_cpu_usage_ms: 0,
        delay_sec: 0,
        actions,
      },
      abis,
    );

    const digest = transaction.signingDigest(Checksum256.from(info.chain_id));
    const signature = PrivateKey.from(DEV_PRIVATE_KEY).signDigest(digest);
    const signed = SignedTransaction.from({ ...transaction, signatures: [signature] });

    const result = await client.v1.chain.push_transaction(signed);
    return { ok: true, id: String((result as any).transaction_id) };
  } catch (e: any) {
    const details = e?.response?.json?.error?.details?.map((d: any) => d.message).join(', ');
    return { ok: false, error: details ?? String(e?.message ?? e) };
  }
}

export { client as chainClient, Bytes };
