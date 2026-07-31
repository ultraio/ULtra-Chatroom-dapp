#pragma once
#include <eosio/asset.hpp>
#include <eosio/eosio.hpp>
#include <eosio/system.hpp>
#include <eosio/time.hpp>
#include <string>

namespace ultra {
using namespace eosio;

// Onchain Chat Room: a message is an eosio.token transfer to this contract
// whose memo IS the message text. No public actions — the entire surface is
// the notify handler below. Everything the dapp needs to read is the
// messages.a table (see 05/07 in the Ultra agent KB for the read pattern).
class [[eosio::contract("chatroom")]] chatroom : public contract {
public:
   using contract::contract;

   [[eosio::on_notify("eosio.token::transfer")]]
   void on_transfer( const name& from, const name& to, const asset& quantity,
                     const std::string& memo );

private:
   static constexpr symbol UOS_SYM        = symbol( "UOS", 8 );
   static constexpr name   TOKEN_CONTRACT = "eosio.token"_n;
   // Fixed "postage" — the dapp only ever sends exactly this (see dapp's
   // POSTAGE_QUANTITY). Rejecting anything else means a future bug that
   // routes a larger transfer (e.g. a bundled tip action) into this memo
   // slot fails loudly instead of getting silently stranded here forever —
   // this contract has no withdraw action, so any accepted amount is
   // permanent.
   static constexpr int64_t POSTAGE_AMOUNT = 1;   // 0.00000001 UOS at 8 decimals
   // No protocol-level memo length limit exists for eosio.token::transfer
   // (verified against the Ultra agent KB, docs 01/03/11) — this cap is our
   // own contract-enforced design choice, not a discovered chain fact.
   static constexpr size_t   MAX_MSG_LEN       = 256;

   // Flood control (our own design choice — not a chain-level protection;
   // Ultra's free-tx scheduler and RAM policy don't stop one account from
   // flooding a single room since RAM here is billed to get_self(), not the
   // sender). Enforced in-contract so it can't be bypassed by calling
   // eosio.token::transfer directly instead of going through the dapp UI.
   static constexpr uint32_t COOLDOWN_SECONDS  = 5;
   static constexpr uint32_t DAY_SECONDS       = 24 * 60 * 60;
   static constexpr uint32_t MAX_MSGS_PER_DAY  = 50;

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
};
} // namespace ultra
