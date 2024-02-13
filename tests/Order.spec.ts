import { Address, beginCell, Cell, internal as internal_relaxed, toNano, Transaction, Dictionary } from '@ton/core';
import { Order, OrderConfig } from '../wrappers/Order';
import { Op, Errors, Params } from "../wrappers/Constants";
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { findTransactionRequired, randomAddress } from '@ton/test-utils';
import { Blockchain, BlockchainSnapshot, SandboxContract, TreasuryContract, internal } from '@ton/sandbox';
import { differentAddress, getMsgPrices, getRandomInt, storageCollected, computedGeneric } from './utils';
import { Multisig, TransferRequest } from '../wrappers/Multisig';

type ApproveResponse = {
    status: number,
    query_id: bigint,
    exit_code?: number
};

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

    let testPartial : (cmp: any, match: any) => boolean;
    let testApproveResponse : (body: Cell, match:Partial<ApproveResponse>) => boolean;
    let testApprove: (txs: Transaction[], from: Address, to: Address,
                      exp: number, query_id?: number | bigint) => void;

    beforeAll(async () => {
        let code_raw = await compile('Order');
        blockchain = await Blockchain.create();

        const _libs = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
        _libs.set(BigInt(`0x${code_raw.hash().toString('hex')}`), code_raw);
        const libs = beginCell().storeDictDirect(_libs).endCell();
        blockchain.libs = libs;
        let lib_prep = beginCell().storeUint(2,8).storeBuffer(code_raw.hash()).endCell();
        code = new Cell({ exotic:true, bits: lib_prep.bits, refs:lib_prep.refs});


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
        testPartial = (cmp: any, match: any) => {
            for (let key in match) {
                if(!(key in cmp)) {
                    throw Error(`Unknown key ${key} in ${cmp}`);
                }

                if(match[key] instanceof Address) {
                    if(!(cmp[key] instanceof Address)) {
                        return false
                    }
                    if(!(match[key] as Address).equals(cmp[key])) {
                        return false
                    }
                }
                else if(match[key] instanceof Cell) {
                    if(!(cmp[key] instanceof Cell)) {
                        return false;
                    }
                    if(!(match[key] as Cell).equals(cmp[key])) {
                        return false;
                    }
                }
                else if(match[key] !== cmp[key]){
                    return false;
                }
            }
            return true;
        }
        testApproveResponse = (body, match) => {
            let exitCode: number;
            const ds = body.beginParse();
            const approveStatus = ds.loadUint(32);
            const cmp: ApproveResponse = {
                status: approveStatus,
                query_id: ds.loadUintBig(64),
                exit_code: approveStatus == Op.order.approve_rejected ? ds.loadUint(32) : undefined
            };
            return testPartial(cmp, match);
        }
        testApprove = (txs, from, on, exp) => {
            let expStatus: number;
            let exitCode: number | undefined;

            const approveTx = findTransactionRequired(txs, {
                from,
                on,
                op: Op.order.approve,
                success: true,
                outMessagesCount: (x) => x >= 1
            });
            const inMsg = approveTx.inMessage!;
            if(inMsg.info.type !== "internal")
                throw new Error("Can't be");

            const inQueryId = inMsg.body.beginParse().skip(32).preloadUintBig(64);
            const inValue   = inMsg.info.value;

            if(exp == 0) {
                expStatus    = Op.order.approved;
                exitCode = undefined;
            }
            else {
                expStatus    = Op.order.approve_rejected;
                exitCode = exp;
            }
            expect(txs).toHaveTransaction({
                // Response message
                from: on,
                on: from,
                body: (x) => testApproveResponse(x!, {
                    status: expStatus,
                    query_id: inQueryId,
                    exit_code: exitCode
                }),
                value: inValue.coins - prices.lumpPrice - computedGeneric(approveTx).gasFees
            })
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
    it('order contract should accept init message only once if approve_on_init = false', async () => {
        const expDate = Number((await orderContract.getOrderData()).expiration_date);
        const dataBefore = await getContractData(orderContract.address);
        const approveInit = false;

        const res = await orderContract.sendDeploy(multisig.getSender(), toNano('1'), signers.map(s => s.address), expDate, mockOrder, threshold, approveInit);

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
    it('order contract should reject secondary init vote if any of order info has changed', async() => {
        const approveOnInit = true;
        const idx           = 0;
        const newSigners    = (await blockchain.createWallets(10)).map(s => s.address);
        const curSigners    = signers.map(s => s.address);
        const stateBefore   = await getContractData(orderContract.address);
        const expInited     = Errors.order.already_inited;
        const expSuccess    = 0;
        const dataBefore    = await orderContract.getOrderData();
        const expDate       = Number(dataBefore.expiration_date);

        let   testInit = async (signers: Address[], expDate : number, order: Cell, threshold: number, exp: number) => {;
            const res = await orderContract.sendDeploy(multisig.getSender(), toNano('1'), signers, expDate, order, threshold, approveOnInit, idx);
            expect(res.transactions).toHaveTransaction({
                on: orderContract.address,
                from: multisig.address,
                success: exp == 0,
                aborted: exp != 0,
                exitCode: exp
            });
            if(exp == 0) {
                const dataAfter = await orderContract.getOrderData();
                expect(dataAfter.approvals_num).toEqual(Number(dataBefore.approvals_num) + 1);
                expect(dataAfter._approvals).toBeGreaterThan(dataBefore._approvals ?? 0n);
                expect(dataAfter.approvals[idx]).toBe(true);
            }
            else {
                expect(await getContractData(orderContract.address)).toEqualCell(stateBefore);
            }
        }
        // Change signers
        await testInit(newSigners, expDate, mockOrder, threshold, expInited);
        // Change expDate
        await testInit(curSigners, expDate + getRandomInt(100, 200), mockOrder, threshold, expInited);
        // Change order
        const testMsg : TransferRequest = { type: "transfer", sendMode: 1, message: internal_relaxed({to: randomAddress(0), value: ('0.015'), body: beginCell().storeUint(getRandomInt(100000, 200000), 32).endCell()})};
        const newOrder = Multisig.packOrder([testMsg]);

        expect(newOrder).not.toEqualCell(mockOrder);

        await testInit(curSigners, expDate, newOrder, threshold, expInited);
        // Change threshold
        await testInit(curSigners, expDate, mockOrder, threshold + getRandomInt(10, 20), expInited);
        // Expect success
        await testInit(curSigners, expDate, mockOrder, threshold, expSuccess);
    });
    it('order contract should treat multiple init messages as votes if approve_on_init = true', async () => {
        const approveOnInit = true;
        for(let i = 0; i < threshold; i++) {
            const dataBefore = await orderContract.getOrderData();
            const expDate    = Number(dataBefore.expiration_date);
            const res = await orderContract.sendDeploy(multisig.getSender(), toNano('1'), signers.map(s => s.address), expDate, mockOrder, threshold, approveOnInit, i);

            expect(res.transactions).toHaveTransaction({
                on: orderContract.address,
                from: multisig.address,
                op: Op.order.init,
                success: true
            });
            const dataAfter = await orderContract.getOrderData();

            expect(dataAfter.approvals_num).toEqual(i + 1);
            expect(dataAfter.approvals[i]).toBe(true);
            if(dataBefore.approvals === null) {
                expect(dataAfter._approvals).not.toBe(null);
            }
            else {
                expect(dataAfter._approvals).toBeGreaterThan(dataBefore._approvals!);
            }

            if(i + 1 == threshold) {
                expect(res.transactions).toHaveTransaction({
                    on: multisig.address,
                    from: orderContract.address,
                    op: Op.multisig.execute
                });
            }
        }
    })
    it('should not be possible to use multiple init msg to approve multiple idx twice', async () => {
        const expDate   = Number((await orderContract.getOrderData()).expiration_date);
        const signerIdx = getRandomInt(0, signers.length - 1);

        const approveOnInit = true;

        let   res = await orderContract.sendDeploy(multisig.getSender(), toNano('1'), signers.map(s => s.address), expDate, mockOrder, threshold, approveOnInit, signerIdx);

        expect(res.transactions).toHaveTransaction({
            on: orderContract.address,
            from: multisig.address,
            op: Op.order.init,
            success: true
        });

        let dataInit = await orderContract.getOrderData();
        expect(dataInit.approvals_num).toEqual(1);
        expect(dataInit.approvals[signerIdx]).toBe(true);

        let dataBefore = await getContractData(orderContract.address);
        // Repeat init
        res = await orderContract.sendDeploy(multisig.getSender(), toNano('1'), signers.map(s => s.address), expDate, mockOrder, threshold, approveOnInit, signerIdx);

        expect(res.transactions).toHaveTransaction({
            from: orderContract.address,
            // to: signers[signerIdx].address ?
            body: (x) => testApproveResponse(x!, {
                status: Op.order.approve_rejected,
                exit_code: Errors.order.already_approved
            })
        });

        expect(await getContractData(orderContract.address)).toEqualCell(dataBefore);
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

            testApprove(res.transactions, signerWallet.address, orderContract.address, 0);

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
        let testOrderComment = async (payload: Cell, exp: number) => {
            const rollBack   = blockchain.snapshot();

            const dataBefore = await orderContract.getOrderData();
            const rndIdx     = getRandomInt(0, signers.length - 1);
            const signer     = signers[rndIdx];
            const expSuccess = exp == 0;
            expect(Number(dataBefore.approvals_num)).toBe(0);


            const res = await blockchain.sendMessage(internal({
                from: signer.address,
                to: orderContract.address,
                value: toNano('1'),
                body: payload
            }));

            const dataAfter = await orderContract.getOrderData();

            if(expSuccess) {
                expect(res.transactions).toHaveTransaction({
                    from: orderContract.address,
                    to: signer.address,
                    op: Op.order.approved,
                    success: expSuccess,
                    aborted: false,
                    exitCode: 0
                });

                expect(dataAfter.approvals_num).toEqual(Number(dataBefore.approvals_num) + 1);
                expect(dataAfter._approvals).toBeGreaterThan(dataBefore._approvals ?? 0n);
                expect(dataAfter.approvals[rndIdx]).toBe(true);
            }
            else {
                expect(res.transactions).toHaveTransaction({
                    from: signer.address,
                    on: orderContract.address,
                    success: false,
                    aborted: true,
                    exitCode: exp
                });
                expect(dataAfter.approvals_num).toEqual(dataBefore.approvals_num);
                expect(dataAfter._approvals).toEqual(dataBefore._approvals);
                expect(dataAfter.approvals[rndIdx]).toBe(false);
            }
            await blockchain.loadFrom(rollBack);
        };

        let approveStr = "approve";

        // Plain approve should succeed
        await testOrderComment(beginCell().storeUint(0, 32)
                                          .storeStringTail(approveStr).endCell(), 0);
        // Start wit ref should succeed
        await testOrderComment(beginCell().storeUint(0, 32)
                                          .storeStringRefTail(approveStr).endCell(), 0);

        // Each letter in separate ref
        let joinedStr: Cell | undefined;
        let lettersLeft = approveStr.length - 1;

        do {
            const chunk = beginCell().storeStringTail(approveStr[lettersLeft]);
            if(joinedStr == undefined) {
                joinedStr = chunk.endCell();
            }
            else {
                joinedStr = chunk.storeRef(joinedStr).endCell();
            }
        } while(lettersLeft--);

        expect(joinedStr.depth()).toEqual(approveStr.length - 1);
        await testOrderComment(beginCell().storeUint(0, 32)
                                          .storeSlice(joinedStr.beginParse()).endCell(), 0);
        // Tricky comment
        await testOrderComment(beginCell().storeUint(0, 32)
                                          .storeStringTail("approve").storeRef(
                                              beginCell().storeStringTail(" not given").endCell()
                                          ).endCell(), Errors.order.unknown_op)
        // Tricky positive case
        // Empty refs in between comment symbols shouldn't be a problem
        await testOrderComment(beginCell().storeUint(0, 32)
                                          .storeStringTail("ap")
                                          .storeRef(beginCell()
                                                    .storeRef(
                                                        beginCell()
                                                        .storeStringRefTail("prove").endCell()
                                                    ).endCell())
                                           .endCell(), 0)

        await testOrderComment(beginCell().storeUint(0, 32).storeStringTail("approve not given")
                                                           .endCell(), Errors.order.unknown_op);
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

        const rndSigner  = signers[signerIdx];
        const notSigner  = differentAddress(signers[signerIdx].address);
        const msgVal     = toNano('0.1');
        // Query id match is important in that case
        const rndQueryId = BigInt(getRandomInt(1000, 2000));

        let dataBefore = await getContractData(orderContract.address);

        // Testing not valid signer address, but valid signer index
        let res = await orderContract.sendApprove(blockchain.sender(notSigner), signerIdx, msgVal, rndQueryId);
        expect(res.transactions).toHaveTransaction({
            on: orderContract.address,
            from: notSigner,
            op: Op.order.approve,
            success: false,
            aborted: true,
            exitCode: Errors.order.unauthorized_sign
        });

        // testApprove(res.transactions, notSigner, orderContract.address, Errors.order.unauthorized_sign);

        expect(await getContractData(orderContract.address)).toEqualCell(dataBefore);

        // Now let's pick valid signer address but index from another valid signer

        signerIdx = (signerIdx + 1) % signers.length;

        res = await orderContract.sendApprove(rndSigner.getSender(), signerIdx, msgVal, rndQueryId);

        expect(res.transactions).toHaveTransaction({
            on: orderContract.address,
            from: rndSigner.address,
            op: Op.order.approve,
            success: false,
            aborted: true,
            exitCode: Errors.order.unauthorized_sign
        });

        // testApprove(res.transactions, rndSigner.address, orderContract.address, Errors.order.unauthorized_sign);
        expect(await getContractData(orderContract.address)).toEqualCell(dataBefore);

        // Just to be extra sure let's pick totally invalid index
        res = await orderContract.sendApprove(rndSigner.getSender(), signers.length + 100, msgVal, rndQueryId);
        expect(res.transactions).toHaveTransaction({
            on: orderContract.address,
            from: rndSigner.address,
            op: Op.order.approve,
            success: false,
            aborted: true,
            exitCode: Errors.order.unauthorized_sign
        });
        expect(await getContractData(orderContract.address)).toEqualCell(dataBefore);
    });
    it('should reject approval if already approved', async () => {
        const signersNum = signers.length;
        const msgVal     = toNano('0.1');
        const queryId    = BigInt(getRandomInt(1000, 2000));
        // Pick random starting point
        let   signerIdx  = getRandomInt(0, signersNum - 1);
        for (let i = 0; i < 3; i++) {
            let signer     = signers[signerIdx];
            let dataBefore = await orderContract.getOrderData();
            let res = await orderContract.sendApprove(signer.getSender(), signerIdx, msgVal, queryId);
            testApprove(res.transactions, signer.address, orderContract.address, 0);
            let dataAfter  = await orderContract.getOrderData();

            expect(dataAfter.inited).toBe(true);
            expect(dataAfter.approvals_num).toEqual(dataBefore.approvals_num! + 1);
            expect(dataAfter._approvals).toBeGreaterThan(dataBefore._approvals!);
            expect(dataAfter.approvals[signerIdx]).toBe(true);

            dataBefore = dataAfter;

            // Repeat
            res = await orderContract.sendApprove(signer.getSender(), signerIdx, msgVal, queryId);

            testApprove(res.transactions, signer.address, orderContract.address, Errors.order.already_approved);

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
        const msgVal     = toNano('0.1');
        const queryId    = BigInt(getRandomInt(1000, 2000));
        for (let i = 0; i < threshold - 1; i++) {
            const res = await orderContract.sendApprove(signers[i].getSender(), i, msgVal, queryId);
            testApprove(res.transactions, signers[i].address, orderContract.address, 0);
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
        const res = await orderContract.sendApprove(lastSigner.getSender(), signerIdx, msgValue, queryId);

        testApprove(res.transactions, lastSigner.address, orderContract.address, Errors.order.expired);
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
            testApprove(res.transactions, signers[i].address, orderContract.address, 0);
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

        testApprove(res.transactions, lateSigner.address, orderContract.address, Errors.order.already_executed);

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
            testApprove(res.transactions, jumboSigners[i].address, jumboOrder.address, 0);

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
