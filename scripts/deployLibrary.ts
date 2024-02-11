import {toNano} from '@ton/core';
import {compile, NetworkProvider} from '@ton/blueprint';
import {Librarian} from "../wrappers/Librarian";

export async function run(provider: NetworkProvider) {
    const order_code_raw = await compile('Order');

    // deploy lib

    const librarian_code = await compile('Librarian');
    const librarian = provider.open(Librarian.createFromConfig({code: order_code_raw}, librarian_code));
    await librarian.sendDeploy(provider.sender(), toNano("10"));
}
