import {fromNano} from '@ton/core';
import {Multisig, parseMultisigData} from '../wrappers/Multisig';
import {compile, NetworkProvider} from '@ton/blueprint';
import {
    addressToString,
    assert,
    base64toCell,
    formatAddressAndUrl,
    promptUserFriendlyAddress,
    sendToIndex
} from '../wrappers/ui-utils';

export async function run(provider: NetworkProvider) {
    const isTestnet = provider.network() !== 'mainnet';

    const ui = provider.ui();

    ui.write('Checking a multisig..');
    const multisigCode = await compile('Multisig');

    const multisigAddress = await promptUserFriendlyAddress(`Enter multisig address`, ui, isTestnet);

    const write = (message: string) => {
        ui.write(message);
    }

    // Account State and Data

    const result = await sendToIndex('account', {address: addressToString(multisigAddress)}, provider);
    write('Contract status: ' + result.status);

    assert(result.status === 'active', "Contract not active", ui);

    if (base64toCell(result.code).equals(multisigCode)) {
        write('The contract code matches the multisig code from this repository');
    } else {
        throw new Error('The contract code DOES NOT match the multisig code from this repository');
    }

    write('Toncoin balance on jetton-minter: ' + fromNano(result.balance) + ' TON');

    const data = base64toCell(result.data);
    const parsedData = parseMultisigData(data);

    if (parsedData.signers.length !== parsedData.signersCount) {
        throw new Error('invalud signersCount');
    }

    if (parsedData.allowArbitraryOrderSeqno) {
        console.assert(parsedData.nextOderSeqno === BigInt(0), 'invalid nextOrderSeqno for allowArbitraryOrderSeqno');
    }

    const signers = parsedData.signers;
    const proposers = parsedData.proposers;

    // Get-methods

    const multisigContract = provider.open(Multisig.createFromAddress(multisigAddress.address));
    const getData = await multisigContract.getMultisigData();

    if (parsedData.allowArbitraryOrderSeqno) {
        console.assert(getData.nextOrderSeqno === BigInt(-1), "nextOderSeqno doesn't match");
    } else {
        console.assert(getData.nextOrderSeqno === parsedData.nextOderSeqno, "nextOderSeqno doesn't match");
    }
    console.assert(getData.threshold === BigInt(parsedData.threshold), "threshold doesn't match");
    // todo: check signers
    // todo: check proposers


    const multisigAddress2 = Multisig.createFromConfig({
        threshold: parsedData.threshold,
        signers: parsedData.signers,
        proposers: parsedData.proposers,
        allowArbitrarySeqno: parsedData.allowArbitraryOrderSeqno
    }, multisigCode)

    if (multisigAddress2.address.equals(multisigAddress.address)) {
        write('StateInit matches');
    }

    // Print

    ui.write("----------------------------------");
    ui.write("Multisig");
    ui.write(`${signers.length} signers:`);
    for (let i = 0; i < signers.length; i++) {
        const signer = signers[i];
        const addressString = await formatAddressAndUrl(signer, provider, isTestnet)
        ui.write(`#${i} - ${addressString}`);
    }
    ui.write(`Quorum: ${parsedData.threshold} of ${signers.length}`);
    ui.write(proposers.length > 0 ? `${proposers.length} proposers:` : 'No proposers');
    for (let i = 0; i < proposers.length; i++) {
        const proposer = proposers[i];
        const addressString = await formatAddressAndUrl(proposer, provider, isTestnet)
        ui.write(`#${i} - ${addressString}`);
    }
    ui.write((parsedData.allowArbitraryOrderSeqno ? 'Arbitrary' : 'Sequential') + ' order IDs');
    if (!parsedData.allowArbitraryOrderSeqno) {
        ui.write('Next order seqno: ' + parsedData.nextOderSeqno);
    }
}