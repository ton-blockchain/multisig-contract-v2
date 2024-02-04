import { Address, beginCell,  Cell, Builder, BitString, Dictionary, Contract, contractAddress, ContractProvider, Sender, SendMode, toNano } from '@ton/core';
import { Op, Params } from "./Constants";

export type OrderConfig = {
    multisig: Address,
    orderSeqno: number
};

function arrayToCell(arr: Array<Address>): Dictionary<number, Address> {
    let dict = Dictionary.empty(Dictionary.Keys.Uint(8), Dictionary.Values.Address());
    for (let i = 0; i < arr.length; i++) {
        dict.set(i, arr[i]);
    }
    return dict;
}

function cellToArray(addrDict: Cell | null) : Array<Address>  {
    let resArr: Array<Address> = [];
    if(addrDict !== null) {
        const dict = Dictionary.loadDirect(Dictionary.Keys.Uint(8), Dictionary.Values.Address(), addrDict);
        resArr = dict.values();
    }
    return resArr;
}

export function orderConfigToCell(config: OrderConfig): Cell {
    return beginCell()
                .storeAddress(config.multisig)
                .storeUint(config.orderSeqno, Params.bitsize.orderSeqno)
           .endCell();
}

export class Order implements Contract {
    constructor(readonly address: Address,
                readonly init?: { code: Cell, data: Cell },
                readonly configuration?: OrderConfig) {}
    
    static createFromAddress(address: Address) {
        return new Order(address);
    }

    static createFromConfig(config: OrderConfig, code: Cell, workchain = 0) {
        const data = orderConfigToCell(config);
        const init = { code, data };

        return new Order(contractAddress(workchain, init), init, config);
    }

    static initMessage (signers: Array<Address>,
                        expiration_date: number,
                        order: Cell,
                        threshold: number = 1,
                        approve_on_init: boolean = false,
                        signer_idx: number = 0,
                        query_id : number | bigint = 0)   {

       const msgBody = beginCell()
                .storeUint(Op.order.init, Params.bitsize.op)
                .storeUint(query_id, Params.bitsize.queryId)
                .storeUint(threshold, Params.bitsize.signerIndex)
                .storeRef(beginCell().storeDictDirect(arrayToCell(signers)))
                .storeUint(expiration_date, Params.bitsize.time)
                .storeRef(order)
                .storeBit(approve_on_init);

       if(approve_on_init) {
           msgBody.storeUint(signer_idx, Params.bitsize.signerIndex);
       }

       return msgBody.endCell();
    }
    async sendDeploy(provider: ContractProvider,
                     via: Sender,
                     value: bigint,
                     signers: Array<Address>,
                     expiration_date: number,
                     order: Cell,
                     threshold: number = 1,
                     approve_on_init: boolean = false,
                     signer_idx: number = 0,
                     query_id : number | bigint = 0) {


       await provider.internal(via, {
           value,
           sendMode: SendMode.PAY_GAS_SEPARATELY,
           body: Order.initMessage(signers, expiration_date, order, threshold, approve_on_init, signer_idx, query_id)
       });
    }

    async sendApprove(provider: ContractProvider, via: Sender, signer_idx: number, value: bigint = toNano('0.1'), query_id: number | bigint = 0) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                    .storeUint(Op.order.approve, Params.bitsize.op)
                    .storeUint(query_id, Params.bitsize.queryId)
                    .storeUint(signer_idx, Params.bitsize.signerIndex)
                  .endCell()
        });
    }


    async getOrderData(provider: ContractProvider) {
       /*
       (slice multisig, int order_seqno, int threshold,
                     int executed?, cell signers,
                     int approvals, int approvals_num, int expiration_date,
                     cell order)
       */
       const { stack } = await provider.get("get_order_data", []);
       const multisig = stack.readAddress();
       const order_seqno = stack.readBigNumber();
       const threshold = stack.readNumberOpt();
       const executed = stack.readBooleanOpt();
       const signers = cellToArray(stack.readCellOpt());
       const approvals = stack.readBigNumberOpt();
       const approvals_num = stack.readNumberOpt();
       const expiration_date = stack.readBigNumberOpt();
       const order = stack.readCellOpt();
       let approvalsArray: Array<boolean>;
       if(approvals !== null) {
        approvalsArray = Array(256);
        for(let i = 0; i < 256; i++) {
            approvalsArray[i] = Boolean((1n << BigInt(i)) & approvals);
        }
       }
       else {
           approvalsArray = [];
       }
       return {
              inited: threshold !== null, multisig, order_seqno, threshold, executed, signers,
              approvals: approvalsArray, approvals_num: approvals_num, _approvals : approvals, expiration_date, order
       };
    }
}
