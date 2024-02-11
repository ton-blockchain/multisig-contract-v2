import {Address, beginCell, toNano} from '@ton/core';
import {Multisig} from '../wrappers/Multisig';
import {compile, NetworkProvider} from '@ton/blueprint';

export async function run(provider: NetworkProvider) {
    const multisig_code = await compile('Multisig');

    // deploy multisig

    const multiownerWallet = provider.open(Multisig.createFromConfig({
        threshold: 2,
        signers: [Address.parse('UQBONmT67oFPvbbByzbXK6xS0V4YbBHs1mT-Gz8afP2AHdyt'), Address.parse('0QAR0lJjOVUzyT4QBKg50k216RBqvpvEPlq2_xGtdMkgFgcY'), Address.parse('UQAGkOdcs7i0OomLkySkVdiLbzriH4ptQAgYWqHRVK2vXO4z')],
        proposers: [Address.parse('0QAR0lJjOVUzyT4QBKg50k216RBqvpvEPlq2_xGtdMkgFgcY')],
        allowArbitrarySeqno: true
    }, multisig_code));

    // create new order

    const masterMsg = beginCell()
        .storeUint(0x178d4519, 32) // internal_transfer
        .storeUint(0, 64) // query_id
        .storeCoins(5000000000n) // jetton amount
        .storeAddress(Address.parse('0QAR0lJjOVUzyT4QBKg50k216RBqvpvEPlq2_xGtdMkgFgcY')) // from address (will be ignored)
        .storeAddress(Address.parse('0QAR0lJjOVUzyT4QBKg50k216RBqvpvEPlq2_xGtdMkgFgcY')) // response address
        .storeCoins(0) // forward payload
        .storeBit(false) // no forward
        .endCell();

    await multiownerWallet.sendNewOrder(provider.sender(), [{
        type: 'transfer',
        sendMode: 3,
        message: {
            info: {
                type: 'internal',
                ihrDisabled: false,
                bounce: true,
                bounced: false,
                dest: Address.parse('EQAZym3GBvem-frRGy1gUIaO-IBb5ByJPrm8aXtN7a_6PBW6'), // jetton-minter
                value: {
                    coins: toNano('1') // ton amount
                },
                ihrFee: 0n,
                forwardFee: 0n,
                createdLt: 0n,
                createdAt: 0
            },
            body: beginCell()
                .storeUint(0x642b7d07, 32) // mint
                .storeUint(0, 64) // query_id
                .storeAddress(Address.parse('0QAR0lJjOVUzyT4QBKg50k216RBqvpvEPlq2_xGtdMkgFgcY')) // mint to this regular wallet
                .storeCoins(toNano('0.5')) // ton amount
                .storeRef(masterMsg)
                .endCell()
        }
    }],
        Math.floor(Date.now() / 1000 + 3600), // expired in hour
        toNano('1'), // ton amount
        0, // index
        false, // not signer
        123n // order_seqno
    );

}
