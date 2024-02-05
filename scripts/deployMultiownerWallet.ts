import { toNano, Address, beginCell } from 'ton-core';
import { Multisig } from '../wrappers/Multisig';
import { Order } from '../wrappers/Order';
import { compile, NetworkProvider, sleep } from '@ton/blueprint';
import { Librarian } from '../wrappers/Librarian';


const waitForTransaction = async (provider:NetworkProvider, address:Address,
                                  action:string = "transaction",
                                  curTxLt:string | null = null,
                                  maxRetry:number = 15,
                                  interval:number=1000) => {
    let done  = false;
    let count = 0;
    const ui  = provider.ui();
    let blockNum = (await provider.api().getLastBlock()).last.seqno;
    if(curTxLt == null) {
        let initialState = await provider.api().getAccount(blockNum, address);
        let lt = initialState?.account?.last?.lt;
        curTxLt = lt ? lt : null;
    }
    do {
        ui.write(`Awaiting ${action} completion (${++count}/${maxRetry})`);
        await sleep(interval);
        let newBlockNum = (await provider.api().getLastBlock()).last.seqno;
        if (blockNum == newBlockNum) {
            continue;
        }
        blockNum = newBlockNum;
        const curState = await provider.api().getAccount(blockNum, address);
        if(curState?.account?.last !== null){
            done = curState?.account?.last?.lt !== curTxLt;
        }
    } while(!done && count < maxRetry);
    return done;
}

export async function run(provider: NetworkProvider) {
    const multisig_code = await compile('Multisig');
    const order_code_raw = await compile('Order');

    const librarian_code = await compile('Librarian');
    const librarian = provider.open(Librarian.createFromConfig({code:order_code_raw}, librarian_code));
    await librarian.sendDeploy(provider.sender(), toNano("1000"));
    await waitForTransaction(provider, librarian.address, "Librarian deploy");

    /*const multiownerWallet = provider.open(Multisig.createFromConfig({}, multisig_code));

    await multiownerWallet.sendDeploy(provider.sender(), toNano('0.05'));

    await provider.waitForDeploy(multiownerWallet.address);
    */
    // run methods on `multiownerWallet`
}
