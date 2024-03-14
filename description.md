# Description

## What is order?

Order in essence is sequential list of one or more actions executed by multisig wallet contract.

## Order contract state

- `multisig_address` parent multisig address.
- `order_seqno` sequential number of the order contract.
- `threshold` number of signatures required to start order execution.
- `sent_for_execution?` flag indication whether order has been executed already
- `signers` Dictionary containing contract addresses allowed to sign order execution
- `approvals_mask` Bit field where `true` bit at n-th position indicates approval granted from n-th signer.
- `approvals_num` Total number of granted approvals.
- `expiration_date` Once current time exceeds this timestamp, order can't be executed anymore.
- `order` Cell containing action descriptors.


### Order actions

#### Message

When executing message order, multisig will send arbitrary message described by action.

#### Multisig parameters update

When executing update order, multisig will update it's parameters according to action.

Updatable parameters are:
- `signers`
- `threshold`

## Order life cycle

Order life cycle consists of following steps:

- Order initialization.
- Order approval(sign).
- Order execution.

## Execution guarantees

- Order can only be executed once. If execution is unsuccessful (no enough TON on Mutlisig, signer list changes, threshold became higher) Order can not be reused; new Order should be created and approved.
- Order actions are executed one-by-one sequentially, that means Multisignature contract sends messages in the same order they are specified in Order (note that if destination of messages are in different shards, messages will be delivered asynchronously, possibly in different order).
- Order can't be executed after it's expiration date.
- Once approval is granted by signer, it can't be revoked.

### The order actions on the multisig are performed by the balance of the multisig

Make sure you have enough balance on your multisig.

## Order initialization

