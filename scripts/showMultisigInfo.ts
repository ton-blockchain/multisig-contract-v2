import {compile, NetworkProvider} from '@ton/blueprint';
import {addressToString, promptUserFriendlyAddress, sendToIndex} from '../wrappers/ui-utils';
import {Address, Cell} from "@ton/core";
import {endParse} from "../wrappers/Multisig";
import {checkMultisig} from "./MultisigChecker";

const parseNewOrderInitStateBody = (cell: Cell) => {
    const slice = cell.beginParse();
    const multisigAddress = slice.loadAddress();
    const orderId = slice.loadUintBig(256);
    endParse(slice);
    return {
        multisigAddress,
        orderId
    }
}

const parseNewOrderInitState = (cell: Cell) => {
    const slice = cell.beginParse();
    if (slice.loadUint(2) !== 0) throw new Error('invalid init state prefix');
    const code = slice.loadMaybeRef()!;
    const body = slice.loadMaybeRef()!;
    if (slice.loadBoolean()) throw new Error('invalid init state empty libraries');
    endParse(slice);
    return {
        code,
        body: parseNewOrderInitStateBody(body)
    }
}

/**
 * @param outMsg - out msg from toncenter v3
 */
const parseNewOrderOutMsg = (outMsg: any) => {
    const orderAddress = Address.parse(outMsg.destination);
    const initState = Cell.fromBase64(outMsg.init_state.body);
    const parsed = parseNewOrderInitState(initState)

    return {
        orderAddress,
        orderId: parsed.body.orderId
    }
}

export async function run(provider: NetworkProvider) {
    const isTestnet = provider.network() !== 'mainnet';

    const ui = provider.ui();

    ui.write('Checking a multisig..');
    const multisigCode = await compile('Multisig');

    // EQBo6F4lFhRC1eXxTY77-ll4UKLmzCg34JbScMOyh9vUlaRv
    const multisigAddress = await promptUserFriendlyAddress(`Enter multisig address`, ui, isTestnet);

    try {
        const {multisigContract} = await checkMultisig(multisigAddress, multisigCode, provider, ui, isTestnet, false);

        ui.write('Last orders:')

        const result = await sendToIndex('transactions', {account: addressToString(multisigAddress)}, provider);

        for (const tx of result.transactions) {
            if (!tx.in_msg.message_content) continue;
            if (!tx.in_msg.message_content.body) continue;

            const inBody = Cell.fromBase64(tx.in_msg.message_content.body);
            const inBodySlice = inBody.beginParse();
            if (inBodySlice.remainingBits < 32) {
                continue;
            }
            const op = inBodySlice.loadUint(32);

            if (op === 0x75097f5d) { // execute
                try {
                    const queryId = inBodySlice.loadUintBig(64);
                    const orderId = inBodySlice.loadUintBig(256);
                    const orderAddress = Address.parse(tx.in_msg.source);
                    const orderAddress2 = await multisigContract.getOrderAddress(orderId)
                    if (!orderAddress.equals(orderAddress2)) {
                        throw new Error('fake order');
                    }
                    ui.write('Order executed ' + orderId + ' ' + addressToString({
                        address: orderAddress,
                        isBounceable: true,
                        isTestOnly: isTestnet
                    }));
                } catch (e: any) {
                    ui.write('Invalid execute order: ' + e.message);
                }

            } else if (op === 0xf718510f) { // new_order
                try {
                    if (tx.out_msgs.length !== 1) throw new Error('invalid out messages');
                    const outMsg = tx.out_msgs[0];
                    const {orderAddress, orderId} = parseNewOrderOutMsg(outMsg);
                    const orderAddress2 = await multisigContract.getOrderAddress(orderId)
                    if (!orderAddress.equals(orderAddress2)) {
                        throw new Error('fake order');
                    }
                    ui.write('New order ' + orderId + ' ' + addressToString({
                        address: orderAddress,
                        isBounceable: true,
                        isTestOnly: isTestnet
                    }));
                } catch (e: any) {
                    ui.write('Invalid new order: ' + e.message);
                }
            }
        }

    } catch (e: any) {
        ui.write(e.message);
        return;
    }
}