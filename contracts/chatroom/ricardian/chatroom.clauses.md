<h1 class="clause">DataStorage</h1>

Messages sent to this contract, and the sender account of each, are recorded on
the public Ultra blockchain and are world-readable and immutable. The contract
retains only the most recent messages room-wide (older ones are pruned on
write); pruning removes rows from current contract state but does not erase the
historical record from the chain. Do not send anything you are unwilling to
publish permanently and publicly.

<h1 class="clause">Moderation</h1>

The contract owner may ban or unban accounts. A ban prevents an account from
posting new messages and causes the official dapp to hide that account's
existing messages, but does not delete on-chain data. Use of this contract is
provided as-is, with no warranty.
