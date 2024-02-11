import {Address, toNano} from '@ton/core';
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

    await multiownerWallet.sendDeploy(provider.sender(), toNano('0.05'));
    await provider.waitForDeploy(multiownerWallet.address);

}
