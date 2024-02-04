import { Address, beginCell, Cell, internal as internal_relaxed, toNano } from '@ton/core';
import { Order, OrderConfig } from '../wrappers/Order';
import { Op, Errors, Params } from "../wrappers/Constants";
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { findTransactionRequired, randomAddress } from '@ton/test-utils';
import { Blockchain, BlockchainSnapshot, SandboxContract, TreasuryContract, internal } from '@ton/sandbox';
import { differentAddress, getMsgPrices, getRandomInt, storageCollected, computedGeneric } from './utils';
import { Multisig, TransferRequest } from '../wrappers/Multisig';

describe('Order', () => {
    let code: Cell;
    let blockchain: Blockchain;
    let threshold: number;
    let orderContract : SandboxContract<Order>;
    let mockOrder: Cell;
    let multisig : SandboxContract<TreasuryContract>;
    let signers: Array<SandboxContract<TreasuryContract>>;
    let notSigner: SandboxContract<TreasuryContract>;
    let prevState: BlockchainSnapshot;
    let prices : ReturnType<typeof getMsgPrices>;
    let getContractData : (addr: Address) => Promise<Cell>;

    beforeAll(async () => {
        code =await compile('Order');
        blockchain = await Blockchain.create();
        multisig = await blockchain.treasury('multisig');
        notSigner = await blockchain.treasury('notSigner');
        const testAddr = randomAddress();
        const testMsg : TransferRequest = { type: "transfer", sendMode: 1, message: internal_relaxed({to: testAddr, value: toNano('0.015'), body: beginCell().storeUint(12345, 32).endCell()})};

        mockOrder = Multisig.packOrder([testMsg]);

        orderContract = blockchain.openContract(Order.createFromConfig({
            multisig: multisig.address,
            orderSeqno: 0
        }, code));

        prices = getMsgPrices(blockchain.config, 0);

        getContractData = async (address: Address) => {
          const smc = await blockchain.getContract(address);
          if(!smc.account.account)
            throw("Account not found")
          if(smc.account.account.storage.state.type != "active" )
            throw("Atempting to get data on inactive account");
          if(!smc.account.account.storage.state.state.data)
            throw("Data is not present");
          return smc.account.account.storage.state.state.data
        }


        blockchain.now = Math.floor(Date.now() / 1000);
        const expDate =  blockchain.now + 1000;

        threshold = 5
        signers = await blockchain.createWallets(threshold * 2);
        const res = await orderContract.sendDeploy(multisig.getSender(), toNano('1'), signers.map((s) => s.address), expDate, mockOrder, threshold);
        expect(res.transactions).toHaveTransaction({deploy: true, success: true});

        const stringify = (addr: Address) => addr.toString();
        const orderData = await orderContract.getOrderData();

        // Overlaps with "deployed order state should match requested" case from Multisig.spec.ts but won't hurt
        expect(orderData.multisig).toEqualAddress(multisig.address);
        expect(orderData.order_seqno).toBe(0n);
        expect(orderData.expiration_date).toEqual(BigInt(expDate));
        expect(orderData.approvals_num).toBe(0); // Number of approvals
        expect(orderData._approvals).toBe(0n); // Approvals raw bitmask
        expect(orderData.signers_num).toEqual(signers.length);
        expect(orderData.signers.map(stringify)).toEqual(signers.map(s => stringify(s.address)));
        expect(orderData.threshold).toBe(5);
        expect(orderData.executed).toBe(false);
        expect(orderData.order).toEqualCell(mockOrder);

        prevState = blockchain.snapshot();
    });

    afterEach(async () => await blockchain.loadFrom(prevState));

    it('should deploy', async () => {
        // Happens in beforeAll clause
    });

    it('should only accept init message from multisig', async () => {

        const newOrder = blockchain.openContract(Order.createFromConfig({
            multisig: multisig.address,
            orderSeqno: 1234 // Next
        }, code));

        const expDate =  blockchain.now! + 1000;

        const testSender = await blockchain.treasury('totally_not_multisig');
        let res = await newOrder.sendDeploy(testSender.getSender(), toNano('1'), signers.map(s => s.address), expDate, mockOrder, threshold);

        expect(res.transactions).toHaveTransaction({
            from: testSender.address,
            to: newOrder.address,
            success: false,
            aborted: true,
            exitCode: Errors.order.unauthorized_init
        });

        // Now retry with legit multisig should succeed
        const dataBefore = await newOrder.getOrderData();
        expect(dataBefore.inited).toBe(false);
        expect(dataBefore.threshold).toBe(null);

        res = await newOrder.sendDeploy(multisig.getSender(), toNano('1'), signers.map(s => s.address), expDate, mockOrder, threshold);

        expect(res.transactions).toHaveTransaction({
            from: multisig.address,
            to: newOrder.address,
            success: true,
        });

        const dataAfter = await newOrder.getOrderData();
        expect(dataAfter.inited).toBe(true);
        expect(dataAfter.threshold).toEqual(threshold);
    });
    it('should reject already expired init message', async () => {
        const newOrder = blockchain.openContract(Order.createFromConfig({
            multisig: multisig.address,
            orderSeqno: 123 // Next
        }, code));
        const expDate = blockchain.now! - 1;

        let res = await newOrder.sendDeploy(multisig.getSender(), toNano('1'), signers.map(s => s.address), expDate, mockOrder, threshold);

        expect(res.transactions).toHaveTransaction({
            from: multisig.address,
            on: newOrder.address,
            op: Op.order.init,
            success: false,
            aborted: true,
            deploy: true,
            exitCode: Errors.order.expired
        });

        const dataBefore = await newOrder.getOrderData();
        expect(dataBefore.inited).toBe(false);
        expect(dataBefore.threshold).toBe(null);

        // now == expiration_date should be allowed (currently not allowed).
        res = await newOrder.sendDeploy(multisig.getSender(), toNano('1'), signers.map(s => s.address), blockchain.now!, mockOrder, threshold);

        expect(res.transactions).toHaveTransaction({
            from: multisig.address,
            on: newOrder.address,
            op: Op.order.init,
            success: true,
        });

        const dataAfter = await newOrder.getOrderData();
        expect(dataAfter.inited).toBe(true);
        expect(dataAfter.threshold).toEqual(threshold);
    });
    it('order contract should accept init message only once', async () => {
        const expDate = blockchain.now! + 1000;
        const newSigners = await blockchain.createWallets(10);
        const dataBefore = await getContractData(orderContract.address);

        const res = await orderContract.sendDeploy(multisig.getSender(), toNano('1'), newSigners.map((s) => s.address), expDate, mockOrder, threshold);

        expect(res.transactions).toHaveTransaction({
            from: multisig.address,
            to: orderContract.address,
            success: false,
            aborted: true,
            exitCode: Errors.order.already_inited
        });

        // To be extra sure that there is no commit()
        expect(dataBefore).toEqualCell(await getContractData(orderContract.address));
    });

    it('should approve order', async () => {
        const idxMap = Array.from(signers.keys());
        let idxCount = idxMap.length - 1;
        for (let i = 0; i < threshold; i++) {
            let signerIdx: number;
            if(idxCount > 1) {
                // Removing used index
                signerIdx = idxMap.splice(getRandomInt(0, idxCount), 1)[0];
                idxCount--;
            }
            else {
                signerIdx = 0;
            }
            const signerWallet = signers[signerIdx];
            const res = await orderContract.sendApprove(signerWallet.getSender(), signerIdx);
            const thresholdHit = i == threshold - 1;

            expect(res.transactions).toHaveTransaction({
                from: signerWallet.address,
                to: orderContract.address,
                success: true,
                outMessagesCount: thresholdHit ? 2 : 1
            });

            expect(res.transactions).toHaveTransaction({
                from: orderContract.address,
                to: signerWallet.address,
                op: Op.order.approved
            });

            const orderData = await orderContract.getOrderData();

            expect(orderData.approvals_num).toEqual(i + 1);
            expect(orderData.approvals[signerIdx]).toBe(true);
            expect(orderData.executed).toEqual(thresholdHit);

            if(thresholdHit) {
                expect(res.transactions).toHaveTransaction({
                    from: orderContract.address,
                    to: multisig.address,
                    op: Op.multisig.execute
                });
            }
            else {
                expect(res.transactions).not.toHaveTransaction({
                    from: orderContract.address,
                    to: multisig.address,
                    op: Op.multisig.execute
                });
            }
        }
    });

    it('should approve order with comment', async () => {
        let   signerIdx  = 0;
        let signer     = signers[signerIdx];
        let dataBefore = await orderContract.getOrderData();
        expect(dataBefore.inited).toBe(true);
        let res = await blockchain.sendMessage(internal({
                from: signer.address,
                to: orderContract.address,
                value: toNano('1'),
                body: beginCell().storeUint(0, 32).storeStringTail("approve").endCell()
        }));
        expect(res.transactions).toHaveTransaction({
            from: orderContract.address,
            to: signer.address,
            op: Op.order.approved,
            success: true
        });
        let dataAfter  = await orderContract.getOrderData();

        expect(dataAfter.approvals_num).toEqual(dataBefore.approvals_num! + 1);
        expect(dataAfter._approvals).toBeGreaterThan(dataBefore._approvals!);
        expect(dataAfter.approvals[signerIdx]).toBe(true);

        dataBefore = dataAfter;

        // Repeat, but with "tricky comment"
        signerIdx  = 1;
        signer     = signers[signerIdx];

        res = await blockchain.sendMessage(internal({
                from: signer.address,
                to: orderContract.address,
                value: toNano('1'),
                body: beginCell().storeUint(0, 32).storeStringTail("approve")
                          .storeRef(beginCell().storeStringTail(" not given").endCell())
                          .endCell()
        }));

        expect(res.transactions).toHaveTransaction({
            from: signer.address,
            to: orderContract.address,
            success: false
        });
        dataAfter  = await orderContract.getOrderData();

        // All should stay same
        expect(dataAfter.approvals_num).toEqual(dataBefore.approvals_num);
        expect(dataAfter._approvals).toEqual(dataBefore._approvals);

        // Repeat, but with other "tricky comment"
        signerIdx  = 1;
        signer     = signers[signerIdx];
        res = await blockchain.sendMessage(internal({
                from: signer.address,
                to: orderContract.address,
                value: toNano('1'),
                body: beginCell().storeUint(0, 32).storeStringTail("approve not given").endCell()
        }));

        expect(res.transactions).toHaveTransaction({
            from: signer.address,
            to: orderContract.address,
            success: false
        });
        dataAfter  = await orderContract.getOrderData();

        // All should stay same
        expect(dataAfter.approvals_num).toEqual(dataBefore.approvals_num);
        expect(dataAfter._approvals).toEqual(dataBefore._approvals);
    });


    it('should reject order with comment from not signer', async () => {
        let   signerIdx  = 0;
        let signer     = notSigner;
        let dataBefore = await orderContract.getOrderData();
        let res = await blockchain.sendMessage(internal({
                from: signer.address,
                to: orderContract.address,
                value: toNano('1'),
                body: beginCell().storeUint(0, 32).storeStringTail("approve").endCell()
        }));

        expect(res.transactions).toHaveTransaction({
            from: signer.address,
            to: orderContract.address,
            success: false,
            exitCode: Errors.order.unauthorized_sign
        });
        let dataAfter  = await orderContract.getOrderData();

        // All should stay same
        expect(dataAfter.approvals_num).toEqual(dataBefore.approvals_num);
        expect(dataAfter._approvals).toEqual(dataBefore._approvals);

    });
    it('should accept approval only from signers', async () => {
        let signerIdx  = getRandomInt(0, signers.length - 1);

        const rndSigner = signers[signerIdx];
        const notSigner = differentAddress(signers[signerIdx].address);

        let dataBefore = await getContractData(orderContract.address);

        // Testing not valid signer address, but valid signer index
        let res = await orderContract.sendApprove(blockchain.sender(notSigner), signerIdx);
        expect(res.transactions).toHaveTransaction({
            from: notSigner,
            to: orderContract.address,
            op: Op.order.approve,
            aborted: true,
            success: false,
            exitCode: Errors.order.unauthorized_sign
        });

        expect(await getContractData(orderContract.address)).toEqualCell(dataBefore);

        // Now let's pick valid signer address but index from another valid signer

        signerIdx = (signerIdx + 1) % signers.length;

        res = await orderContract.sendApprove(rndSigner.getSender(), signerIdx);

        expect(res.transactions).toHaveTransaction({
            from: rndSigner.address,
            to: orderContract.address,
            op: Op.order.approve,
            aborted: true,
            success: false,
            exitCode: Errors.order.unauthorized_sign
        });

        expect(await getContractData(orderContract.address)).toEqualCell(dataBefore);
    });
    it('should reject approval if already approved', async () => {
        const signersNum = signers.length;
        // Pick random starting point
        let   signerIdx  = getRandomInt(0, signersNum - 1);
        for (let i = 0; i < 3; i++) {
            let signer     = signers[signerIdx];
            let dataBefore = await orderContract.getOrderData();
            let res = await orderContract.sendApprove(signer.getSender(), signerIdx);
            expect(res.transactions).toHaveTransaction({
                from: signer.address,
                to: orderContract.address,
                op: Op.order.approve,
                success: true
            });
            let dataAfter  = await orderContract.getOrderData();

            expect(dataAfter.inited).toBe(true);
            expect(dataAfter.approvals_num).toEqual(dataBefore.approvals_num! + 1);
            expect(dataAfter._approvals).toBeGreaterThan(dataBefore._approvals!);
            expect(dataAfter.approvals[signerIdx]).toBe(true);

            dataBefore = dataAfter;

            // Repeat
            res = await orderContract.sendApprove(signer.getSender(), signerIdx);
            expect(res.transactions).toHaveTransaction({
                from: signer.address,
                to: orderContract.address,
                op: Op.order.approve,
                success: false,
                aborted: true
            })

            dataAfter  = await orderContract.getOrderData();

            // All should stay same
            expect(dataAfter.approvals_num).toEqual(dataBefore.approvals_num);
            expect(dataAfter._approvals).toEqual(dataBefore._approvals);
            // Make sure it doesn't reset
            expect(dataAfter.approvals[signerIdx]).toBe(true);

            // Increment, but respect array length
            signerIdx = ++signerIdx % signersNum;
        }
    });

    it('should reject execution when expired', async () => {
        for (let i = 0; i < threshold - 1; i++) {
            const res = await orderContract.sendApprove(signers[i].getSender(), i);
            expect(res.transactions).toHaveTransaction({
                from: signers[i].address,
                to: orderContract.address,
                success: true
            });
        }

        let dataAfter = await orderContract.getOrderData();
        expect(dataAfter.inited).toBe(true);
        expect(dataAfter.approvals_num).toBe(4);

        // Now last one is late

        blockchain.now = Number(dataAfter.expiration_date! + 1n);

        // Pick at random
        const signerIdx  = getRandomInt(threshold - 1, signers.length - 1);
        const lastSigner = signers[signerIdx];
        const msgValue   = toNano('1');
        const balanceBefore = (await blockchain.getContract(orderContract.address)).balance;
        const res = await orderContract.sendApprove(lastSigner.getSender(), signerIdx, msgValue);

        let approveTx = findTransactionRequired(res.transactions, {
            from: lastSigner.address,
            on: orderContract.address,
            op: Op.order.approve,
            success: true,
            outMessagesCount: 2
        });

        // Excess message
        expect(res.transactions).toHaveTransaction({
            from: orderContract.address,
            on: lastSigner.address,
            op: Op.order.expired,
            value: msgValue - prices.lumpPrice - computedGeneric(approveTx).gasFees,
            success: true,
        });
        // Return balance leftovers
        expect(res.transactions).toHaveTransaction({
            from: orderContract.address,
            on: multisig.address,
            op: Op.order.expired,
            value: balanceBefore - prices.lumpPrice - storageCollected(approveTx),
            success: true
        });
        expect(res.transactions).not.toHaveTransaction({
            from: orderContract.address,
            to: multisig.address,
            op: Op.multisig.execute,
        });

        dataAfter = await orderContract.getOrderData();

        expect(dataAfter.approvals_num).toEqual(threshold - 1);
        expect(dataAfter.executed).toBe(false);
    });
    it('should reject execution when executed once', async () => {
        const msgVal = toNano('1');
        for (let i = 0; i < threshold; i++) {
            const res = await orderContract.sendApprove(signers[i].getSender(), i, msgVal);
            expect(res.transactions).toHaveTransaction({
                from: signers[i].address,
                to: orderContract.address,
                success: true
            });
            // Meh! TS made me do dat!
            if(i == threshold - 1) {
                expect(res.transactions).toHaveTransaction({
                    from: orderContract.address,
                    to: multisig.address,
                    op: Op.multisig.execute
                });
            }
        }

        const dataAfter = await orderContract.getOrderData();
        expect(dataAfter.executed).toBe(true);

        const lateSigner = signers[threshold];
        expect(dataAfter.approvals[threshold]).toBe(false); // Make sure we're not failing due to occupied approval index

        const res = await orderContract.sendApprove(lateSigner.getSender(), threshold, msgVal);

        const approveTx = findTransactionRequired(res.transactions, {
                from: lateSigner.address,
                on: orderContract.address,
                op: Op.order.approve,
                success: true,
                outMessagesCount: 1
        });
        // Return excess
        expect(res.transactions).toHaveTransaction({
            from: orderContract.address,
            on: lateSigner.address,
            op: Op.order.already_executed,
            value: msgVal - prices.lumpPrice - computedGeneric(approveTx).gasFees,
            success: true
        });
        // No execution message
        expect(res.transactions).not.toHaveTransaction({
            from: orderContract.address,
            to: multisig.address,
            op: Op.multisig.execute
        });
    });

    it('should handle 255 signers', async () => {
        const jumboSigners = await blockchain.createWallets(255);
        const jumboOrder   = blockchain.openContract(Order.createFromConfig({
            multisig: multisig.address,
            orderSeqno: 1
        }, code));

        let res = await jumboOrder.sendDeploy(multisig.getSender(), toNano('1'), jumboSigners.map(s => s.address), blockchain.now! + 1000, mockOrder, jumboSigners.length);

        expect(res.transactions).toHaveTransaction({
            from: multisig.address,
            to: jumboOrder.address,
            deploy: true,
            success: true
        });

        // Now let's vote

        for (let i = 0; i < jumboSigners.length; i++) {
            res = await jumboOrder.sendApprove(jumboSigners[i].getSender(), i);
            expect(res.transactions).toHaveTransaction({
                from: jumboSigners[i].address,
                to: jumboOrder.address,
                op: Op.order.approve,
                success: true
            });

            const dataAfter = await jumboOrder.getOrderData();
            expect(dataAfter.approvals_num).toEqual(i + 1);
            expect(dataAfter.approvals[i]).toBe(true);
        }

        expect(res.transactions).toHaveTransaction({
            from: jumboOrder.address,
            to: multisig.address,
            op: Op.multisig.execute,
        });
    });

});
