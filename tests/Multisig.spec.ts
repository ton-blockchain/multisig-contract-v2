import { Blockchain, SandboxContract, TreasuryContract, internal, prettyLogTransactions, BlockchainSnapshot, BlockchainTransaction } from '@ton/sandbox';
import { beginCell, Cell, toNano, internal as internal_relaxed, Address, SendMode, Dictionary } from '@ton/core';
import { Action, Multisig, MultisigConfig, TransferRequest, UpdateRequest } from '../wrappers/Multisig';
import { Order } from '../wrappers/Order';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { randomAddress, findTransactionRequired, findTransaction} from '@ton/test-utils';
import { Op, Errors, Params } from '../wrappers/Constants';
import { getRandomInt, differentAddress, Txiterator, executeTill, executeFrom} from './utils';

describe('Multisig', () => {
    let code: Cell;

    let blockchain: Blockchain;
    let multisig: SandboxContract<Multisig>;
    let deployer : SandboxContract<TreasuryContract>;
    let proposer : SandboxContract<TreasuryContract>;
    let signers  : Address[];
    let testMsg : TransferRequest;
    let testAddr : Address;
    let initialState: BlockchainSnapshot;

    let curTime : () => number;

    beforeAll(async () => {
        code = await compile('Multisig');
        blockchain = await Blockchain.create();

        const _libs = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
        let order_code_raw = await compile('Order');
        _libs.set(BigInt(`0x${order_code_raw.hash().toString('hex')}`), order_code_raw);
        const libs = beginCell().storeDictDirect(_libs).endCell();
        blockchain.libs = libs;

        deployer = await blockchain.treasury('deployer');
        proposer = await blockchain.treasury('proposer');
        signers  = [deployer, ...await blockchain.createWallets(4)].map(s => s.address);

        let config = {
            threshold: 1,
            signers,
            proposers: [proposer.address],
            allowArbitrarySeqno: false,
        };

        testAddr = randomAddress();
        testMsg = { type: "transfer", sendMode: 1, message: internal_relaxed({to: testAddr, value: toNano('0.015'), body: beginCell().storeUint(12345, 32).endCell()})};

        multisig = blockchain.openContract(Multisig.createFromConfig(config, code));
        const deployResult = await multisig.sendDeploy(deployer.getSender(), toNano('0.05'));

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: multisig.address,
            deploy: true,
            success: true,
        });

        initialState = blockchain.snapshot();

        curTime = () => blockchain.now ?? Math.floor(Date.now() / 1000);
    });
    // Each case state is independent
    afterEach(async () => await blockchain.loadFrom(initialState));

    it('should deploy', async () => {
        // the check is done inside beforeEach
        // blockchain and Multisig are ready to use
    });
    it('only signers and proposers should be able to create order', async () => {
        const nobody   = await blockchain.treasury('nobody');


        const initialSeqno = (await multisig.getMultisigData()).nextOrderSeqno;
        let   orderAddress = await multisig.getOrderAddress(initialSeqno);

        blockchain.now = Math.floor(Date.now() / 1000)
        const msgSigner= Multisig.newOrderMessage([testMsg],  blockchain.now + 1000,
                                                         true, // is signer
                                                         0, // Address index
                                                        );
        // Make sure proposers a checked against list too
        const msgProp  = Multisig.newOrderMessage([testMsg],  blockchain.now + 1000,
                                                         false, // is signer
                                                         0, // Address index
                                                        );

        let assertUnauthorizedOrder= (txs: BlockchainTransaction[], from: Address) => {
            expect(txs).toHaveTransaction({
                from,
                to: multisig.address,
                success: false,
                aborted: true,
                exitCode: Errors.multisig.unauthorized_new_order
            });
            expect(txs).not.toHaveTransaction({
                from: multisig.address,
                to: orderAddress,
                deploy: true
            });
        }
        let nobodyMsgs = [msgSigner, msgProp];
        for (let nbMessage of nobodyMsgs) {
            let res = await blockchain.sendMessage(internal({
                from: nobody.address,
                to: multisig.address,
                body: nbMessage,
                value: toNano('1')
            }));

            assertUnauthorizedOrder(res.transactions, nobody.address);
        }

        // Sending from valid proposer address should result in order creation
        let res = await blockchain.sendMessage(internal({
            from: proposer.address,
            to: multisig.address,
            body: msgProp,
            value: toNano('1')
        }));

        expect(res.transactions).toHaveTransaction({
            from : proposer.address,
            to: multisig.address,
            success: true
        });
        expect(res.transactions).toHaveTransaction({
            from: multisig.address,
            to: orderAddress,
            deploy: true,
            success: true
        });
        // But should not trigger execution
        expect(res.transactions).not.toHaveTransaction({
            from: orderAddress,
            to: multisig.address,
            op: Op.multisig.execute
        });

        // Order seqno should increase
        orderAddress = await multisig.getOrderAddress(initialSeqno + 1n);
        // Sending signer message from proposer should fail
        res = await blockchain.sendMessage(internal({
            from: proposer.address,
            to: multisig.address,
            body: msgSigner,
            value: toNano('1')
        }));
        assertUnauthorizedOrder(res.transactions, proposer.address);
        // Proposer message from signer should fail as well
        res = await blockchain.sendMessage(internal({
            from: deployer.address,
            to: multisig.address,
            body: msgProp,
            value: toNano('1')
        }));
        assertUnauthorizedOrder(res.transactions, deployer.address);
        // Now test signer
        res = await blockchain.sendMessage(internal({
            from: deployer.address,
            to: multisig.address,
            body: msgSigner,
            value: toNano('1')
        }));

        expect(res.transactions).toHaveTransaction({
            from : deployer.address,
            to: multisig.address,
            success: true
        });
        expect(res.transactions).toHaveTransaction({
            from: multisig.address,
            to: orderAddress,
            deploy: true,
            success: true
        });
        // Now execution should trigger, since threshold is 1
        expect(res.transactions).toHaveTransaction({
            from: orderAddress,
            to: multisig.address,
            op: Op.multisig.execute
        });
    });
    it('order expiration time should exceed current time', async () => {

        const initialSeqno = (await multisig.getMultisigData()).nextOrderSeqno;
        let   orderAddress = await multisig.getOrderAddress(initialSeqno);

        const res = await multisig.sendNewOrder(deployer.getSender(), [testMsg], curTime() - 100);
        expect(res.transactions).toHaveTransaction({
            from: deployer.address,
            to: multisig.address,
            success: false,
            aborted: true,
            exitCode: Errors.multisig.expired
        });
        expect(res.transactions).not.toHaveTransaction({
            from: multisig.address,
            to: orderAddress
        });
    });
    it('should reject order creation with insufficient incomming value', async () => {
        const year = 3600 * 24 * 365;

        const initialSeqno = (await multisig.getMultisigData()).nextOrderSeqno;
        let   orderAddress = await multisig.getOrderAddress(initialSeqno);

        // Twice as low as we need
        const msgValue = (await multisig.getOrderEstimate([testMsg], BigInt(curTime() + year))) / 2n;

        const res = await multisig.sendNewOrder(deployer.getSender(), [testMsg], curTime() + year, msgValue);
        expect(res.transactions).toHaveTransaction({
            from: deployer.address,
            to: multisig.address,
            success: false,
            aborted: true,
            exitCode: Errors.multisig.not_enough_ton
        });
        expect(res.transactions).not.toHaveTransaction({
            from: multisig.address,
            to: orderAddress
        });
    });
    it('deployed order state should match requested', async () => {
        // Let's deploy multisig with randomized parameters

        const signersNum = getRandomInt(10, 20);
        const signers   = await blockchain.createWallets(signersNum);
        const proposers = await blockchain.createWallets(getRandomInt(10, 20));

        let config = {
            threshold: signersNum - getRandomInt(1, 5),
            signers: signers.map(s => s.address),
            proposers: proposers.map(p => p.address),
            allowArbitrarySeqno: false,
        };

        const testMultisig = blockchain.openContract(Multisig.createFromConfig(config, code));

        let res = await testMultisig.sendDeploy(signers[0].getSender(), toNano('1'));
        expect(res.transactions).toHaveTransaction({
            to: testMultisig.address,
            deploy: true,
            success: true
        });


        const initialSeqno = (await testMultisig.getMultisigData()).nextOrderSeqno;
        let   orderAddress = await testMultisig.getOrderAddress(initialSeqno);


        const rndBody = beginCell().storeUint(getRandomInt(100, 1000), 32).endCell();
        const rndMsg : TransferRequest = {type:"transfer", sendMode: 1, message: internal_relaxed({to: testAddr, value: toNano('0.015'), body: rndBody})};
        res = await testMultisig.sendNewOrder(signers[getRandomInt(0, signers.length - 1)].getSender(), [rndMsg], curTime() + 100);
        expect(res.transactions).toHaveTransaction({
            from: testMultisig.address,
            to: orderAddress,
            deploy: true,
            success: true
        });

        const orderContract = blockchain.openContract(Order.createFromAddress(orderAddress));
        const orderData = await orderContract.getOrderData();

        // console.log("Order signers:", orderData.signers);
        // console.log("Orig signers:", config.signers);

        const stringifyAddr = (a: Address) => a.toString();
        expect(orderData.multisig).toEqualAddress(testMultisig.address);
        expect(orderData.signers.map(stringifyAddr)).toEqual(config.signers.map(stringifyAddr));
        expect(orderData.executed).toBe(false);
        expect(orderData.threshold).toEqual(config.threshold);
        expect(orderData.approvals_num).toBe(1);
    });
    it('should execute new message order', async () => {
        let initialSeqno = (await multisig.getMultisigData()).nextOrderSeqno;
        // await blockchain.setVerbosityForAddress(multisig.address, {blockchainLogs:true, vmLogs: 'vm_logs'});
        const res = await multisig.sendNewOrder(deployer.getSender(), [testMsg], Math.floor(curTime() + 100));

        expect(res.transactions).toHaveTransaction({
            from: deployer.address,
            to: multisig.address,
            success: true,
            outMessagesCount: 1
        });
        expect((await multisig.getMultisigData()).nextOrderSeqno).toEqual(initialSeqno + 1n);
        let orderAddress = await multisig.getOrderAddress(initialSeqno);
        expect(res.transactions).toHaveTransaction({
            from: multisig.address,
            to: orderAddress,
            success: true
        });
        // one signer and threshold is 1
        expect(res.transactions).toHaveTransaction({
            from: multisig.address,
            to: testAddr,
            value: toNano('0.015'),
            body: testMsg.message.body
        });
    });
    it('expired order execution should be denied', async () => {
        let initialSeqno = (await multisig.getMultisigData()).nextOrderSeqno;
        blockchain.now   = curTime();
        const deployRes  = await multisig.sendNewOrder(proposer.getSender(), [testMsg], blockchain.now + 1);
        let orderAddress = await multisig.getOrderAddress(initialSeqno);
        expect(deployRes.transactions).toHaveTransaction({
            from: multisig.address,
            on: orderAddress,
            op: Op.order.init,
            deploy: true,
            success: true
        });
        // Some time passed after init
        blockchain.now++;
        let txIter = new Txiterator(blockchain,internal({
                from: deployer.address,
                to: orderAddress,
                value: toNano('1'),
                body: beginCell().storeUint(Op.order.approve, Params.bitsize.op)
                                 .storeUint(0, Params.bitsize.queryId)
                                 .storeUint(0, Params.bitsize.signerIndex)
                                 .endCell()
        }));

        const orderContract = blockchain.openContract(Order.createFromAddress(orderAddress));

        let txs = await executeTill(txIter,{
            from: orderAddress,
            on: deployer.address,
            op: Op.order.approved,
            success: true,
        });

        findTransactionRequired(txs, {
            from: deployer.address,
            on: orderAddress,
            op: Op.order.approve,
            success: true,
            outMessagesCount: 2 // Make sure both approval notification and exec message is produced
        });
        // Make sure exec transaction is not yet proccessed
        expect(findTransaction(txs, {
            from: orderAddress,
            on: multisig.address,
            op: Op.multisig.execute
        })).not.toBeDefined();
        // While message was in transit, some more time passed
        blockchain.now++;
        // Continue execution
        txs = await executeFrom(txIter);
        // Execute message was sent, but failed due to expiery
        expect(txs).toHaveTransaction({
            from: orderAddress,
            on: multisig.address,
            op: Op.multisig.execute,
            success: false,
            aborted: true,
            exitCode: Errors.order.expired
        });
        expect((await orderContract.getOrderData()).executed).toBe(true);
        // Double check that order has not been executed.
        expect(txs).not.toHaveTransaction({
            from: multisig.address,
            on: testAddr,
            op: 12345
        });
    });
    it('should be possible to execute order by post init approval', async () => {
        // Same test as above, but with manulal approval
        let initialSeqno = (await multisig.getMultisigData()).nextOrderSeqno;
        // Gets deployed by proposer, so first approval is not granted right away
        let res = await multisig.sendNewOrder(proposer.getSender(), [testMsg], Math.floor(curTime() + 100));

        expect(res.transactions).toHaveTransaction({
            from: proposer.address,
            to: multisig.address,
            success: true,
            outMessagesCount: 1
        });
        expect((await multisig.getMultisigData()).nextOrderSeqno).toEqual(initialSeqno + 1n);
        let orderAddress = await multisig.getOrderAddress(initialSeqno);
        const orderContract = blockchain.openContract(Order.createFromAddress(orderAddress));
        const dataBefore = await orderContract.getOrderData();

        expect(dataBefore.approvals_num).toBe(0);
        expect(dataBefore.executed).toBe(false);

        // Here goes the approval
        res = await orderContract.sendApprove(deployer.getSender(), 0);
        expect(res.transactions).toHaveTransaction({
            from: orderAddress,
            to: multisig.address,
            op: Op.multisig.execute,
            success: true
        });
        // one signer and threshold is 1
        expect(res.transactions).toHaveTransaction({
            from: multisig.address,
            to: testAddr,
            value: toNano('0.015'),
            body: testMsg.message.body
        });
    });

    it('order estimate should work', async () => {
        const testMsg: TransferRequest = {type: "transfer", sendMode: 1, message: internal_relaxed({to: randomAddress(), value: toNano('0.015'), body: beginCell().storeUint(12345, 32).endCell()})};
        const hrEst = await multisig.getOrderEstimate([testMsg], BigInt(curTime() + 3600));
        console.log("Estimate for one hour:", hrEst);
        const yearEst = await multisig.getOrderEstimate([testMsg], BigInt(curTime() + 3600 * 24 * 365));
        console.log("Estimate for yearly storage:", yearEst);
        console.log("Storage delta:", yearEst - hrEst);
    });
    it('should send new order with many actions in specified order', async () => {
        const testAddr1 = randomAddress();
        const testAddr2 = randomAddress();
        const testMsg1: TransferRequest = { type: "transfer", sendMode: 1, message: internal_relaxed({to: testAddr1, value: toNano('0.015'), body: beginCell().storeUint(12345, 32).endCell()})};
        const testMsg2: TransferRequest = {type : "transfer", sendMode: 1, message: internal_relaxed({to: testAddr2, value: toNano('0.016'), body: beginCell().storeUint(12346, 32).endCell()})};
        let initialSeqno = (await multisig.getMultisigData()).nextOrderSeqno;
        let res = await multisig.sendNewOrder(deployer.getSender(), [testMsg1, testMsg2], Math.floor(Date.now() / 1000 + 1000));

        expect(res.transactions).toHaveTransaction({
            from: deployer.address,
            to: multisig.address,
            success: true,
            outMessagesCount: 1
        });
        expect((await multisig.getMultisigData()).nextOrderSeqno).toEqual(initialSeqno + 1n);
        let orderAddress = await multisig.getOrderAddress(initialSeqno);
        expect(res.transactions).toHaveTransaction({
            from: multisig.address,
            to: orderAddress,
            success: true
        });

        let order1Tx = findTransactionRequired(res.transactions, {
            from: multisig.address,
            to: testAddr1,
            value: toNano('0.015'),
            body: beginCell().storeUint(12345, 32).endCell(),
        });
        let order2Tx = findTransactionRequired(res.transactions, {
            from: multisig.address,
            to: testAddr2,
            value: toNano('0.016'),
            body: beginCell().storeUint(12346, 32).endCell(),
        });

        expect(order2Tx).not.toBeUndefined();
        expect(order2Tx!.lt).toBeGreaterThan(order1Tx!.lt);
        // Let's switch the order

        res = await multisig.sendNewOrder(deployer.getSender(), [testMsg2, testMsg1], Math.floor(Date.now() / 1000 + 1000));

        order1Tx = findTransactionRequired(res.transactions, {
            from: multisig.address,
            to: testAddr1,
            value: toNano('0.015'),
            body: beginCell().storeUint(12345, 32).endCell(),
        });
        order2Tx = findTransactionRequired(res.transactions, {
            from: multisig.address,
            to: testAddr2,
            value: toNano('0.016'),
            body: beginCell().storeUint(12346, 32).endCell(),
        });
        // Now second comes first
        expect(order2Tx!.lt).toBeLessThan(order1Tx!.lt);
    });
    it('should execute update multisig parameters correctly', async () => {
        const newSigners = await blockchain.createWallets(4);
        const updOrder : UpdateRequest = {
            type: "update",
            threshold: 4,
            signers: newSigners.map(s => s.address),
            proposers: []
        };
        let initialSeqno = (await multisig.getMultisigData()).nextOrderSeqno;
        //todo adjust for new order seqno behavior
        let res = await multisig.sendNewOrder(deployer.getSender(), [updOrder], Math.floor(Date.now() / 1000 + 1000));

        expect((await multisig.getMultisigData()).nextOrderSeqno).toEqual(initialSeqno + 1n);
        let orderAddress = await multisig.getOrderAddress(initialSeqno);
        expect(res.transactions).toHaveTransaction({
            from: multisig.address,
            to: orderAddress,
            success: true
        });
        expect(res.transactions).toHaveTransaction({
            from: orderAddress,
            to: multisig.address,
            op: Op.multisig.execute,
            success: true
        });

        const dataAfter = await multisig.getMultisigData();
        expect(dataAfter.threshold).toEqual(BigInt(updOrder.threshold));
        expect(dataAfter.signers[0]).toEqualAddress(newSigners[0].address);
        expect(dataAfter.proposers.length).toBe(0);
    });
    it('should reject multisig parameters with inconsistently ordered signers or proposers', async () => {
        // To produce inconsistent dictionary we have to craft it manually
        const malformed = Dictionary.empty(Dictionary.Keys.Uint(8), Dictionary.Values.Address());
        malformed.set(0, randomAddress());
        malformed.set(2, randomAddress());
        let updateCell = beginCell().storeUint(Op.actions.update_multisig_params, 32)
                                    .storeUint(4, 8)
                                    .storeDict(malformed) // signers
                                    .storeDict(null) // empty proposers
                         .endCell();

        const orderDict = Dictionary.empty(Dictionary.Keys.Uint(8), Dictionary.Values.Cell());
        orderDict.set(0, updateCell);

        let orderCell = beginCell().storeDictDirect(orderDict).endCell();

        let dataBefore   = await multisig.getMultisigData();
        let orderAddress = await multisig.getOrderAddress(dataBefore.nextOrderSeqno);
        let res = await multisig.sendNewOrder(deployer.getSender(), orderCell, curTime() + 100);
        expect(res.transactions).toHaveTransaction({
            from: orderAddress,
            to: multisig.address,
            op: Op.multisig.execute,
            aborted: true,
            success: false,
            exitCode: Errors.multisig.invalid_dictionary_sequence
        });

        const stringify = (x: Address) => x.toString();
        let dataAfter = await multisig.getMultisigData();
        // Order seqno should increase
        expect(dataAfter.nextOrderSeqno).toEqual(dataBefore.nextOrderSeqno + 1n);
        // Rest stay same
        expect(dataAfter.threshold).toEqual(dataBefore.threshold);
        expect(dataAfter.signers.map(stringify)).toEqual(dataBefore.signers.map(stringify));
        expect(dataAfter.proposers.map(stringify)).toEqual(dataBefore.proposers.map(stringify));

        dataBefore   = await multisig.getMultisigData();
        orderAddress = await multisig.getOrderAddress(dataBefore.nextOrderSeqno);

        // Now let's test if proposers order is checked
        malformed.clear();
        // Let's be bit sneaky. It's kinda consistent, but starts with 1. Should fail anyways.
        malformed.set(1, randomAddress());
        malformed.set(2, randomAddress());

        updateCell = beginCell().storeUint(Op.actions.update_multisig_params, 32)
                                .storeUint(4, 8)
                                .storeDict(null) // Empty signers? Yes, that is allowed
                                .storeDict(malformed) // proposers
                     .endCell();

        // All over again
        orderDict.set(0, updateCell);
        orderCell = beginCell().storeDictDirect(orderDict).endCell();

        res = await multisig.sendNewOrder(deployer.getSender(), orderCell, curTime() + 100);
        expect(res.transactions).toHaveTransaction({
            from: orderAddress,
            to: multisig.address,
            op: Op.multisig.execute,
            aborted: true,
            success: false,
            exitCode: Errors.multisig.invalid_dictionary_sequence
        });

        dataAfter = await multisig.getMultisigData();
        // Order seqno should increase
        expect(dataAfter.nextOrderSeqno).toEqual(dataBefore.nextOrderSeqno + 1n);
        // Rest stay same
        expect(dataAfter.threshold).toEqual(dataBefore.threshold);
        expect(dataAfter.signers.map(stringify)).toEqual(dataBefore.signers.map(stringify));
        expect(dataAfter.proposers.map(stringify)).toEqual(dataBefore.proposers.map(stringify));
    });
    it('should accept execute internal only from self address', async () => {
        const nobody = await blockchain.treasury('nobody');
        // Let's test every role
        const roles = [deployer, proposer, nobody];
        const testAddr  = randomAddress();
        const testReq: TransferRequest = {
            type: "transfer",
            sendMode: 1,
            message: internal_relaxed({
                to: testAddr,
                value: toNano('0.01'),
                body: beginCell().storeUint(0x12345, 32).endCell()
            })
        };

        const order_dict = Dictionary.empty(Dictionary.Keys.Uint(8), Dictionary.Values.Cell());
        order_dict.set(0, Multisig.packTransferRequest(testReq));
        const testBody = beginCell().storeUint(Op.multisig.execute_internal, Params.bitsize.op)
                                    .storeUint(0, Params.bitsize.queryId)
                                    .storeRef(beginCell().storeDictDirect(order_dict).endCell())
                         .endCell();

        for (let testWallet of roles) {
            let res = await blockchain.sendMessage(internal({
                from: testWallet.address,
                to: multisig.address,
                value: toNano('1'),
                body: testBody
            }));
            expect(res.transactions).toHaveTransaction({
                from: testWallet.address,
                to: multisig.address,
                op: Op.multisig.execute_internal,
                aborted: true
            });
            expect(res.transactions).not.toHaveTransaction({
                from: multisig.address,
                to: testAddr
            });
        }
    });
    it('chained execution should work', async () => {

        const testAddr = randomAddress();
        const testBody = beginCell().storeUint(0x12345, 32).endCell();
        const chainedReq: TransferRequest = {
            type: "transfer",
            sendMode: 1,
            message: internal_relaxed({
                to: testAddr,
                value: toNano('0.01'),
                body: testBody
            })
        };
        const order_dict = Dictionary.empty(Dictionary.Keys.Uint(8), Dictionary.Values.Cell());
        order_dict.set(0, Multisig.packTransferRequest(chainedReq));
        const triggerReq: TransferRequest = {
            type: "transfer",
            sendMode: 1,
            message: internal_relaxed({
            to: multisig.address,
            value: toNano('0.01'),
            body: beginCell().storeUint(Op.multisig.execute_internal, Params.bitsize.op)
                            .storeUint(0, Params.bitsize.queryId)
                            .storeRef(beginCell().storeDictDirect(order_dict).endCell())
                  .endCell()
            })
        };
        const res = await multisig.sendNewOrder(deployer.getSender(), [triggerReq], curTime() + 1000, toNano('1'));

        expect(res.transactions).toHaveTransaction({
            from: deployer.address,
            to: multisig.address,
            success: true
        });
        // Self message
        expect(res.transactions).toHaveTransaction({
            from: multisig.address,
            to: multisig.address,
            op: Op.multisig.execute_internal,
            success: true
        });
        // Chained message
        expect(res.transactions).toHaveTransaction({
            from: multisig.address,
            to: testAddr,
            value: toNano('0.01'),
            body: testBody
        });
    });
    it('multisig should invalidate previous orders if signers change', async () => {
        const testAddr = randomAddress();
        const testBody = beginCell().storeUint(0x12345, 32).endCell();

        const dataBefore = await multisig.getMultisigData();
        const orderAddr    = await multisig.getOrderAddress(dataBefore.nextOrderSeqno);
        const testMsg: TransferRequest = {
            type: "transfer",
            sendMode: 1,
            message: internal_relaxed({
                to: multisig.address,
                value: toNano('0.015'),
                body: testBody
            })
        };
        const updOrder : UpdateRequest = {
            type: "update",
            threshold: Number(dataBefore.threshold),
            signers: [differentAddress(deployer.address)],
            proposers: dataBefore.proposers
        };

        // First we deploy order with proposer, so it doesn't execute right away
        let res = await multisig.sendNewOrder(proposer.getSender(), [testMsg], curTime() + 1000);
        expect(res.transactions).toHaveTransaction({
            from: multisig.address,
            to: orderAddr,
            deploy: true,
            success: true
        });
        // Now lets perform signers update
        res = await multisig.sendNewOrder(deployer.getSender(), [updOrder], curTime() + 100);

        expect(res.transactions).toHaveTransaction({
            from: deployer.address,
            to: multisig.address,
            success: true
        });
        expect((await multisig.getMultisigData()).signers[0]).not.toEqualAddress(dataBefore.signers[0]);

        const orderContract = blockchain.openContract(Order.createFromAddress(orderAddr));
        // Now let's approve old order
        res = await orderContract.sendApprove(deployer.getSender(), 0);
        expect(res.transactions).toHaveTransaction({
            from: orderAddr,
            to: multisig.address,
            op: Op.multisig.execute,
            aborted: true,
            success: false,
            exitCode: Errors.multisig.singers_outdated
        });
    });
    it('multisig should invalidate previous orders if threshold increased', async () => {
        const dataBefore = await multisig.getMultisigData();
        const orderAddr  = await multisig.getOrderAddress(dataBefore.nextOrderSeqno);
        const testBody = beginCell().storeUint(0x12345, 32).endCell();
        const testMsg: TransferRequest = {
            type: "transfer",
            sendMode: 1,
            message: internal_relaxed({
                to: multisig.address,
                value: toNano('0.015'),
                body: testBody
            })
        };
        const updOrder : UpdateRequest = {
            type: "update",
            threshold: Number(dataBefore.threshold) + 1, // threshold increases
            signers, // Doesn't change
            proposers: dataBefore.proposers
        };
        // First we deploy order with proposer, so it doesn't execute right away
        let res = await multisig.sendNewOrder(proposer.getSender(), [testMsg], curTime() + 1000);
        expect(res.transactions).toHaveTransaction({
            from: multisig.address,
            to: orderAddr,
            deploy: true,
            success: true
        });
        // Now lets perform threshold update
        res = await multisig.sendNewOrder(deployer.getSender(), [updOrder], curTime() + 100);

        expect(res.transactions).toHaveTransaction({
            from: deployer.address,
            to: multisig.address,
            success: true
        });
        expect((await multisig.getMultisigData()).threshold).toEqual(dataBefore.threshold + 1n);

        const orderContract = blockchain.openContract(Order.createFromAddress(orderAddr));
        // Now let's approve old order
        res = await orderContract.sendApprove(deployer.getSender(), 0);
        expect(res.transactions).toHaveTransaction({
            from: orderAddr,
            to: multisig.address,
            op: Op.multisig.execute,
            aborted: true,
            success: false,
            exitCode: Errors.multisig.singers_outdated
        });
    });
    it('multisig should not execute orders deployed by other multisig contract', async () => {
        const coolHacker = await blockchain.treasury('1337');
        const newConfig : MultisigConfig = {
            threshold: 1,
            signers: [coolHacker.address], // So deployment init is same except just one field (so still different address)
            proposers: [proposer.address],
            allowArbitrarySeqno : false
        };

        const evilMultisig = blockchain.openContract(Multisig.createFromConfig(newConfig,code));

        const legitData = await multisig.getMultisigData();
        let res = await evilMultisig.sendDeploy(coolHacker.getSender(), toNano('10'));
        expect(res.transactions).toHaveTransaction({
            from: coolHacker.address,
            to: evilMultisig.address,
            deploy: true,
            success: true
        });
        const evilPayload: TransferRequest = {
            type: "transfer",
            sendMode: 1,
            message: internal_relaxed({
                to: coolHacker.address,
                value: toNano('100000'), // Evil enough? Could have changed multisig params even
                body: beginCell().storeUint(1337, 32).endCell()
            })
        };
        const order_dict = Dictionary.empty(Dictionary.Keys.Uint(8), Dictionary.Values.Cell());
        order_dict.set(0, Multisig.packTransferRequest(evilPayload));

        const mock_signers = Dictionary.empty(Dictionary.Keys.Uint(8), Dictionary.Values.Address());
        // Copy the real signers
        for (let i = 0; i < legitData.signers.length; i++) {
            mock_signers.set(i, legitData.signers[i]);
        }
        const evalOrder: TransferRequest = {
            type: "transfer",
            sendMode: 1,
            message: internal_relaxed({
            to: multisig.address,
            value: toNano('0.01'),
            body: beginCell().storeUint(Op.multisig.execute, Params.bitsize.op)
                            .storeUint(0, Params.bitsize.queryId)
                            .storeUint(legitData.nextOrderSeqno, Params.bitsize.orderSeqno)
                            .storeUint(0xffffffffffff, Params.bitsize.time)
                            .storeUint(0xff, Params.bitsize.signerIndex)
                            .storeUint(BigInt('0x' + beginCell().storeDictDirect(mock_signers).endCell().hash().toString('hex')), 256) // pack legit hash
                            .storeRef(beginCell().storeDictDirect(order_dict).endCell()) // Finally eval payload
                  .endCell()
            })
        };

        res = await evilMultisig.sendNewOrder(coolHacker.getSender(), [evalOrder], curTime() + 100);

        expect(res.transactions).toHaveTransaction({
            from: evilMultisig.address,
            to: multisig.address,
            op: Op.multisig.execute,
            aborted: true,
            success: false,
            exitCode: Errors.multisig.unauthorized_execute
        });
        // No funds exfiltrated
        expect(res.transactions).not.toHaveTransaction({
            from: multisig.address,
            to: coolHacker.address
        });
    });
    it('should handle more than 255 orders', async () => {

        // Topping up
        await blockchain.sendMessage(internal({
            from: deployer.address,
            to: multisig.address,
            body: beginCell().storeUint(0, 32).storeUint(0, 64).endCell(),
            value: toNano('1000')
        }));
        const orderCount = getRandomInt(260, 500);

        console.log(`Charging ${orderCount} orders!`);
        const order : Array<Action> = Array(orderCount);

        for(let i = 0; i < orderCount; i++) {
            order[i] = {
                type: "transfer",
                sendMode: 1,
                message: internal_relaxed({
                    to: deployer.address,
                    value: toNano('0.01'),
                    body: beginCell().storeUint(i, 32).endCell()
                })
            };
        }

        console.log("Fire!");
        const res = await multisig.sendNewOrder(deployer.getSender(), order, curTime() + 100, toNano('100'));

        expect(res.transactions).toHaveTransaction({
            to: multisig.address,
            op: Op.multisig.execute,
            success: true
        });
        expect(res.transactions).toHaveTransaction({
            to: multisig.address,
            op: Op.multisig.execute_internal
        });

        let prevLt = 0n;
        for(let i = 0; i < orderCount; i++) {
            // console.log("Testing tx:", i);
            const tx = findTransactionRequired(res.transactions, {
                from: multisig.address,
                to: deployer.address,
                op: i,
            });
            // console.log("Got tx:i");
            expect(tx.lt).toBeGreaterThan(prevLt); // Check tx order
            prevLt = tx.lt;
        }
    });
});
