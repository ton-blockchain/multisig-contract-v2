import {beginCell, SendMode, toNano} from '@ton/core';
import {Multisig} from '../wrappers/Multisig';
import {compile, NetworkProvider} from '@ton/blueprint';
import {promptBigInt, promptCell, promptToncoin, promptUserFriendlyAddress} from "../wrappers/ui-utils";
import {checkMultisig} from "./MultisigChecker";

export async function run(provider: NetworkProvider) {
    if (!provider.sender().address) {
        throw new Error('no sender address');
    }

    const isTestnet = provider.network() !== 'mainnet';

    const ui = provider.ui();

    const multisigCode = await compile('Multisig');

    const multisigAddress = await promptUserFriendlyAddress('Enter multisig address', ui, isTestnet);

    try {
        const {
            multisigContract,
            signers,
            proposers
        } = await checkMultisig(multisigAddress, multisigCode, provider, ui, isTestnet, false);

        const myProposerIndex = proposers.findIndex(address => address.equals(provider.sender().address!));
        const mySignerIndex = signers.findIndex(address => address.equals(provider.sender().address!));

        if (myProposerIndex === -1 && mySignerIndex === -1) {
            ui.write('Error: you are not proposer and not signer');
            return;
        }

        const isSigner = mySignerIndex > -1;

        const orderId = await promptBigInt("Please enter orderId", ui);

        const destinationAddress = await promptUserFriendlyAddress("Enter destination", ui, isTestnet);
        const tonAmount = await promptToncoin("Enter TON amount to send from multisig to destination", ui);
        const payloadCell = await promptCell("Enter payload in base64 cell to send from multisig to destination (empty if no payload)", ui);

        const expireAt = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30; // 1 month

        await multisigContract.sendNewOrderStrict(
            provider.sender(),
            Multisig.packOrder([
                {
                    type: 'transfer',
                    sendMode: SendMode.PAY_GAS_SEPARATELY,
                    message: {
                        info: {
                            type: 'internal',
                            ihrDisabled: false,
                            bounce: true,
                            bounced: false,
                            dest: destinationAddress.address,
                            value: {
                                coins: tonAmount
                            },
                            ihrFee: 0n,
                            forwardFee: 0n,
                            createdLt: 0n,
                            createdAt: 0
                        },
                        body: payloadCell || beginCell().endCell()
                    }
                }
            ]),
            expireAt,
            toNano('1'), // 1 TON
            isSigner ? mySignerIndex : myProposerIndex, // index
            isSigner, // not signer
            orderId // order_seqno
        );


    } catch (e: any) {
        ui.write(e.message);
        return;
    }
}
