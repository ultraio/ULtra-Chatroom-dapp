// Reads + the one write action for the chatroom contract (KB 05 §3).
// Reads: direct get_table_rows against messages.a — no indexer, no backend,
// the contract table itself is the whole feed, which is what makes "closing
// and reopening rebuilds the feed from chain data" true by construction.
// Writes: a single eosio.token::transfer whose memo is the chat message.
import { UInt64, type APIClient } from '@wharfkit/antelope';
import { BANNED_TABLE, CONTRACT_ACCOUNT, MESSAGES_TABLE, POSTAGE_QUANTITY, TOKEN_CONTRACT } from './config';

export interface ChatMessage {
  id: number;
  sender: string;
  text: string;
  sent_at: string;
}

interface TableRowsPage {
  rows: ChatMessage[];
  more: boolean;
  next_key?: string;
}

const PAGE_LIMIT = 100;

async function fetchPage(client: APIClient, lowerBound?: string): Promise<TableRowsPage> {
  const result = await client.v1.chain.get_table_rows({
    code: CONTRACT_ACCOUNT,
    scope: CONTRACT_ACCOUNT,
    table: MESSAGES_TABLE,
    json: true,
    limit: PAGE_LIMIT,
    lower_bound: lowerBound !== undefined ? UInt64.from(lowerBound) : undefined,
  });
  return {
    rows: (result.rows as unknown as ChatMessage[]).map((r) => ({ ...r, id: Number(r.id) })),
    more: Boolean(result.more),
    next_key: result.next_key !== undefined ? String(result.next_key) : undefined,
  };
}

/** Full feed, oldest first — used once on load to rebuild history from the chain. */
export async function readAllMessages(client: APIClient): Promise<ChatMessage[]> {
  const all: ChatMessage[] = [];
  let lowerBound: string | undefined;
  for (;;) {
    const page = await fetchPage(client, lowerBound);
    all.push(...page.rows);
    if (!page.more || !page.next_key) break;
    lowerBound = page.next_key;
  }
  return all;
}

/**
 * Only rows after the last one we've already rendered. Polls with
 * lower_bound = afterId + 1 so steady-state polling costs one small page,
 * not a full table re-scan — this is what keeps polling "safe" as the room's
 * history grows (KB brief: don't bolt on caching, but also don't make every
 * tick reread the whole chain).
 */
export async function readNewMessages(client: APIClient, afterId: number): Promise<ChatMessage[]> {
  const all: ChatMessage[] = [];
  let lowerBound: string | undefined = String(afterId + 1);
  for (;;) {
    const page = await fetchPage(client, lowerBound);
    all.push(...page.rows);
    if (!page.more || !page.next_key) break;
    lowerBound = page.next_key;
  }
  return all;
}

/**
 * Current ban list (small, owner-managed) as a Set of account names. Used to
 * hide banned senders' already-stored messages — the contract already blocks
 * them from posting NEW ones, but existing rows stay on chain until they
 * scroll out of the 1000-message retention window. Read separately from the
 * feed so a banned account added later hides its history on the next refresh.
 */
export async function readBannedAccounts(client: APIClient): Promise<Set<string>> {
  const banned = new Set<string>();
  let lowerBound: string | undefined;
  for (;;) {
    const result = await client.v1.chain.get_table_rows({
      code: CONTRACT_ACCOUNT,
      scope: CONTRACT_ACCOUNT,
      table: BANNED_TABLE,
      json: true,
      limit: PAGE_LIMIT,
      // next_key for a name-keyed table comes back as the numeric form of the
      // name — wrap it like the messages path so the type matches.
      lower_bound: lowerBound !== undefined ? UInt64.from(lowerBound) : undefined,
    });
    for (const row of result.rows as unknown as Array<{ account: string }>) {
      banned.add(row.account);
    }
    if (!result.more || result.next_key === undefined) break;
    lowerBound = String(result.next_key);
  }
  return banned;
}

export function buildSendMessageAction(from: string, permission: string, text: string) {
  return [
    {
      contract: TOKEN_CONTRACT,
      action: 'transfer',
      authorization: [{ actor: from, permission }],
      data: {
        from,
        to: CONTRACT_ACCOUNT,
        quantity: POSTAGE_QUANTITY,
        memo: text,
      },
    },
  ];
}