[Initialization message](https://github.com/ton-blockchain/multisig-contract-v2/blob/master/contracts/multisig.tlb#L74) is sent from `multisig` wallet, creating new order contract.  
Only `multisig_address` and `order_seqno` are part of [InitState](https://docs.ton.org/develop/data-formats/msg-tlb#stateinit-tl-b) structure (defining future contract address).  
Rest of the order state parameters are passed in a message body.  
`approve_on_init` parameter set to `true` indicates that initializer wants to sign for order during the initialization.

### Transaction chain
`wallet->multisig->new order`

## Order approval

Order approvals only accepted till the order `expiration_date`.  
Order approval may be granted either by [initialization](https://github.com/ton-blockchain/multisig-contract-v2/blob/master/contracts/multisig.tlb#L74) or [approve](https://github.com/ton-blockchain/multisig-contract-v2/blob/master/contracts/multisig.tlb#L82) message.

`signer_index` field indicates index in `signers` dictionary to check sender address against.

Approval by init will only be accepted from multisig address, where approve
message will be accepted if sender address match the address
at `signers[signer_index]`.

### Transaction chain

`multisig->order`

## Order execution

Once number of approvals reaches `threshold`, the
[execute message](https://github.com/ton-blockchain/multisig-contract-v2/blob/master/contracts/multisig.tlb#L62)
is sent back to multisig contract among with the whole order contract balance.
Multisig contract [performs checks](https://github.com/ton-blockchain/multisig-contract-v2/blob/0c7eb74064fea6a77c7a29c0a11d357588b2fceb/contracts/multisig.func#L142)
on the input order data and accepts it
for execution if all checks passed successfully

### Transaction chain

`order->multisig`

## Required order contract balance

Order contract balance should be enough for:

- Storage till `expiration_date`.
- Execution of the multisig contract till order is [accepted](https://github.com/ton-blockchain/multisig-contract-v2/blob/0c7eb74064fea6a77c7a29c0a11d357588b2fceb/contracts/multisig.func#L23) for execution

## Order fees calculation

During order initialization we must make sure that message value
would be enough to cover:

- Order initialization transaction chain.
- Order storage
- Execution of approve logic in case `approve_on_init` is `true`.
- Order execution transaction chain in case `approve_on_init` is `true` and `threshold = 1`

### How is it calculated

Fees are calculated in [order_helper.fc#53](https://github.com/ton-blockchain/multisig-contract-v2/blob/0c7eb74064fea6a77c7a29c0a11d357588b2fceb/contracts/order_helpers.func#L53)

Constants are used as a base values, however
size of signers cell and order body size is dynamic.
Therefore dynamically calculated sizes and gas consumption is added to those base values.

``` func
  int initial_gas = gas_consumed();
  (int order_cells, int order_bits, _)     = compute_data_size(order_body, 8192);
	(int signers_cells, int signers_bits, _) = compute_data_size(signers, 512);
	int size_counting_gas = gas_consumed() - initial_gas;
```

To get these gas consumption constants, we use two test cases.
- With small signers size:[tests/FeeComputation.spec.ts#L199](https://github.com/ton-blockchain/multisig-contract-v2/blob/0c7eb74064fea6a77c7a29c0a11d357588b2fceb/tests/FeeComputation.spec.ts#L199) referred as "small signers"
- With maximum signers size:[tests/FeeComputation.spec.ts#L205](https://github.com/ton-blockchain/multisig-contract-v2/blob/0c7eb74064fea6a77c7a29c0a11d357588b2fceb/tests/FeeComputation.spec.ts#L205) referred as "large test"


[contracts/order_helpers.func#L63](https://github.com/ton-blockchain/multisig-contract-v2/blob/0c7eb74064fea6a77c7a29c0a11d357588b2fceb/contracts/order_helpers.func#L63)

#### Forward fees

Forward fees are required to cover message sending.
For all of the overheads, the `small signers` test is used.

Related constants:

`INIT_ORDER_BITS_OVERHEAD` and `INIT_ORDER_CELL_OVERHEAD`
Represent total bits and cells used by order init message reduced by
bits and cells occupied by order body.  
[tests/FeeComputation.spec.ts#L123](https://github.com/ton-blockchain/multisig-contract-v2/blob/0c7eb74064fea6a77c7a29c0a11d357588b2fceb/tests/FeeComputation.spec.ts#L123)
``` javascript
            /*
              tx0 : external -> treasury
              tx1: treasury -> multisig
              tx2: multisig -> order
            */
  let orderBody = (await order.getOrderData()).order;
  let orderBodyStats = collectCellStats(orderBody!, []);

  let multisigToOrderMessage = res.transactions[2].inMessage!;
  let multisigToOrderMessageStats = computeMessageForwardFees(curMsgPrices, multisigToOrderMessage).stats;
  let initOrderStateOverhead = multisigToOrderMessageStats.sub(orderBodyStats);

```

`EXECUTE_ORDER_BIT_OVERHEAD` and `EXECUTE_ORDER_CELL_OVERHEAD`
follow the same logic, but for execute message `order->multisig`.  
[tests/FeeComputation.spec.ts#L149](https://github.com/ton-blockchain/multisig-contract-v2/blob/0c7eb74064fea6a77c7a29c0a11d357588b2fceb/tests/FeeComputation.spec.ts#L149)

``` javascript
/*
  tx0 : external -> treasury
  tx1: treasury -> order
  tx2: order -> treasury (approve)
  tx3: order -> multisig
  tx4+: multisig -> destination
*/
let orderToMultiownerMessage      = secondApproval.transactions[3].inMessage!;
let orderToMultiownerMessageStats = computeMessageForwardFees(curMsgPrices, orderToMultiownerMessage).stats;
let orderToMultiownerMessageOverhead = orderToMultiownerMessageStats.sub(orderBodyStats);
```

Adds up with dynamic order body and signer sizes for
calculation of the related forward fees.

``` func
    int forward_fees = get_forward_fee(BASECHAIN,
                                       INIT_ORDER_BIT_OVERHEAD + order_bits + signers_bits,
                                       INIT_ORDER_CELL_OVERHEAD + order_cells + signers_cells) +
                       get_forward_fee(BASECHAIN,
                                       EXECUTE_ORDER_BIT_OVERHEAD + order_bits,
                                       EXECUTE_ORDER_CELL_OVERHEAD + order_cells);

```

#### Gas fees

Gas units are bound to the TVM instructions being executed
where gas fees may change with the network configuration.
Thus we rely on gas units.

[contracts/order_helpers.func#L75](https://github.com/ton-blockchain/multisig-contract-v2/blob/0c7eb74064fea6a77c7a29c0a11d357588b2fceb/contracts/order_helpers.func#L75)

`MULTISIG_INIT_ORDER_GAS` represents total gas units
required for execution of `op::new_order` on multisig side.
`large signers` test is used, and then `size_counting_gas` is deducted.
In order to get `size_counting_gas`, one would have to dump the value manually.

``` func
  int size_counting_gas = gas_consumed() - initial_gas;
  size_counting_gas~dump();

```
record the value and restore the source file.

[tests/FeeComputation.spec.ts#L106](https://github.com/ton-blockchain/multisig-contract-v2/blob/0c7eb74064fea6a77c7a29c0a11d357588b2fceb/tests/FeeComputation.spec.ts#L106)
``` javascript
            /*
              tx0 : external -> treasury
              tx1: treasury -> multisig
              tx2: multisig -> order
            */

  let MULTISIG_INIT_ORDER_GAS = computedGeneric(res.transactions[1]).gasUsed;
```

`ORDER_INIT_GAS` is amount of gas
consumed by order contract while processing `op::init`.  
`small signers` test is used due to it is not impacted by signers or order size.

[tests/FeeComputation.spec.ts#L108](https://github.com/ton-blockchain/multisig-contract-v2/blob/0c7eb74064fea6a77c7a29c0a11d357588b2fceb/tests/FeeComputation.spec.ts#L108)

``` javascript
  let ORDER_INIT_GAS = computedGeneric(res.transactions[2]).gasUsed;
```

`ORDER_EXECUTE_GAS` is amount of gas consumed by order contract
once execution threshold is reached.  
`large signers` test is used, because dictionary lookup cost depends on dictionary size.  
[contracts/order.func#L109](https://github.com/ton-blockchain/multisig-contract-v2/blob/0c7eb74064fea6a77c7a29c0a11d357588b2fceb/contracts/order.func#L109)  
Calculations:
[tests/FeeComputation.spec.ts#L157](https://github.com/ton-blockchain/multisig-contract-v2/blob/0c7eb74064fea6a77c7a29c0a11d357588b2fceb/tests/FeeComputation.spec.ts#L157)

``` javascript
  let ORDER_EXECUTE_GAS = computedGeneric(secondApproval.transactions[1]).gasUsed;
```

`MULTISIG_EXECUTE_GAS` is amount of gas consumed
by multisig prior to accepting order execution.  
For simplicity we use cost of execution of a 1 message order.
`small signers` test is used, due to it is not impacted by signers size.
[tests/FeeComputation.spec.ts#L159](https://github.com/ton-blockchain/multisig-contract-v2/blob/0c7eb74064fea6a77c7a29c0a11d357588b2fceb/tests/FeeComputation.spec.ts#L159)
``` javascript
  let MULTISIG_EXECUTE_GAS = actions.length > 1 ? 7310n : computedGeneric(secondApproval.transactions[3]).gasUsed;
```
While for a fact it's only required to cover gas till [contracts/multisig.func#L23](https://github.com/ton-blockchain/multisig-contract-v2/blob/0c7eb74064fea6a77c7a29c0a11d357588b2fceb/contracts/multisig.func#L23)

These constants summ up with `size_counting` dynamic value and gas fee is calculated for each
one of those separately.

[contracts/order_helpers.func#L70](https://github.com/ton-blockchain/multisig-contract-v2/blob/0c7eb74064fea6a77c7a29c0a11d357588b2fceb/contracts/order_helpers.func#L70)
``` func
    int gas_fees = get_compute_fee(BASECHAIN,MULTISIG_INIT_ORDER_GAS + size_counting_gas) +
    get_compute_fee(BASECHAIN, ORDER_INIT_GAS) +
    get_compute_fee(BASECHAIN, ORDER_EXECUTE_GAS) +
    get_compute_fee(BASECHAIN, MULTISIG_EXECUTE_GAS);
```

#### Storage fees

`ORDER_STATE_BIT_OVERHEAD` and `ORDER_STATE_CELL_OVERHEAD` is how many bits and
cells is occupied by order contract state without order body.  
`small signers` test is used, because `signers` and `order` overhead is added
dynamically
[tests/FeeComputation.spec.ts#L125](https://github.com/ton-blockchain/multisig-contract-v2/blob/0c7eb74064fea6a77c7a29c0a11d357588b2fceb/tests/FeeComputation.spec.ts#L125)
``` javascript
  let initOrderStateOverhead = multisigToOrderMessageStats.sub(orderBodyStats);
```

[contracts/order_helpers.func#L83](https://github.com/ton-blockchain/multisig-contract-v2/blob/0c7eb74064fea6a77c7a29c0a11d357588b2fceb/contracts/order_helpers.func#L83)
``` func
  int storage_fees = get_storage_fee(BASECHAIN, duration,
                                       ORDER_STATE_BIT_OVERHEAD + order_bits + signers_bits,
                                       ORDER_STATE_CELL_OVERHEAD + order_cells  + signers_cells);

```
