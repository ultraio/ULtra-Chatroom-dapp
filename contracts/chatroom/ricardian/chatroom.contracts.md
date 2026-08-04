<h1 class="contract">ban</h1>

---
spec_version: "0.2.0"
title: Ban an account from the chat room
summary: 'Ban {{nowrap account}} from posting in the chat room'
icon:
---

As the owner of this chat room contract, I ban {{account}} from the room.

After this action, any `eosio.token::transfer` from {{account}} to this
contract is rejected, so {{account}} can no longer post messages, and the
official dapp hides {{account}}'s existing messages until they age out of the
retention window.

This action does not delete or alter any data already recorded on chain — the
chain's message history is public and immutable. Banning only prevents new
posts and hides prior ones in the dapp UI. Banning an account that is already
banned has no additional effect.

<h1 class="contract">unban</h1>

---
spec_version: "0.2.0"
title: Unban an account
summary: 'Lift the ban on {{nowrap account}}'
icon:
---

As the owner of this chat room contract, I lift the ban on {{account}}.

After this action, {{account}} may post messages again, and the official dapp
stops hiding {{account}}'s messages. Unbanning an account that is not currently
banned has no effect.
