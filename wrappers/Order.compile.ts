import { CompilerConfig } from '@ton/blueprint';
import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';

export const compile: CompilerConfig = {
    lang: 'func',
    postCompileHook: async (code) => {
        const auto = path.join(__dirname, '..', 'contracts', 'auto');
        await mkdir(auto, { recursive: true });
        await writeFile(path.join(auto, 'order_code.func'), `cell order_code() asm "<b 2 8 u, 0x${code.hash().toString('hex')} 256 u, b>spec PUSHREF";`);
    },
    targets: ['contracts/order.func'],
};
