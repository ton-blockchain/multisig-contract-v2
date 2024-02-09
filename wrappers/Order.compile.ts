import { CompilerConfig } from '@ton/blueprint';
import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';

export const compile: CompilerConfig = {
    lang: 'func',
    postCompileHook: async (code) => {
        const auto = path.join(__dirname, '..', 'contracts', 'auto');
        await mkdir(auto, { recursive: true });
        await writeFile(path.join(auto, 'order_code.func'), `
;; https://docs.ton.org/tvm.pdf, page 30
;; Library reference cell — Always has level 0, and contains 8+256 data bits, including its 8-bit type integer 2 
;; and the representation hash Hash(c) of the library cell being referred to. When loaded, a library
;; reference cell may be transparently replaced by the cell it refers to, if found in the current library context.

cell order_code() asm "<b 2 8 u, 0x${code.hash().toString('hex')} 256 u, b>spec PUSHREF";`);
    },
    targets: ['contracts/order.func'],
};
