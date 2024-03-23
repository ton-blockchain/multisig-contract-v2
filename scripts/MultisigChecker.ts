import {addressToString, assert, base64toCell, formatAddressAndUrl, sendToIndex} from "../wrappers/ui-utils";
import {Address, Cell, fromNano} from "@ton/core";
import {Multisig, parseMultisigData} from "../wrappers/Multisig";
import {NetworkProvider, UIProvider} from "@ton/blueprint";

export const checkMultisig = async (
    multisigAddress: {
        isBounceable: boolean,
        isTestOnly: boolean,
        address: Address
    },
    multisigCode: Cell,
    provider: NetworkProvider,
    ui: UIProvider,
    isTestnet: boolean,
    silent: boolean
) => {

    const write = (message: string) => {
        if (!silent) {
            ui.write(message);
        }
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
        assert(parsedData.nextOderSeqno === BigInt(0), 'invalid nextOrderSeqno for allowArbitraryOrderSeqno', ui);
    }

    const signers = parsedData.signers;
    const proposers = parsedData.proposers;

    // Get-methods

    const multisigContract = provider.open(Multisig.createFromAddress(multisigAddress.address));
    const getData = await multisigContract.getMultisigData();

    if (parsedData.allowArbitraryOrderSeqno) {
        assert(getData.nextOrderSeqno === BigInt(-1), "nextOderSeqno doesn't match", ui);
    } else {
        assert(getData.nextOrderSeqno === parsedData.nextOderSeqno, "nextOderSeqno doesn't match", ui);
    }
    assert(getData.threshold === BigInt(parsedData.threshold), "threshold doesn't match", ui);
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

    write("----------------------------------");
    write("Multisig");
    write(`${signers.length} signers:`);
    for (let i = 0; i < signers.length; i++) {
        const signer = signers[i];
        const addressString = await formatAddressAndUrl(signer, provider, isTestnet)
        write(`#${i} - ${addressString}`);
    }
    write(`Quorum: ${parsedData.threshold} of ${signers.length}`);
    write(proposers.length > 0 ? `${proposers.length} proposers:` : 'No proposers');
    for (let i = 0; i < proposers.length; i++) {
        const proposer = proposers[i];
        const addressString = await formatAddressAndUrl(proposer, provider, isTestnet)
        write(`#${i} - ${addressString}`);
    }
    write((parsedData.allowArbitraryOrderSeqno ? 'Arbitrary' : 'Sequential') + ' order IDs');
    if (!parsedData.allowArbitraryOrderSeqno) {
        write('Next order seqno: ' + parsedData.nextOderSeqno);
    }

    return {
        multisigContract,
        signers,
        proposers,
        threshold: parsedData.threshold,
        allowArbitraryOrderSeqno: parsedData.allowArbitraryOrderSeqno
    }

}