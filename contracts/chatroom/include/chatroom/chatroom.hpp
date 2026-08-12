#pragma once
#include <eosio/asset.hpp>
#include <eosio/eosio.hpp>
#include <eosio/system.hpp>
#include <eosio/time.hpp>
#include <string>

namespace ultra {
using namespace eosio;

// Onchain Chat Room: a message is an eosio.token transfer to this contract
// whose memo IS the message text. The message-writing surface is the notify
// handler below; ban/unban are owner-only moderation actions. Everything the
// dapp needs to read is the messages.a table (see 05/07 in the Ultra agent KB
// for the read pattern), plus banned.a to hide banned senders client-side.
class [[eosio::contract("chatroom")]] chatroom : public contract {
public:
   using contract::contract;

   [[eosio::on_notify("eosio.token::transfer")]]
   void on_transfer( const name& from, const name& to, const asset& quantity,
                     const std::string& memo );

   // Owner-only moderation. Adding these actions is purely additive to the
   // ABI — no existing table or action changes — so it is NOT a breaking
   // upgrade over the already-deployed contract. A banned account can no
   // longer post (rejected in on_transfer, which reverts the transfer so no
   // funds are taken and no RAM is spent); the dapp additionally reads
   // banned.a to hide the account's already-stored messages.
   [[eosio::action]] void ban( const name& account );
   [[eosio::action]] void unban( const name& account );

private:
   static constexpr symbol UOS_SYM        = symbol( "UOS", 8 );
   static constexpr name   TOKEN_CONTRACT = "eosio.token"_n;
   // Fixed "postage" — a normal message sends exactly this (see dapp's
   // POSTAGE_QUANTITY). A larger transfer is accepted ONLY on the reserved
   // "/tip " path (see on_transfer / TIP_PREFIX), where the whole amount is
   // forwarded to the recipient inline in the same transaction and never
   // stranded; every other non-postage transfer still fails loudly. This
   // contract has no withdraw action, so anything it *keeps* is permanent —
   // the tip path is careful to keep zero.
   static constexpr int64_t POSTAGE_AMOUNT = 1;   // 0.00000001 UOS at 8 decimals
   // No protocol-level memo length limit exists for eosio.token::transfer
   // (verified against the Ultra agent KB, docs 01/03/11) — this cap is our
   // own contract-enforced design choice, not a discovered chain fact.
   static constexpr size_t   MAX_MSG_LEN       = 256;
   // Reserved command prefix (KB: dapp mirrors this). A memo starting with
   // "/tip " is forced down the verified-tip path in on_transfer; it can only
   // be stored if a matching amount was actually forwarded to a real account.
   // This is what lets the dapp badge "/tip "-prefixed rows as genuine tips
   // (bounded by a deploy-time id high-water-mark on the client side).
   static constexpr std::string_view TIP_PREFIX = "/tip ";

   // Flood control (our own design choice — not a chain-level protection;
   // Ultra's free-tx scheduler and RAM policy don't stop one account from
   // flooding a single room since RAM here is billed to get_self(), not the
   // sender). Enforced in-contract so it can't be bypassed by calling
   // eosio.token::transfer directly instead of going through the dapp UI.
   static constexpr uint32_t COOLDOWN_SECONDS  = 5;
   static constexpr uint32_t DAY_SECONDS       = 24 * 60 * 60;
   static constexpr uint32_t MAX_MSGS_PER_DAY  = 50;

   // Room-wide retention: keep only the most recent MAX_ROOM_MESSAGES rows,
   // so the contract's RAM is hard-bounded regardless of how many distinct
   // accounts ever post. Because ids are globally sequential, "oldest" is
   // just messages.begin() — no secondary index needed.
   //
   // Overridable at compile time so the prune path can be exercised with a
   // small window in tests (driving 1000+ messages through the 5s cooldown is
   // impractical, same reason the 50/day cap isn't tested end-to-end). Build
   // the test variant with -DCHATROOM_MAX_ROOM_MESSAGES=3 (see
   // ultratests/chatroom/chatroom.prune.spec.ts). Production builds leave it
   // unset and get 1000.
#ifndef CHATROOM_MAX_ROOM_MESSAGES
#define CHATROOM_MAX_ROOM_MESSAGES 1000
#endif
   static constexpr uint64_t MAX_ROOM_MESSAGES = CHATROOM_MAX_ROOM_MESSAGES;
   // Cap erases per message so the FIRST post after this upgrade can't try to
   // delete a large pre-existing backlog in a single transaction and blow the
   // CPU limit (which would revert the transfer and wedge posting). Any
   // backlog drains a few rows per message until steady state (delete 1 / add
   // 1). Never needs to be large: at steady state at most one row is stale.
   static constexpr int       PRUNE_BATCH       = 20;

   struct [[eosio::table, eosio::contract("chatroom")]] message_v0 {
      uint64_t       id;
      name           sender;
      std::string    text;
      time_point_sec sent_at;
      uint64_t primary_key() const { return id; }
      EOSLIB_SERIALIZE( message_v0, (id)(sender)(text)(sent_at) )
   };
   typedef multi_index<"messages.a"_n, message_v0> messages_table;

   // One row per unique sender (not per message) — bounds RAM growth by
   // distinct users rather than chat volume, unlike the messages table.
   struct [[eosio::table, eosio::contract("chatroom")]] sender_v0 {
      name           sender;
      time_point_sec last_sent;
      time_point_sec window_start;
      uint32_t       day_count;
      uint64_t primary_key() const { return sender.value; }
      EOSLIB_SERIALIZE( sender_v0, (sender)(last_sent)(window_start)(day_count) )
   };
   typedef multi_index<"senders.a"_n, sender_v0> senders_table;

   // Owner-managed ban list. One row per banned account; RAM billed to
   // get_self() but bounded by the (small) number of bans, not chat volume.
   // New, initially-empty table — additive, so introducing it does not
   // migrate or break the live messages.a / senders.a tables.
   struct [[eosio::table, eosio::contract("chatroom")]] banned_v0 {
      name account;
      uint64_t primary_key() const { return account.value; }
      EOSLIB_SERIALIZE( banned_v0, (account) )
   };
   typedef multi_index<"banned.a"_n, banned_v0> banned_table;
};
} // namespace ultra
