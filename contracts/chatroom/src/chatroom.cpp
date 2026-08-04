#include <chatroom/chatroom.hpp>

namespace ultra {

void chatroom::on_transfer( const name& from, const name& to, const asset& quantity,
                            const std::string& memo ) {
   if (from == get_self() || to != get_self()) return;   // inbound only; ignore our own outflows

   // spoofed-token defense (KB 03 §4.2 / 11 §2): identify the token by the
   // contract that actually notified us, not by trusting the memo/symbol alone.
   check( get_first_receiver() == TOKEN_CONTRACT,
          "chatroom: only eosio.token transfers are accepted" );
   check( quantity.symbol == UOS_SYM, "chatroom: only UOS is accepted" );
   check( quantity.amount == POSTAGE_AMOUNT, "chatroom: transfer must be exactly the postage amount" );
   check( memo.size() > 0, "chatroom: message cannot be empty" );
   check( memo.size() <= MAX_MSG_LEN, "chatroom: message too long (max 256 characters)" );

   // Moderation: banned accounts cannot post. Enforced here (not just hidden
   // in the dapp) so it can't be bypassed by calling eosio.token::transfer
   // directly, and so a banned account stops consuming this contract's RAM.
   // A failed check() reverts the whole transfer — no funds are taken.
   banned_table banned( get_self(), get_self().value );
   check( banned.find( from.value ) == banned.end(), "chatroom: account is banned from this room" );

   const time_point_sec now{ current_time_point() };

   // Flood control: 5s cooldown + 50 msgs/24h per sender, enforced here so it
   // can't be skipped by calling eosio.token::transfer directly. A rejected
   // check() reverts the whole transaction, including the transfer itself.
   senders_table senders( get_self(), get_self().value );
   auto sender_it = senders.find( from.value );
   if ( sender_it == senders.end() ) {
      senders.emplace( get_self(), [&]( auto& s ) {
         s.sender       = from;
         s.last_sent    = now;
         s.window_start = now;
         s.day_count    = 1;
      });
   } else {
      check( now.sec_since_epoch() - sender_it->last_sent.sec_since_epoch() >= COOLDOWN_SECONDS,
             "chatroom: sending too fast, wait 5 seconds between messages" );

      const bool new_window =
         now.sec_since_epoch() - sender_it->window_start.sec_since_epoch() >= DAY_SECONDS;
      if ( !new_window ) {
         check( sender_it->day_count < MAX_MSGS_PER_DAY,
                "chatroom: daily message limit reached (50 messages per day)" );
      }
      senders.modify( sender_it, get_self(), [&]( auto& s ) {
         s.last_sent = now;
         if ( new_window ) {
            s.window_start = now;
            s.day_count    = 1;
         } else {
            s.day_count += 1;
         }
      });
   }

   // Notify-context RAM rule (KB 03 §5.1): an unprivileged contract may only
   // bill its OWN account inside on_notify, never the sender's — so this
   // account must be kept funded with RAM as the room grows.
   messages_table messages( get_self(), get_self().value );
   const uint64_t new_id = messages.available_primary_key();
   messages.emplace( get_self(), [&]( auto& m ) {
      m.id      = new_id;
      m.sender  = from;
      m.text    = memo;
      m.sent_at = now;
   });

   // Room-wide retention: after inserting, drop rows older than the newest
   // MAX_ROOM_MESSAGES. available_primary_key() never decreases on erase, so
   // new_id keeps climbing and the threshold stays monotonic. begin() is the
   // oldest by id (no secondary index). Bounded by PRUNE_BATCH so a large
   // pre-upgrade backlog drains gradually instead of in one oversized tx.
   // (new_id >= id + MAX_ROOM_MESSAGES, written additively to avoid any
   // unsigned underflow on the id arithmetic.)
   int pruned = 0;
   for ( auto it = messages.begin();
         it != messages.end() && pruned < PRUNE_BATCH && it->id + MAX_ROOM_MESSAGES <= new_id;
         ++pruned ) {
      it = messages.erase( it );
   }
}

void chatroom::ban( const name& account ) {
   require_auth( get_self() );
   check( is_account( account ), "chatroom: account does not exist" );
   check( account != get_self(), "chatroom: cannot ban the room contract itself" );
   banned_table banned( get_self(), get_self().value );
   if ( banned.find( account.value ) == banned.end() ) {
      banned.emplace( get_self(), [&]( auto& b ) { b.account = account; } );
   }
}

void chatroom::unban( const name& account ) {
   require_auth( get_self() );
   banned_table banned( get_self(), get_self().value );
   auto it = banned.find( account.value );
   if ( it != banned.end() ) banned.erase( it );
}
} // namespace ultra
