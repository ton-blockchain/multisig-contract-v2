import {compile, NetworkProvider} from '@ton/blueprint';
import {promptUserFriendlyAddress} from '../wrappers/ui-utils';
import {checkMultisig} from "./MultisigChecker";

export async function run(provider: NetworkProvider) {
    const isTestnet = provider.network() !== 'mainnet';

    const ui = provider.ui();

    ui.write('Checking a multisig..');
    const multisigCode = await compile('Multisig');

    const multisigAddress = await promptUserFriendlyAddress(`Enter multisig address`, ui, isTestnet);

    try {
        await checkMultisig(multisigAddress, multisigCode, provider, ui, isTestnet, false);
    } catch (e: any) {
        ui.write(e.message);
        return;
    }
}