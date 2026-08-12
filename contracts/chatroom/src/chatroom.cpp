#include <chatroom/chatroom.hpp>
#include <string_view>
#include <cstdint>

namespace ultra {
namespace {

// Split the memo AFTER the "/tip " prefix into receiver / amount / note.
// Tokens are separated by runs of ASCII space; note is the verbatim remainder
// after the amount token (leading spaces trimmed). The dapp mirrors this rule
// so what the feed renders matches exactly what was forwarded.
struct tip_parts { std::string_view receiver; std::string_view amount; std::string_view note; };

tip_parts parse_tip( std::string_view m ) {
   auto skip_spaces = []( std::string_view& v ) {
      while ( !v.empty() && v.front() == ' ' ) v.remove_prefix( 1 );
   };
   auto take_token = []( std::string_view& v ) -> std::string_view {
      const size_t sp = v.find( ' ' );
      const std::string_view tok = v.substr( 0, sp );
      v.remove_prefix( sp == std::string_view::npos ? v.size() : sp );
      return tok;
   };
   skip_spaces( m );
   const std::string_view receiver = take_token( m );
   skip_spaces( m );
   const std::string_view amount = take_token( m );
   skip_spaces( m );
   return tip_parts{ receiver, amount, m };  // note = verbatim remainder
}

// Strict decimal -> asset at the symbol's precision. Accepts ONLY
// ^[0-9]+(\.[0-9]{1,precision})?$ ; everything else reverts. Keeping this strict
// matters for DISPLAY as well as funds: the memo is stored verbatim and the
// dapp re-reads the amount token to render the badge, so a lenient parse (e.g.
// "5abc" -> 5) would forward 5 yet show "5abc UOS".
eosio::asset parse_uos_amount( std::string_view s, const eosio::symbol& sym ) {
   using eosio::check;
   check( !s.empty(), "chatroom: tip amount is missing" );

   const size_t dot = s.find( '.' );
   const std::string_view int_part  = s.substr( 0, dot );
   const std::string_view frac_part =
      ( dot == std::string_view::npos ) ? std::string_view{} : s.substr( dot + 1 );

   check( dot == std::string_view::npos || frac_part.find( '.' ) == std::string_view::npos,
          "chatroom: tip amount has more than one decimal point" );
   check( !int_part.empty(), "chatroom: tip amount is missing its integer part" );
   check( dot == std::string_view::npos || !frac_part.empty(),
          "chatroom: tip amount has a trailing decimal point" );

   const uint8_t precision = sym.precision();
   check( frac_part.size() <= precision, "chatroom: tip amount has too many decimal places" );

   auto all_digits = []( std::string_view v ) {
      for ( char c : v ) if ( c < '0' || c > '9' ) return false;
      return true;
   };
   check( all_digits( int_part ) && all_digits( frac_part ),
          "chatroom: tip amount is not a number" );

   int64_t amount = 0;
   auto push_digit = [&]( int d ) {
      check( amount <= ( INT64_MAX - d ) / 10, "chatroom: tip amount is too large" );
      amount = amount * 10 + d;
   };
   for ( char c : int_part ) push_digit( c - '0' );
   for ( uint8_t i = 0; i < precision; ++i )
      push_digit( i < frac_part.size() ? frac_part[i] - '0' : 0 );

   return eosio::asset( amount, sym );
}

} // namespace

void chatroom::on_transfer( const name& from, const name& to, const asset& quantity,
                            const std::string& memo ) {
   if (from == get_self() || to != get_self()) return;   // inbound only; ignore our own outflows

   // spoofed-token defense (KB 03 §4.2 / 11 §2): identify the token by the
   // contract that actually notified us, not by trusting the memo/symbol alone.
   check( get_first_receiver() == TOKEN_CONTRACT,
          "chatroom: only eosio.token transfers are accepted" );
   check( quantity.symbol == UOS_SYM, "chatroom: only UOS is accepted" );
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

   // Reserved "/tip " path: forward the whole amount to the recipient and store
   // the memo as a normal message. The amount stated in the memo MUST equal the
   // amount actually received, so the recorded "/tip X N …" text can never claim
   // more than was paid (the dapp badges "/tip " rows on this guarantee). A
   // normal (non-tip) transfer must be exactly postage. Either way the emplace
   // below stores the verbatim memo; any failed check here reverts the whole tx.
   std::string_view mv{ memo };
   if ( mv.substr( 0, TIP_PREFIX.size() ) == TIP_PREFIX ) {
      const tip_parts parts = parse_tip( mv.substr( TIP_PREFIX.size() ) );
      const name receiver{ parts.receiver };
      check( is_account( receiver ),  "chatroom: tip recipient does not exist" );
      check( receiver != from,        "chatroom: cannot tip yourself" );
      check( receiver != get_self(),  "chatroom: cannot tip the room" );
      check( parse_uos_amount( parts.amount, UOS_SYM ) == quantity,
             "chatroom: tip amount does not match the transfer" );
      // Forward inline (requires <contract>@eosio.code on active). The forward
      // executes AFTER this handler returns; if it asserts (e.g. overdrawn
      // balance) the entire transaction — including the message row below —
      // reverts, so the contract never keeps tip funds. Its self-notification
      // is absorbed by the `from == get_self()` guard at the top of on_transfer.
      const std::string fwd_memo =
         parts.note.empty() ? std::string( "Tip via Ultra Chat" ) : std::string( parts.note );
      action(
         permission_level{ get_self(), "active"_n },
         TOKEN_CONTRACT, "transfer"_n,
         std::make_tuple( get_self(), receiver, quantity, fwd_memo )
      ).send();
   } else {
      check( quantity.amount == POSTAGE_AMOUNT,
             "chatroom: transfer must be exactly the postage amount" );
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
