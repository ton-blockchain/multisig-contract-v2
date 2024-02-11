# Multisignature Wallet

This set of contracts provide "N-of-M multisig" functionality: at least N parties out of predefined set of M _signers_ must approve **Order** to execute it.

Each **Order** may contain arbitrary number of actions: outcoming messages and updates of parameters. Since content of the messages is arbitrary **Order** may execute arbitrary high-level interactions on TON: sending TONs, sending/minting jettons, execute administrative duty, etc.

Parameters, such as threshold N, list of _signers_ and other can only be updated by consensus of current N-of-M owners.

Any _signer_ may propose new **Order**. Multisignature wallet also allows to assign _proposer_ role: _proposer_ may suggest new Orders but can not approve them.

Each **Order** has expiration date after which it can not be executed.

Each _signer_ may be wallet, hard-ware wallet, multisig themselves as well as other smart-contracts with its own logic.

This Multisignature wallet was developed keeping in mind [Safe{Wallet}](https://app.safe.global/welcome).

## Guarantees

- Nobody except _proposers_ and _signers_ can initiate creation of new order, nobody except _signers_ can approve new order.
- Change of the _signers_ set invalidates all orders with old set.
- _Signer_ compromise, in particularly compromise of less than N _signers_, does not hinder to execute orders or to propose new ones (including orders which will remove compromised _signers_ from the signers list)
- _Proposer_ compromise does not hinder to execute orders or to propose new ones (including orders which will remove compromised _proposer_ from the proposers list)
- Logic of multisignature wallet can not be changed after deploy

## Architecture
Whole system consists of four parts:
* Signers - independent actors who approves orders execution
* Proposers - helper actors who may propose new orders for execution
* Multisig - contract that execute approved orders, thus it is address which will own assets and permissions; Multisig contract also store information on number of orders, current Signers and Proposers sets
* Orders - child contracts, each of them holds information on one order: content of the order and approvals

Flow is as follows:
1) proposer of new order (address from Proposers or Signers sets) build new order which consist of arbitrary number transfers from Multisig address and sends request to Multisig to start approval of this order
2) Multisig receives the request, check that it is sent from authorized actor and deploy child sub-contract Order which holds order content
3) Signers independently send approval messages to Order contract
4) Once Order gets enough approvals it sends request to execute order to Multisig
5) Multisig authenticate Order (that it is indeed sent by Order and not by somebody else) as well as that set of Signers is still relevant and execute order (sends transfers from order)
6) If Order needs to have more than 255 transfers (limit of transfers in one tx), excessive transactions may be packed in last transfer from Multisig to itself as `internal_execute`
7) Multisig receives `internal_execute`, checks that it is sent from itself and continue execution.

All fees on processing order (except order execution itself): creation Order contract and it's storage fees are borne by the actor who propose this order (whether it's Proposer or Signer).

Besides transfers, Order may also contain Multisig Update Requests



## Project structure

-   `contracts` - source code of all the smart contracts of the project and their dependencies.
-   `wrappers` - wrapper classes (implementing `Contract` from ton-core) for the contracts, including any [de]serialization primitives and compilation functions.
-   `tests` - tests for the contracts.
-   `scripts` - scripts used by the project, mainly the deployment scripts.

## How to use

### Build

`npx blueprint build` or `yarn blueprint build`

### Test

`npx blueprint test` or `yarn blueprint test`

### Deploy or run another script

`npx blueprint run` or `yarn blueprint run`

use Toncenter API:

`npx blueprint run --custom https://testnet.toncenter.com/api/v2/ --custom-version v2 --custom-type testnet --custom-key <API_KEY> `

API_KEY can be obtained on https://toncenter.com or https://testnet.toncenter.com


